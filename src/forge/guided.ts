// Guided smith for small local models (FORGE_SMITH=guided, the default with
// Ollama). Instead of one open-ended agent loop it runs short, structured
// steps: pick a verified source -> look at real responses -> fill in a code
// template -> repair from test failures. Every reply is constrained to a JSON
// schema by Ollama, so a 7B model can't wander off or send malformed calls.
import { config } from "../config.js";
import { askOllama as ask } from "../llm.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import { CATALOG, catalogById, type Source } from "./catalog.js";
import { ForgeFailed, testSpec, type SmithResult } from "./smith.js";
import type { ForgeEvent, TestReport, ToolSpec } from "./types.js";
import { fixApostrophes, syntaxError, validateSpec } from "./validate.js";

export interface Plan {
  feasible: boolean;
  reason: string;
  source: string;
  name: string;
  title: string;
  description: string;
  inputs: { name: string; type: "string" | "number"; description: string; example: string; another_example?: string; optional?: boolean }[];
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    feasible: { type: "boolean" },
    reason: { type: "string" },
    source: { type: "string", enum: [...CATALOG.map((s) => s.id), "none"] },
    name: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    inputs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["string", "number"] },
          description: { type: "string" },
          example: { type: "string" },
          another_example: { type: "string" },
        },
        required: ["name", "type", "description", "example", "another_example"],
      },
    },
  },
  required: ["feasible", "reason", "source", "name", "title", "description", "inputs"],
};

const CODE_SCHEMA = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };

const REVIEW_SCHEMA = {
  type: "object",
  properties: { natural: { type: "boolean" }, problem: { type: "string" } },
  required: ["natural", "problem"],
};

/** The model listens to its own answer once; judging a sentence is easier for it than writing one. */
async function reviewSpeech(request: string, speech: string): Promise<string | null> {
  const review = await ask<{ natural: boolean; problem: string }>(
    SYSTEM,
    `The user asked a voice assistant: "${request}"
The assistant will say exactly: "${speech}"

Is that a natural, grammatical English answer to the question, with nothing garbled, missing or repeated? Minor style is fine.
Set natural=true unless there is a clear problem. If natural=false, describe the problem in one sentence.`,
    REVIEW_SCHEMA,
  );
  return review.natural ? null : review.problem || "the sentence is not natural English";
}

// Checks every skill must pass on the example input (which is a valid request,
// so "sorry, not found" is a failure there). Kept in sync with speechProblems().
const questionOf = (request: string) => request.toLowerCase().replace(/[?.!\s]+$/, "");
// "Nothing found" or an error on a valid example means the URL or parsing is wrong.
// Placeholders and empty list items: "Unknown headline", "No title", "launched,,."
const PLACEHOLDER = "\\b(unknown|untitled|no title|n\\/a)\\b|,\\s*,|,\\s*\\.|:\\s*\\.";
const NOTHING = "\\berror\\b|\\bfailed\\b|not found|\\bno\\b[^.]{0,40}\\bfound\\b|no (data|results|information)\\b|not available|please provide|\\binvalid\\b";

export function speechAssert(request: string): string {
  return [
    "typeof result.speech === 'string' && result.speech.length >= 15",
    "!/undefined|NaN|\\[object Object\\]|\\bnull\\b/.test(result.speech)",
    "!/sorry|couldn.?t|could not|unable|not find|apolog/i.test(result.speech)",
    `!/${NOTHING}/i.test(result.speech)`,
    `!/${PLACEHOLDER}/i.test(result.speech)`,
    "!/\\?\\s*$/.test(result.speech)",
    "!/\\d\\.\\d{3,}/.test(result.speech)",
    `!result.speech.toLowerCase().includes(${JSON.stringify(questionOf(request))})`,
  ].join(" && ");
}

/** Plain-language reasons a result fails SPEECH_OK, so the model knows what to fix. */
function speechProblems(result: unknown, request: string): string[] {
  const r = (result ?? {}) as { speech?: unknown; data?: unknown };
  if (typeof r.speech !== "string") return ["run() must return an object with a speech string"];
  const p: string[] = [];
  if (r.speech.length < 15) p.push("speech is too short; say the actual answer in a full sentence");
  if (/undefined|NaN|\[object Object\]|\bnull\b/.test(r.speech)) p.push("speech contains undefined/NaN/null/[object Object]: a field name is wrong; use the exact fields from the example response");
  if (/sorry|couldn.?t|could not|unable|not find|apolog/i.test(r.speech))
    p.push("speech is an apology, but the example input is valid: the request or the parsing is wrong (check the URL and field names against the example response)");
  if (new RegExp(NOTHING, "i").test(r.speech))
    p.push("speech says nothing was found or an error happened, but the example input is valid: the request or the parsing is wrong (check the URL, the parameter format such as country codes, and field names against the example response)");
  if (new RegExp(PLACEHOLDER, "i").test(r.speech))
    p.push("speech has placeholders or empty items (Unknown, No title, ',,'): the fields are read wrongly; take them from the exact structure of the example response");
  if (/\?\s*$/.test(r.speech)) p.push("speech must end with an answer, not a question");
  if (/\d\.\d{3,}/.test(r.speech)) p.push("round the numbers in speech (Math.round, or toFixed(1) for small values)");
  if (r.speech.toLowerCase().includes(questionOf(request))) p.push("speech repeats the user's question; say only the answer");
  return p;
}

const SYSTEM = "You build small, reliable tools for a voice assistant. Reply only with JSON matching the given schema.";

function catalogMenu(): string {
  return CATALOG.map((s) => `- ${s.id}: ${s.useFor}`).join("\n");
}

function sourceDocs(src: Source): string {
  const eps = src.endpoints.map((e) => `GET ${e.url}\n  returns ${e.returns}`).join("\n");
  return `${eps}${src.notes ? `\nNotes: ${src.notes}` : ""}`;
}

function compact(body: string, max = 1400): string {
  let out = body;
  try {
    out = JSON.stringify(JSON.parse(body));
  } catch {
    // RSS: the stories, not the channel header, are what the code has to read.
    const first = body.indexOf("<item>");
    if (first > 0) out = body.slice(first);
  }
  return out.length > max ? out.slice(0, max) + " …(truncated)" : out;
}

async function samples(src: Source, onEvent: (e: ForgeEvent) => void): Promise<string> {
  const parts: string[] = [];
  for (const ep of src.endpoints) {
    const host = new URL(ep.example).hostname;
    onEvent({ stage: "probe", message: `Looking at ${host}` });
    const out = await runInSandbox({ mode: "probe", url: ep.example, allowedDomains: [host] });
    parts.push(`Example: GET ${ep.example}\nResponse ${out.ok ? `(${out.status}): ${compact(String(out.body ?? ""))}` : `failed: ${out.error}`}`);
  }
  return parts.join("\n\n");
}

const CONTRACT = `Write one JavaScript ES module:

export default async function run(input) {
  // read inputs, e.g. const { city } = input;
  // call ONLY the URLs documented above with fetch(); wrap inputs in encodeURIComponent()
  // const res = await fetch(url); if (!res.ok) return { speech: "a helpful sorry sentence" };
  // const json = await res.json();
  return { speech: "One or two short natural sentences with the real answer.", data: { /* a few key fields */ } };
}

Rules:
- No import or require. Only fetch and built-in JavaScript.
- Never throw. When something isn't found, return a helpful speech sentence instead.
- speech is spoken aloud: a complete sentence that answers with the actual values (never repeat the question). Round numbers (format big ones with toLocaleString('en-IN')). No URLs, no markdown.
- Write every string with backticks (template literals), never single quotes, so apostrophes like "don't" are safe.
- Use the exact field names shown in the example responses.`;

function toSnake(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return /^[a-z][a-z0-9_]{2,}$/.test(out) ? out : `skill_${out || "custom"}`.slice(0, 48);
}

// A currency code fixed in the code is often said as its name ("dollars").
const CURRENCY_NAMES: Record<string, string> = { usd: "dollar", inr: "rupee", eur: "euro", gbp: "pound", jpy: "yen", aed: "dirham" };
const spoken = (v: string) => [v.toLowerCase(), ...(CURRENCY_NAMES[v.toLowerCase()] ? [CURRENCY_NAMES[v.toLowerCase()]] : [])];

export function buildSpec(request: string, plan: Plan, src: Source, code: string): ToolSpec {
  const properties: Record<string, unknown> = {};
  const input: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of plan.inputs) {
    const key = toSnake(i.name);
    properties[key] = { type: i.type, description: i.description };
    if (!i.optional) required.push(key);
    if (!i.optional || i.example.trim()) input[key] = i.type === "number" ? Number(i.example) : i.example;
  }
  const tests: ToolSpec["tests"] = [{ name: "example", input, assert: speechAssert(request), ...(src.reference ? { reference: src.reference } : {}) }];
  // The same skill with different values: an answer that still names the first
  // ones (a word, a coin, a city) has them fixed in its code.
  const other: Record<string, unknown> = { ...input };
  for (const i of plan.inputs) {
    const another = i.another_example?.trim();
    if (i.type === "string" && another && another.toLowerCase() !== String(input[toSnake(i.name)] ?? "").toLowerCase()) other[toSnake(i.name)] = another;
  }
  const others = Object.values(other).map((v) => String(v).toLowerCase());
  const fixed = Object.entries(input).filter(([k, v]) => typeof v === "string" && v.trim().length >= 3 && other[k] !== v && !others.some((o) => o.includes(v.toLowerCase())));
  if (Object.keys(other).some((k) => other[k] !== input[k]))
    tests.push({
      name: "another input",
      input: other,
      assert: [speechAssert(request), ...fixed.flatMap(([, v]) => spoken(String(v))).map((w) => `!result.speech.toLowerCase().includes(${JSON.stringify(w)})`)].join(" && "),
      ...(src.reference ? { reference: src.reference } : {}),
    });
  const description = plan.description.length >= 20 ? plan.description : `${plan.description || plan.title}. Use for ${src.useFor}.`;
  return {
    name: toSnake(plan.name),
    title: plan.title || plan.name,
    description,
    inputSchema: { type: "object", properties, required },
    code,
    allowedDomains: src.domains,
    tests,
    sources: [src.name],
  };
}

function describeFailure(report: TestReport, request: string, spec: ToolSpec): string {
  return report.results
    .filter((r) => !r.passed)
    .map((r) => {
      const test = spec.tests.find((t) => t.name === r.name);
      const problems = r.result !== undefined && r.error?.startsWith("Assertion") ? speechProblems(r.result, request) : [];
      if (!problems.length && r.name === "another input" && r.error?.startsWith("Assertion")) {
        const first = Object.values(spec.tests[0].input).filter((v) => typeof v === "string");
        problems.push(`with the input ${JSON.stringify(test?.input)} the answer still mentions ${first.map((v) => JSON.stringify(v)).join(" or ")} from the first example: the code has a value fixed in it; use the input instead`);
      }
      const why = `Test with input ${JSON.stringify(test?.input ?? {})}:\n${problems.length ? problems.map((p) => `- ${p}`).join("\n") : (r.error ?? "failed")}`;
      return `${why}${r.result !== undefined ? `\nIt returned: ${JSON.stringify(r.result).slice(0, 600)}` : ""}`;
    })
    .concat(report.logs ? [`console output: ${report.logs.slice(0, 600)}`] : [])
    .join("\n");
}

/** What the live test asked and answered, and what the cross-check compared, for the build log. */
function tellResult(spec: ToolSpec, report: TestReport, source: string, onEvent: (e: ForgeEvent) => void) {
  const r = report.results[0];
  const speech = (r?.result as { speech?: string } | undefined)?.speech;
  if (speech) onEvent({ stage: "test", message: `Test ${JSON.stringify(spec.tests[0].input)} answered: "${speech.slice(0, 160)}"` });
  const r2 = report.results[1];
  const speech2 = (r2?.result as { speech?: string } | undefined)?.speech;
  if (speech2 && spec.tests[1]) onEvent({ stage: "test", message: `Second test ${JSON.stringify(spec.tests[1].input)}, to check nothing is fixed in the code, answered: "${speech2.slice(0, 120)}"` });
  const c = r?.crossCheck;
  if (typeof c?.said === "string") onEvent({ stage: "test", message: `Cross-check: the answer names "${c.said}", listed by ${source} in the response it read` });
  else if (c?.source !== undefined) onEvent({ stage: "test", message: `Cross-check: the answer says ${c.said}, ${source} says ${c.source}${r.passed ? ", a match" : ""}` });
  else if (c?.skipped) onEvent({ stage: "test", message: `Cross-check skipped: ${c.skipped}` });
}

/** Turns the plan into the source's one general skill, keeping the user's topic as the test example. */
async function generalTool(request: string, plan: Plan, tool: NonNullable<Source["tool"]>) {
  const values = await ask<Record<string, string>>(
    "You extract the values a request names.",
    `The user asked: "${request}"\n\nFor each field give the value from the request${tool.inputs.some((i) => i.optional) ? ", or an empty string when the user didn't name it" : ""}:\n${tool.inputs.map((i) => `- ${i.name}: ${i.description}`).join("\n")}`,
    { type: "object", properties: Object.fromEntries(tool.inputs.map((i) => [i.name, { type: "string" }])), required: tool.inputs.map((i) => i.name) },
    0,
  );
  Object.assign(plan, {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputs: tool.inputs.map((i) => {
      const said = values[i.name]?.trim() ?? "";
      const example = i.type === "number" ? String(Number(said.replace(/[^0-9.]/g, "")) || 1) : said || (i.optional ? "" : request);
      const another = i.another.find((a) => a.toLowerCase() !== example.toLowerCase());
      return { name: i.name, type: i.type ?? "string", description: i.description, example, another_example: another, optional: i.optional };
    }),
  });
}

export async function guidedForge(request: string, onEvent: (e: ForgeEvent) => void): Promise<SmithResult> {
  onEvent({ stage: "thinking", message: "Choosing a data source" });
  const plan = await ask<Plan>(
    SYSTEM,
    `The user asked the assistant: "${request}"

Available public data sources:
${catalogMenu()}

Pick the one source that can answer this. If none can (or it needs a login, payment, private data or a physical action), set feasible=false, source="none", and make reason one friendly sentence to the user explaining that you can't do it and why.
Otherwise design a reusable tool: a snake_case verb name (like get_air_quality), a short title, a description saying exactly when to use it, and its inputs. Make inputs general (e.g. city), with the user's own values as examples, and for each a different realistic another_example (e.g. another city). Every value the user named that could change between questions (a city, a word, a coin, a currency) must be an input, never fixed in the code. Use no inputs if none are needed.`,
    PLAN_SCHEMA,
  );

  const src = catalogById.get(plan.source);
  if (!plan.feasible || !src) throw new ForgeFailed(plan.reason || "I can't find a public source for that yet.");
  if (src.tool) await generalTool(request, plan, src.tool);

  const inputs = plan.inputs.map((i) => `${toSnake(i.name)}: ${i.type}`).join(", ");
  onEvent({ stage: "thinking", message: `Chose ${src.name}, a verified source for ${src.useFor}` });
  onEvent({ stage: "thinking", message: `Designed ${toSnake(plan.name)}(${inputs})` });
  const docs = sourceDocs(src);
  const evidence = await samples(src, onEvent);
  const brief = `The user asked: "${request}"
Tool: ${plan.name}: ${plan.description}
Inputs: ${plan.inputs.length ? plan.inputs.map((i) => `${toSnake(i.name)} (${i.type}) e.g. ${JSON.stringify(i.example)}`).join(", ") : "none"}

API documentation:
${docs}

Real responses:
${evidence}`;

  onEvent({ stage: "thinking", message: `Writing the code against ${src.domains.join(" and ")}` });
  let { code } = await ask<{ code: string }>(SYSTEM, `${brief}\n\n${CONTRACT}`, CODE_SCHEMA);

  let reviewed = false;
  // A version that passed its test but whose wording was flagged; used if the rewording breaks it.
  let working: SmithResult | undefined;
  for (let attempt = 1; attempt <= config.maxSubmissions; attempt++) {
    // Mend the most common small-model slip ('couldn't' in single quotes) without a model round trip.
    if (await syntaxError(code)) {
      const mended = fixApostrophes(code);
      if (mended !== code && !(await syntaxError(mended))) {
        code = mended;
        onEvent({ stage: "repair", message: "Fixed an apostrophe inside a quoted string" });
      }
    }
    const spec = buildSpec(request, plan, src, code);
    onEvent({ stage: "submit", message: `Wrote ${spec.name} (attempt ${attempt})` });

    const problems = validateSpec(spec);
    const syntax = problems.length ? null : await syntaxError(code);
    if (syntax) problems.push(`syntax error at ${syntax}`);
    let failure: string;
    if (problems.length) {
      onEvent({ stage: "repair", message: `Static check failed: ${problems[0].split("\n")[0].replace(/:$/, "")}` });
      failure = `It was rejected before running:\n- ${problems.join("\n- ")}`;
    } else {
      onEvent({ stage: "test", message: "Running a live test in the sandbox" });
      const report = await testSpec(spec);
      const speech = (report.results[0]?.result as { speech?: string } | undefined)?.speech ?? "";
      tellResult(spec, report, src.name, onEvent);
      const problem = report.passed && !reviewed && attempt < config.maxSubmissions ? await reviewSpeech(request, speech) : null;
      reviewed ||= report.passed;
      if (report.passed && !problem) {
        onEvent({ stage: "ready", message: `All tests passed for ${spec.name}` });
        return { spec, report, attempts: attempt };
      }
      if (problem) {
        onEvent({ stage: "repair", message: `Answer reads badly: ${problem.slice(0, 80)}` });
        working = { spec, report, attempts: attempt };
        failure = `The code works, but the spoken answer has a problem: ${problem}\nIt said: "${speech}"\nChange only how speech is worded.`;
        ({ code } = await ask<{ code: string }>(
          SYSTEM,
          `${brief}\n\n${CONTRACT}\n\nYour previous code:\n${code}\n\n${failure}\n\nReturn the complete corrected module.`,
          CODE_SCHEMA,
        ));
        continue;
      }
      failure = `The live test failed:\n${describeFailure(report, request, spec)}`;
      onEvent({ stage: "repair", message: `Test failed: ${failure.split("\n")[2]?.replace(/^- /, "").slice(0, 80) ?? "fixing"}` });
    }
    if (attempt === config.maxSubmissions) break;
    // Small models tend to re-emit their own broken code, so every other retry
    // starts over (warmer, with the last failure as a warning) instead of patching.
    if (attempt % 2 === 0) {
      onEvent({ stage: "thinking", message: "Starting over with a fresh approach" });
      ({ code } = await ask<{ code: string }>(
        SYSTEM,
        `${brief}\n\n${CONTRACT}\n\nA previous attempt failed like this, avoid it:\n${failure}`,
        CODE_SCHEMA,
        0.6,
      ));
    } else {
      ({ code } = await ask<{ code: string }>(
        SYSTEM,
        `${brief}\n\n${CONTRACT}\n\nYour previous code:\n${code}\n\n${failure}\n\nFix the code. Return the complete corrected module.`,
        CODE_SCHEMA,
      ));
    }
  }
  if (working) {
    onEvent({ stage: "ready", message: `All tests passed for ${working.spec.name}` });
    return working;
  }
  throw new ForgeFailed("I tried a few times but couldn't get that working reliably.");
}
