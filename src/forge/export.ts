// Turns a learned skill into an ordinary, standalone MCP server folder: one fixed
// tool, the skill's code unchanged, its tests and source cross-checks, and a
// review checklist. No Forge, no model, no sandbox needed to run it. This is the
// path from "learned at runtime" to a certifiable Alexa+ add-on: a person reviews
// the folder and ships it like any hand-written integration.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXPLICIT } from "../sandbox/content-filter.js";
import type { Capability } from "./types.js";

const sdkVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    return pkg.dependencies["@modelcontextprotocol/sdk"] as string;
  } catch {
    return "^1.32.1";
  }
})();

/** Sources cited in answers: declared names, else the sites' registrable domains. */
export function sourcesOf(cap: Capability): string[] {
  if (cap.spec.sources?.length) return cap.spec.sources;
  return [...new Set(cap.spec.allowedDomains.map((d) => d.split(".").slice(-2).join(".")))];
}

// Shared by server.mjs and test.mjs. Kept dependency-free and short enough to review.
const LIB = `// Runtime for this skill: a fetch limited to the declared sites, the answer
// clean-up and source citation Forge applied, and the cross-check.
import { readFileSync } from "node:fs";

export const manifest = JSON.parse(readFileSync(new URL("./forge-export.json", import.meta.url), "utf8"));

const realFetch = globalThis.fetch;
const allowed = (host) => manifest.tool.allowedDomains.some((d) => host === d || host.endsWith("." + d));

// Headlines are read aloud: explicit and spam stories are dropped from feeds, as in Forge.
const UNSUITABLE = new RegExp(${JSON.stringify(EXPLICIT.source)}, "i");
const filterFeed = (body) =>
  body.replace(/<(item|entry)[\\s>][^]*?<\\/\\1>/g, (story) => (UNSUITABLE.test((/<title[^>]*>([^]*?)<\\/title>/.exec(story)?.[1] ?? "").replace(/&amp;/g, "&")) ? "" : story));

/** URLs the skill requested since the last reset, for the cross-check. */
export const requested = [];

/** fetch that refuses any site the skill didn't declare, on every redirect hop. */
globalThis.fetch = async function guardedFetch(input, init = {}) {
  let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requested.push(url.href);
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Blocked protocol " + url.protocol);
    if (!allowed(url.hostname)) throw new Error(url.hostname + " is not one of this skill's declared sites");
    // Public APIs (Wikimedia among them) ask automated clients to say who they are.
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", "Forge skill (https://github.com/SYEDMDSAAD/forge)");
    const res = await realFetch(url, { ...init, headers, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(10000) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      if (!/xml|rss|atom/i.test(res.headers.get("content-type") ?? "")) return res;
      return new Response(filterFeed(await res.text()), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    url = new URL(location, url);
  }
  throw new Error("Too many redirects");
};

export const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms))]);

export const tidySpeech = (speech) =>
  speech
    .replace(/\\s*\\n+\\s*/g, " ")
    .replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e) => ({ amp: "&", quot: '"', "#39": "'", apos: "'", lt: "<", gt: ">" })[e])
    .replace(/\\s+\\|\\s+/g, ": ")
    .replace(/\\b(\\w+)(\\s+\\1\\b)+/gi, "$1")
    .replace(/(?<!\\.)\\.\\.(?!\\.)/g, ".")
    .replace(/\\s+([.,!?;:])/g, "$1")
    .replace(/\\s{2,}/g, " ")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());

/** Every answer names its source. */
export function cite(speech) {
  const sources = manifest.tool.sources;
  return sources.some((s) => speech.toLowerCase().includes(s.toLowerCase())) ? speech : speech + " Source: " + sources.join(" and ") + ".";
}

/** The input schema's required fields and basic types; returns a problem or null. */
export function checkInput(input) {
  const schema = manifest.tool.inputSchema;
  for (const key of schema.required ?? []) if (input[key] === undefined || input[key] === "") return "missing " + key;
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop) return "unknown input " + key;
    const type = prop.type === "integer" ? "number" : prop.type;
    if (type && typeof value !== type) return key + " must be a " + prop.type;
  }
  return null;
}

const numbersIn = (text) => (text.match(/-?\\d[\\d,]*(?:\\.\\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, ""))).filter(Number.isFinite);

const plain = (text) => String(text).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Compares the answer with what the source itself reports (its numbers, or its
 * current headlines); returns a reason on mismatch. fetched: the URLs the skill requested.
 */
export async function crossCheck(speech, test, fetched = []) {
  if (!test.reference) return null;
  const reference = (await import("data:text/javascript;base64," + Buffer.from(test.reference.code).toString("base64"))).default;
  const reply = await withTimeout(reference(test.input ?? {}, { fetched }), 15000, "Reference check");
  if (Array.isArray(reply?.every))
    return reply.every.every((t) => typeof t !== "string" || t.length < 12 || plain(speech).includes(plain(t).slice(0, 32))) ? null : "the answer doesn't quote the source for every input";
  if (Array.isArray(reply?.anyOf)) {
    const names = reply.anyOf.filter((t) => typeof t === "string" && plain(t));
    return !names.length || names.some((t) => (" " + plain(speech) + " ").includes(" " + plain(t) + " ")) ? null : "the answer doesn't name what the source reports";
  }
  const values = reply;
  const texts = values.filter((v) => typeof v === "string" && v.length >= 12);
  if (texts.length) return texts.some((t) => plain(speech).includes(plain(t).slice(0, 32))) ? null : "the answer quotes none of the source's current headlines";
  const said = numbersIn(speech);
  if (!said.length) return null;
  const expected = values.filter(Number.isFinite);
  if (!expected.length) return null;
  const { relTol = 0.03, absTol = 0 } = test.reference;
  if (said.some((a) => expected.some((b) => Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol)))) return null;
  return "the answer says " + said.join(", ") + " but the source reports " + expected.slice(0, 8).join(", ");
}
`;

const SERVER = `// Standalone MCP server for one skill (Streamable HTTP, stateless).
//   npm install && npm start      -> http://localhost:3000/mcp
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkInput, cite, manifest, tidySpeech, withTimeout } from "./lib.mjs";
import run from "./skill.mjs";

const { tool } = manifest;

function createServer() {
  const server = new Server({ name: tool.name, title: tool.title, version: manifest.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== tool.name) return { content: [{ type: "text", text: "Unknown tool " + req.params.name }], isError: true };
    const input = req.params.arguments ?? {};
    const problem = checkInput(input);
    if (problem) return { content: [{ type: "text", text: "Wrong input: " + problem + ". Expected: " + JSON.stringify(tool.inputSchema) }], isError: true };
    try {
      const result = await withTimeout(run(input), 10000, tool.title);
      const speech = cite(tidySpeech(String(result.speech)));
      return { content: [{ type: "text", text: speech }], structuredContent: { speech, data: result.data ?? null, sources: tool.sources } };
    } catch (e) {
      console.error(tool.name + " failed:", e);
      return { content: [{ type: "text", text: tool.sources.join(" and ") + " didn't give a usable answer right now. Try again in a minute." }], isError: true };
    }
  });
  return server;
}

const app = createMcpExpressApp();
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close().then(() => server.close()));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/health", (_req, res) => res.json({ ok: true, tool: tool.name }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(tool.title + " MCP server on http://localhost:" + port + "/mcp"));
`;

const TEST = `// Runs the skill's tests live, including the cross-check against the source.
//   npm test
import { crossCheck, manifest, requested, tidySpeech, withTimeout } from "./lib.mjs";
import run from "./skill.mjs";

let failed = 0;
for (const test of manifest.tests) {
  const t0 = Date.now();
  try {
    requested.length = 0;
    const result = await withTimeout(run(test.input ?? {}), 15000, test.name);
    const fetched = [...requested];
    const speech = tidySpeech(String(result.speech));
    const check = new Function("result", "input", '"use strict"; return (' + test.assert + ");");
    const problem = !check({ ...result, speech }, test.input) ? "assertion was false: " + test.assert : await crossCheck(speech, test, fetched);
    const ms = Date.now() - t0;
    console.log((problem ? "FAIL " : "PASS ") + test.name + " (" + ms + " ms" + (ms > 500 ? ", over Alexa+'s 500 ms" : "") + ")\\n     " + (problem ?? speech));
    if (problem) failed++;
  } catch (e) {
    console.log("FAIL " + test.name + "\\n     " + e.message);
    failed++;
  }
}
console.log("\\n" + (manifest.tests.length - failed) + "/" + manifest.tests.length + " passed" + (manifest.tests.some((t) => t.reference) ? " (with source cross-check)" : ""));
process.exit(failed ? 1 : 0);
`;

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
`;

function readme(cap: Capability, sources: string[], exportedAt: string): string {
  const props = Object.entries((cap.spec.inputSchema as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {});
  const passed = cap.testReport.results.filter((r) => r.passed).length;
  const crossChecked = cap.spec.tests.some((t) => t.reference);
  return `# ${cap.spec.title}

${cap.spec.description}

A standalone MCP server with one tool, \`${cap.spec.name}\`. It was learned by [Forge](https://github.com/SYEDMDSAAD/forge) from the request *"${cap.request}"* and exported for review on ${exportedAt.slice(0, 10)}. It needs no Forge, no AI model and no API keys.

| | |
|---|---|
| Tool | \`${cap.spec.name}\` (read-only) |
| Inputs | ${props.length ? props.map(([k, p]) => `\`${k}\` (${p.type ?? "string"}): ${p.description ?? ""}`).join("<br>") : "none"} |
| Sites it may reach | ${cap.spec.allowedDomains.map((d) => `\`${d}\``).join(", ")} (enforced in \`lib.mjs\`, on every redirect) |
| Cited source | ${sources.join(", ")} |
| Tests when learned | ${passed}/${cap.testReport.results.length} passed live${crossChecked ? ", answer cross-checked against the source" : ""} |

## Run

\`\`\`bash
npm install
npm test     # live tests + source cross-check
npm start    # MCP server at http://localhost:3000/mcp (Streamable HTTP)
\`\`\`

Or with Docker: \`docker build -t ${cap.spec.name.replace(/_/g, "-")} . && docker run -p 3000:3000 ${cap.spec.name.replace(/_/g, "-")}\`.

## Files

- \`skill.mjs\`: the code Forge wrote, unchanged. **This is the file to review.**
- \`lib.mjs\`: the runtime around it: site allowlist, answer clean-up, source citation, cross-check.
- \`server.mjs\`: the MCP server (one fixed tool, stateless).
- \`test.mjs\`, \`forge-export.json\`: tests, tool definition and provenance (request, attempts, test results).

## Review checklist before shipping as an Alexa+ add-on

- [ ] Read \`skill.mjs\`: it only calls the sites listed above and does what the description says.
- [ ] \`npm test\` passes${crossChecked ? ", including the cross-check" : ""}, and each answer reads well aloud.
- [ ] The source's terms allow your use (some free APIs are non-commercial only or ask for attribution).
- [ ] Latency: \`npm test\` flags any answer slower than Alexa+'s 500 ms; add caching if needed.
- [ ] No personal data: the tool keeps nothing and needs no account linking.
- [ ] Host it over HTTPS and register \`/mcp\` as the add-on's MCP endpoint.
`;
}

/** Writes the export folder and returns its path. */
export function exportCapability(cap: Capability, outDir: string): string {
  const exportedAt = new Date().toISOString();
  const sources = sourcesOf(cap);
  const manifest = {
    version: "1.0.0",
    tool: {
      name: cap.spec.name,
      title: cap.spec.title,
      description: cap.spec.description,
      inputSchema: cap.spec.inputSchema,
      allowedDomains: cap.spec.allowedDomains,
      sources,
    },
    tests: cap.spec.tests,
    provenance: {
      learnedBy: "Forge (https://github.com/SYEDMDSAAD/forge)",
      request: cap.request,
      learnedAt: cap.createdAt,
      approvedAt: cap.approvedAt ?? null,
      exportedAt,
      attempts: cap.attempts,
      testResults: cap.testReport.results.map((r) => ({ name: r.name, passed: r.passed, ms: r.durationMs, ...(r.error ? { error: r.error } : {}) })),
    },
  };
  const pkg = {
    name: cap.spec.name.replace(/_/g, "-"),
    version: "1.0.0",
    description: cap.spec.description,
    type: "module",
    private: true,
    engines: { node: ">=20" },
    scripts: { start: "node server.mjs", test: "node test.mjs" },
    dependencies: { "@modelcontextprotocol/sdk": sdkVersion, express: "^5.2.1" },
  };
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {
    "skill.mjs": cap.spec.code.trimEnd() + "\n",
    "lib.mjs": LIB,
    "server.mjs": SERVER,
    "test.mjs": TEST,
    "forge-export.json": JSON.stringify(manifest, null, 2) + "\n",
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    Dockerfile: DOCKERFILE,
    ".dockerignore": "node_modules\n",
    "README.md": readme(cap, sources, exportedAt),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(outDir, name), content);
  return outDir;
}
