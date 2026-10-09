// Executed inside the sandbox (container or isolated process). Reads one JSON job
// from stdin, writes one JSON result to stdout. Untrusted tool code never sees
// the real fetch: every request goes through the domain allowlist below.
import { Buffer } from "node:buffer";
import net from "node:net";

// Node gives each IPv6/IPv4 connect attempt 250ms by default; on high-latency
// links (e.g. India -> EU APIs) that fails ~1 in 4 requests with ETIMEDOUT.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const logs = [];
const fetched = [];
const capture = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
console.log = console.info = console.warn = console.error = console.debug = capture;

const realFetch = globalThis.fetch;
const allowed = (job.allowedDomains ?? []).map((d) => d.toLowerCase());
const isAllowed = (host) => allowed.some((d) => host === d || host.endsWith("." + d));

globalThis.fetch = async (resource, init = {}) => {
  const url = new URL(typeof resource === "string" || resource instanceof URL ? resource : resource.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Blocked protocol ${url.protocol}`);
  if (!isAllowed(url.hostname.toLowerCase())) {
    throw new Error(`Blocked by Forge sandbox: ${url.hostname} is not in this tool's allowed domains (${allowed.join(", ") || "none"})`);
  }
  fetched.push(url.href);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("user-agent")) headers.set("user-agent", "Forge/1.0 (+https://github.com/SYEDMDSAAD/forge)");
  return realFetch(url, { ...init, headers, signal: AbortSignal.timeout(job.fetchTimeoutMs ?? 10000) });
};

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);

const errorText = (e) => {
  const text = e && e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : String(e);
  // fetch() hides the network reason ("fetch failed") in e.cause.
  const cause = e?.cause ? ` (cause: ${e.cause.code ?? e.cause.message ?? e.cause})` : "";
  return text.replace(/^(.*)$/m, `$1${cause}`);
};

async function loadTool(code) {
  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  if (typeof mod.default !== "function") throw new Error("Tool module must `export default async function run(input)`");
  return mod.default;
}

async function main() {
  if (job.mode === "probe") {
    const res = await fetch(job.url, { method: job.method ?? "GET", headers: job.headers ?? {} });
    const body = await res.text();
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes: body.length,
      body: body.slice(0, job.maxChars ?? 6000),
    };
  }

  const run = await loadTool(job.code);

  if (job.mode === "run") {
    const result = await withTimeout(run(job.input ?? {}), job.timeoutMs, "Tool");
    return { ok: true, result };
  }

  if (job.mode === "test") {
    const results = [];
    for (const test of job.tests) {
      const started = Date.now();
      try {
        const result = await withTimeout(run(test.input ?? {}), job.timeoutMs, `Test "${test.name}"`);
        if (!result || typeof result.speech !== "string" || !result.speech.trim()) {
          throw new Error("Tool must return an object with a non-empty `speech` string");
        }
        const check = new Function("result", "input", `"use strict"; return (${test.assert});`);
        const passed = Boolean(check(result, test.input));
        results.push({
          name: test.name,
          passed,
          durationMs: Date.now() - started,
          result,
          ...(passed ? {} : { error: `Assertion was false: ${test.assert}` }),
        });
      } catch (e) {
        results.push({ name: test.name, passed: false, durationMs: Date.now() - started, error: errorText(e) });
      }
    }
    return { ok: true, results };
  }

  throw new Error(`Unknown mode ${job.mode}`);
}

let output;
try {
  output = await main();
} catch (e) {
  output = { ok: false, error: errorText(e) };
}
output.logs = logs.join("\n").slice(0, 4000);
output.fetched = fetched;
process.stdout.write("\n__FORGE_RESULT__" + JSON.stringify(output) + "\n");
process.exit(0);
