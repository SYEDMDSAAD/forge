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

const checkUrl = (url) => {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Blocked protocol ${url.protocol}`);
  if (!isAllowed(url.hostname.toLowerCase())) {
    throw new Error(`Blocked by Forge sandbox: ${url.hostname} is not in this tool's allowed domains (${allowed.join(", ") || "none"})`);
  }
};

globalThis.fetch = async (resource, init = {}) => {
  let url = new URL(typeof resource === "string" || resource instanceof URL ? resource : resource.url);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("user-agent")) headers.set("user-agent", "Forge/1.0 (MCP skill sandbox)");
  const signal = AbortSignal.timeout(job.fetchTimeoutMs ?? 10000);
  // Follow redirects by hand so every hop is checked against the allowlist.
  for (let hop = 0; hop <= 5; hop++) {
    checkUrl(url);
    fetched.push(url.href);
    const res = await realFetch(url, { ...init, headers, signal, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    url = new URL(location, url);
  }
  throw new Error("Too many redirects");
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

// Mechanical clean-up of the spoken answer, so small slips in generated code
// don't reach the listener: line breaks, "..", doubled words, " | ", lowercase start.
const tidySpeech = (speech) =>
  speech
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+\|\s+/g, ": ")
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());

const tidy = (result) => (result && typeof result.speech === "string" ? { ...result, speech: tidySpeech(result.speech) } : result);

const numbersIn = (text) =>
  (text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, ""))).filter(Number.isFinite);

/** Compare the numbers in the answer with what the source itself reports. Returns a reason on mismatch. */
async function crossCheck(speech, test) {
  const said = numbersIn(speech);
  if (!said.length) return null; // nothing numeric to verify
  const reference = await loadTool(test.reference.code);
  const expected = (await withTimeout(reference(test.input ?? {}), job.timeoutMs, "Reference check")).filter(Number.isFinite);
  if (!expected.length) return null;
  const { relTol = 0.03, absTol = 0 } = test.reference;
  const close = (a, b) => Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
  if (said.some((a) => expected.some((b) => close(a, b)))) return null;
  const round = (n) => Math.round(n * 100) / 100;
  return `Cross-check failed: the answer says ${said.join(", ")}, but the source reports ${expected.slice(0, 8).map(round).join(", ")} for this input. A value is computed or read wrongly.`;
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
    const result = tidy(await withTimeout(run(job.input ?? {}), job.timeoutMs, "Tool"));
    return { ok: true, result };
  }

  if (job.mode === "test") {
    const results = [];
    for (const test of job.tests) {
      const started = Date.now();
      try {
        const result = tidy(await withTimeout(run(test.input ?? {}), job.timeoutMs, `Test "${test.name}"`));
        if (!result || typeof result.speech !== "string" || !result.speech.trim()) {
          throw new Error("Tool must return an object with a non-empty `speech` string");
        }
        const check = new Function("result", "input", `"use strict"; return (${test.assert});`);
        let passed = Boolean(check(result, test.input));
        let error = passed ? undefined : `Assertion was false: ${test.assert}`;
        if (passed && test.reference) {
          const mismatch = await crossCheck(result.speech, test);
          if (mismatch) [passed, error] = [false, mismatch];
        }
        results.push({ name: test.name, passed, durationMs: Date.now() - started, result, ...(error ? { error } : {}) });
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
