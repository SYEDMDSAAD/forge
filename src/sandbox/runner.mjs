// Executed inside the sandbox (container or isolated process). The container has
// no network: the runner's fetch asks the host for each request over stdio, and the
// host (src/sandbox/relay.ts) enforces the skill's domain allowlist.
//
// Protocol, one JSON value per line. stdin: the job, then fetch replies.
// stdout: "__FORGE_FETCH__{request}" lines, then one "__FORGE_RESULT__{output}".
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";

// Captured before any untrusted code loads.
const writeOut = process.stdout.write.bind(process.stdout);

const pending = new Map();
let nextId = 1;
let resolveJob;
const jobReady = new Promise((resolve) => (resolveJob = resolve));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (resolveJob) {
    const resolve = resolveJob;
    resolveJob = undefined;
    return resolve(msg);
  }
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
lines.on("close", () => {
  if (resolveJob) process.exit(0); // warm-pool runner shut down before getting a job
  for (const reply of pending.values()) reply({ ok: false, code: "ECLOSED", error: "Sandbox input closed" });
});
const job = await jobReady;

const logs = [];
const capture = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
console.log = console.info = console.warn = console.error = console.debug = capture;

// URLs the skill itself requested in the current test, for the cross-check.
let requested = [];

globalThis.fetch = async (resource, init = {}) => {
  const url = typeof resource === "string" || resource instanceof URL ? String(resource) : resource.url;
  requested.push(url);
  const headers = Object.fromEntries(new Headers(init.headers ?? {}));
  const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer()).toString("base64");
  const id = nextId++;
  const reply = await new Promise((resolve) => {
    pending.set(id, resolve);
    writeOut("__FORGE_FETCH__" + JSON.stringify({ id, url, method: init.method ?? "GET", headers, body }) + "\n");
  });
  if (!reply.ok) {
    if (reply.code === "EBLOCKED" || reply.code === "EPRIVATEADDR" || reply.code === "EPROTOCOL") throw new Error(reply.error);
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(reply.error), { code: reply.code }) });
  }
  const nullBody = [101, 204, 205, 304].includes(reply.status);
  const res = new Response(nullBody ? null : Buffer.from(reply.body, "base64"), { status: reply.status, statusText: reply.statusText, headers: reply.headers });
  Object.defineProperty(res, "url", { value: reply.url });
  Object.defineProperty(res, "redirected", { value: reply.redirected });
  return res;
};

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);

const errorText = (e) => {
  const text = e && e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : String(e);
  // fetch() hides the network reason ("fetch failed") in e.cause.
  const cause = e?.cause ? ` (cause: ${e.cause.code ?? e.cause.message ?? e.cause})` : "";
  // Stack frames name the module by its data: URL; keep only line:column.
  return text.replace(/^(.*)$/m, `$1${cause}`).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "skill.js");
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
    .replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e) => ({ amp: "&", quot: '"', "#39": "'", apos: "'", lt: "<", gt: ">" })[e])
    .replace(/\s+\|\s+/g, ": ")
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());

const tidy = (result) => (result && typeof result.speech === "string" ? { ...result, speech: tidySpeech(result.speech) } : result);

// Headlines compared without case, entities or punctuation differences.
const plain = (text) =>
  String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const numbersIn = (text) =>
  (text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, ""))).filter(Number.isFinite);

/**
 * Compare the numbers in the answer with what the source itself reports.
 * Returns what was compared (shown to the user) and, on a mismatch, the reason.
 */
async function crossCheck(speech, test, fetched) {
  const reference = await loadTool(test.reference.code);
  const values = await withTimeout(reference(test.input ?? {}, { fetched }), job.timeoutMs, "Reference check");
  // Text the source reports (headlines): the answer must quote at least one.
  const texts = values.filter((v) => typeof v === "string" && v.length >= 12);
  if (texts.length) {
    const hit = texts.find((t) => plain(speech).includes(plain(t).slice(0, 32)));
    if (hit) return { said: hit.slice(0, 120), source: "a current headline" };
    return { error: `Cross-check failed: the answer quotes none of the headlines the source reports right now, such as "${texts[0]}". Read the titles from the response and say them.` };
  }
  const said = numbersIn(speech);
  if (!said.length) return { skipped: "the answer has no numbers to check" };
  const expected = values.filter(Number.isFinite);
  if (!expected.length) return { skipped: "the source gave nothing to compare for this input" };
  const { relTol = 0.03, absTol = 0 } = test.reference;
  const close = (a, b) => Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
  const round = (n) => Math.round(n * 100) / 100;
  for (const a of said) {
    const b = expected.find((x) => close(a, x));
    if (b !== undefined) return { said: a, source: round(b), tolerance: relTol };
  }
  return {
    said: said[0],
    error: `Cross-check failed: the answer says ${said.join(", ")}, but the source reports ${expected.slice(0, 8).map(round).join(", ")} for this input. A value is computed or read wrongly.`,
  };
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
        requested = [];
        const result = tidy(await withTimeout(run(test.input ?? {}), job.timeoutMs, `Test "${test.name}"`));
        const fetched = [...requested];
        if (!result || typeof result.speech !== "string" || !result.speech.trim()) {
          throw new Error("Tool must return an object with a non-empty `speech` string");
        }
        const check = new Function("result", "input", `"use strict"; return (${test.assert});`);
        let passed = Boolean(check(result, test.input));
        let error = passed ? undefined : `Assertion was false: ${test.assert}`;
        let checked;
        if (passed && test.reference) {
          const { error: mismatch, ...rest } = await crossCheck(result.speech, test, fetched);
          checked = rest;
          if (mismatch) [passed, error] = [false, mismatch];
        }
        results.push({ name: test.name, passed, durationMs: Date.now() - started, result, ...(checked ? { crossCheck: checked } : {}), ...(error ? { error } : {}) });
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
writeOut("\n__FORGE_RESULT__" + JSON.stringify(output) + "\n", () => process.exit(0));
