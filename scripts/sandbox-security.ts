// Attacks the sandbox the way a hostile skill would; every escape must fail.
//   npx tsx scripts/sandbox-security.ts
import { runInSandbox, shutdownSandbox } from "../src/sandbox/sandbox.js";

let failed = false;
const check = (ok: boolean, what: string, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}\n       ${detail.slice(0, 160)}`);
  if (!ok) failed = true;
};

/** Runs `body` as a skill and returns what it said, or the error it threw. */
async function attempt(body: string, allowedDomains: string[]): Promise<string> {
  const code = `export default async function run() {
  try { ${body} } catch (e) { return { speech: "ERROR " + e.message + (e.cause ? " / " + (e.cause.code ?? e.cause.message) : "") }; }
}`;
  const out = await runInSandbox({ mode: "run", code, input: {}, allowedDomains });
  return out.ok ? String((out.result as { speech: string }).speech) : `SANDBOX ${out.error}`;
}

const get = (lib: string, url: string) => `
  const m = await import/**/("no" + "de:${lib}");
  const status = await new Promise((resolve, reject) => m.get("${url}", (r) => resolve(r.statusCode)).on("error", reject));
  return { speech: "REACHED status " + status };`;

try {
  let said = await attempt(`const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR"); return { speech: "status " + r.status + " " + (await r.json()).rates.INR };`, ["frankfurter.dev"]);
  check(/^status 200 -?\d/i.test(said), "an allowed site works through the relay", said);

  said = await attempt(get("https", "https://example.com/"), ["open-meteo.com"]);
  check(!said.startsWith("REACHED"), "Node's https module can't reach the internet (no network in the container)", said);

  said = await attempt(get("http", "http://1.1.1.1/"), ["open-meteo.com"]);
  check(!said.startsWith("REACHED"), "raw IP addresses are unreachable too", said);

  said = await attempt(`const r = await fetch("https://example.com/"); return { speech: "REACHED " + r.status };`, ["open-meteo.com"]);
  check(said.includes("not in this tool's allowed domains"), "fetch to a site off the allowlist is blocked", said);

  said = await attempt(`const r = await fetch("https://api.frankfurter.app/latest"); return { speech: "REACHED " + r.url };`, ["frankfurter.app"]);
  check(said.includes("api.frankfurter.dev is not in this tool's allowed domains"), "a redirect to another site is blocked", said);

  // localtest.me is a public name that resolves to 127.0.0.1.
  said = await attempt(`const r = await fetch("http://localtest.me:11434/api/tags"); return { speech: "REACHED " + r.status };`, ["localtest.me"]);
  check(said.includes("private or local address"), "an allowed name that resolves to this machine is blocked (no SSRF to local services)", said);

  // Blocked requests count too, so the flood needs no third-party server.
  said = await attempt(`for (let i = 0; i < 60; i++) { try { await fetch("http://localtest.me/"); } catch (e) { if (e.cause?.code === "ELIMIT") return { speech: "stopped at " + i + ": ELIMIT" }; } } return { speech: "REACHED 60" };`, ["localtest.me"]);
  check(said.includes("ELIMIT"), "a request flood is cut off", said);
} finally {
  shutdownSandbox();
}
process.exit(failed ? 1 : 0);
