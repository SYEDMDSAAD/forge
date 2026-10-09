import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { createClient, fallbackParams, modelParams } from "../llm.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import type { ForgeEvent, TestReport, ToolSpec } from "./types.js";
import { validateSpec } from "./validate.js";

type Msg = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const SYSTEM = `You are the Smith inside Forge, a voice assistant (Alexa+) that builds its own new capabilities on demand.

A user asked the assistant for something it cannot do yet. Your job: build ONE small, reliable, reusable tool that does it, prove it works, and submit it.

## Runtime contract
The tool is a single ES module, run in a locked-down sandbox:

    export default async function run(input) {
      // ...
      return { speech: "One or two short sentences Alexa will say out loud.", data: { /* structured details for a screen card */ } };
    }

- Available: global \`fetch\`, URL, URLSearchParams, JSON, Intl, Date, Math, TextEncoder/Decoder, structuredClone, AbortController.
- NOT available: import/require, process, Node built-ins, the filesystem, eval, new Function, npm packages.
- Every host you fetch must be listed in allowed_domains (subdomains of a listed domain are allowed). Fetching anything else throws.
- Each call has a ${config.toolTimeoutMs / 1000}s time limit. No API keys or logins exist; use keyless public sources (open APIs, public JSON/RSS/HTML pages).
- \`speech\` is spoken aloud: natural, specific, no markdown, no URLs, round numbers sensibly. Handle "nothing found" gracefully with a helpful sentence instead of throwing.
- Make it general and reusable: take parameters (city, station, query, ...) rather than hard-coding the user's example, but use the user's example as the default in tests.

## Known keyless sources (verified starting points, not an exhaustive list)
- Weather / air quality: api.open-meteo.com, geocoding-api.open-meteo.com (city -> lat/lon), air-quality-api.open-meteo.com
- Places / geocoding: nominatim.openstreetmap.org, overpass-api.de
- Space: api.wheretheiss.at, ll.thespacedevs.com
- Knowledge: en.wikipedia.org/api/rest_v1, api.dictionaryapi.dev
- Money / markets: api.frankfurter.app (FX), api.coingecko.com (crypto)
- News / feeds: hacker-news.firebaseio.com, any public RSS feed
If a source returns 401/403 or asks for a key, switch to a keyless one; don't give up because the first source needed a key.

## Process
1. If you are unsure of an endpoint or response shape, call http_probe to look at real responses before writing code. Prefer stable, documented sources.
2. Call submit_tool with the code and 1-3 tests. Tests run the real tool against the live internet; each test's \`assert\` is a JS expression over \`result\` and \`input\` and should check structure and sanity (types, non-empty, plausible ranges), not exact live values.
3. If tests fail you will get the errors; fix the code and resubmit. You have ${config.maxSubmissions} submissions.
4. If the request is impossible within this contract (needs a login, payment, private data, or a physical action) or unsafe, call give_up with a short explanation the assistant can say to the user.

Tool names are snake_case verbs like get_train_status or find_nearby_pharmacies. The description must tell a future assistant exactly when to use the tool.`;

const PROBE_TOOL: Anthropic.Beta.BetaTool = {
  name: "http_probe",
  description: "GET a public URL from the sandbox and see its status, content type and the first 6000 characters of the body. Use this to discover endpoints and response shapes before writing code.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL" } },
    required: ["url"],
    additionalProperties: false,
  },
};

const SUBMIT_TOOL: Anthropic.Beta.BetaTool = {
  name: "submit_tool",
  description: "Submit the finished tool. Forge validates it, runs the tests in the sandbox against the live internet, and returns the results.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case tool name" },
      title: { type: "string", description: "Short human title, e.g. 'Train Delay Checker'" },
      description: { type: "string", description: "What it does and exactly when an assistant should call it" },
      input_schema_json: { type: "string", description: "JSON Schema (as a JSON string) for the input object, with descriptions on every property" },
      code: { type: "string", description: "Full ES module source" },
      allowed_domains: { type: "array", items: { type: "string" }, description: "Every hostname the code fetches, e.g. api.example.com" },
      tests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            input_json: { type: "string", description: "Input object as a JSON string" },
            assert: { type: "string", description: "JS expression over result and input that must be truthy" },
          },
          required: ["name", "input_json", "assert"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "title", "description", "input_schema_json", "code", "allowed_domains", "tests"],
    additionalProperties: false,
  },
};

const GIVE_UP_TOOL: Anthropic.Beta.BetaTool = {
  name: "give_up",
  description: "Stop: the request can't be built safely within the runtime contract.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "One or two sentences the assistant can say to the user" } },
    required: ["reason"],
    additionalProperties: false,
  },
};

export class ForgeFailed extends Error {}

export interface SmithResult {
  spec: ToolSpec;
  report: TestReport;
  attempts: number;
}

interface SubmitInput {
  name: string;
  title: string;
  description: string;
  input_schema_json: string;
  code: string;
  allowed_domains: string[];
  tests: { name: string; input_json: string; assert: string }[];
}

/** Hostname from whatever the model wrote: "https://api.x.com/v1" -> "api.x.com". */
function toHost(d: string): string {
  const t = d.trim().toLowerCase();
  try {
    return new URL(t.includes("://") ? t : `https://${t}`).hostname;
  } catch {
    return t;
  }
}

/** Parse a submit_tool call, forgiving harmless shape slips. Throws with a message the model can act on. */
export function parseSubmission(input: Partial<SubmitInput>): ToolSpec {
  const missing = SUBMIT_TOOL.input_schema.required!.filter((k) => input[k as keyof SubmitInput] === undefined);
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
  let inputSchema = JSON.parse(input.input_schema_json!);
  // A bare property map ({ city: {...} }) is unambiguous; wrap it.
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type === undefined && inputSchema.properties === undefined) {
    inputSchema = { type: "object", properties: inputSchema };
  }
  return {
    name: input.name!,
    title: input.title!,
    description: input.description!,
    inputSchema,
    code: input.code!,
    allowedDomains: [...new Set(input.allowed_domains!.map(toHost))],
    tests: input.tests!.map((t, i) => ({ name: t.name || `test_${i + 1}`, input: JSON.parse(t.input_json), assert: t.assert })),
  };
}

export async function testSpec(spec: ToolSpec): Promise<TestReport> {
  const out = await runInSandbox({ mode: "test", code: spec.code, tests: spec.tests, allowedDomains: spec.allowedDomains });
  if (!out.ok) {
    return { passed: false, results: [{ name: "load", passed: false, error: out.error, durationMs: 0 }], fetched: out.fetched, logs: out.logs };
  }
  const results = out.results as TestReport["results"];
  return { passed: results.every((r) => r.passed), results, fetched: out.fetched, logs: out.logs };
}

function describeReport(report: TestReport): string {
  const lines = report.results.map((r) =>
    r.passed
      ? `PASS ${r.name} (${r.durationMs}ms) -> ${JSON.stringify(r.result).slice(0, 400)}`
      : `FAIL ${r.name}: ${r.error}${r.result ? ` | result: ${JSON.stringify(r.result).slice(0, 400)}` : ""}`,
  );
  if (report.logs) lines.push(`console output:\n${report.logs.slice(0, 1500)}`);
  if (report.fetched.length) lines.push(`fetched: ${report.fetched.slice(0, 10).join(", ")}`);
  return lines.join("\n");
}

/**
 * Agent loop: Claude researches (probe / web search), writes the tool, and
 * iterates against real sandboxed test runs until the tests pass.
 */
export async function forgeTool(request: string, onEvent: (e: ForgeEvent) => void = () => {}): Promise<SmithResult> {
  const client = createClient();
  const tools: Anthropic.Beta.BetaToolUnion[] = [PROBE_TOOL, SUBMIT_TOOL, GIVE_UP_TOOL];
  if (config.provider === "anthropic") {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 4 });
  }

  const messages: Msg[] = [{ role: "user", content: `The user said: "${request}"\n\nBuild the capability.` }];
  let submissions = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    onEvent({ stage: "thinking", message: turn === 0 ? "Designing the capability" : "Working on it" });
    const response = await client.beta.messages
      .stream({
        model: config.model,
        ...modelParams(),
        system: SYSTEM,
        tools,
        messages,
        ...fallbackParams(),
      })
      .finalMessage();

    if (response.stop_reason === "refusal") throw new ForgeFailed("I can't build that one.");
    messages.push({ role: "assistant", content: response.content });
    if (config.debug) console.error("[debug] assistant:", JSON.stringify(response.content).slice(0, 3000));
    if (response.stop_reason === "pause_turn") continue;

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Continue: call submit_tool with your tool, or give_up." });
      continue;
    }

    const results: ToolResult[] = [];
    let done: SmithResult | undefined;

    for (const call of calls) {
      if (call.name === "give_up") {
        throw new ForgeFailed((call.input as { reason: string }).reason);
      }

      if (call.name === "http_probe") {
        const { url } = call.input as { url: string };
        onEvent({ stage: "probe", message: `Looking at ${new URL(url).hostname}` });
        const host = new URL(url).hostname;
        const out = await runInSandbox({ mode: "probe", url, allowedDomains: [host] });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(out.ok ? { status: out.status, contentType: out.contentType, bytes: out.bytes, body: out.body } : { error: out.error }),
          is_error: !out.ok,
        });
        continue;
      }

      if (call.name === "submit_tool") {
        submissions++;
        let spec: ToolSpec;
        try {
          spec = parseSubmission(call.input as Partial<SubmitInput>);
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Invalid submission (${(e as Error).message}). Resend submit_tool with every required field; input_schema_json and input_json must be JSON strings.`, is_error: true });
          continue;
        }
        onEvent({ stage: "submit", message: `Wrote ${spec.name} (attempt ${submissions})` });

        const problems = validateSpec(spec);
        if (problems.length) {
          onEvent({ stage: "repair", message: `Static check failed: ${problems[0]}` });
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Rejected before running:\n- ${problems.join("\n- ")}`, is_error: true });
        } else {
          onEvent({ stage: "test", message: `Running ${spec.tests.length} live test${spec.tests.length > 1 ? "s" : ""} in the sandbox` });
          const report = await testSpec(spec);
          if (report.passed) {
            onEvent({ stage: "ready", message: `All tests passed for ${spec.name}` });
            done = { spec, report, attempts: submissions };
            results.push({ type: "tool_result", tool_use_id: call.id, content: `All tests passed.\n${describeReport(report)}` });
          } else {
            const failed = report.results.find((r) => !r.passed);
            onEvent({ stage: "repair", message: `Test "${failed?.name}" failed, fixing` });
            results.push({ type: "tool_result", tool_use_id: call.id, content: `Tests failed:\n${describeReport(report)}`, is_error: true });
          }
        }
        if (!done && submissions >= config.maxSubmissions) {
          throw new ForgeFailed("I tried a few times but couldn't get that working reliably.");
        }
        continue;
      }

      results.push({ type: "tool_result", tool_use_id: call.id, content: `Unknown tool ${call.name}`, is_error: true });
    }

    if (done) return done;
    if (config.debug) console.error("[debug] results:", JSON.stringify(results).slice(0, 3000));
    messages.push({ role: "user", content: results });
  }

  throw new ForgeFailed("That took longer than I allow for learning something new.");
}
