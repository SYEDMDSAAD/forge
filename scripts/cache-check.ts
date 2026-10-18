// The relay's response cache: fresh replies are reused, sources that say
// "no-cache" are always asked again, and a source that is down is answered from
// its last good reply only in real use (never while a skill is being tested);
// a source that refuses is reported even when the skill hides its error.
//   npx tsx scripts/cache-check.ts
import { seedCache } from "../src/sandbox/relay.js";
import { runInSandbox, shutdownSandbox } from "../src/sandbox/sandbox.js";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

/** Runs a skill that fetches `url` and reports how the cache answered. */
async function get(url: string, domain: string, mode: "run" | "test" = "run") {
  const code = `export default async function run() {
  const r = await fetch(${JSON.stringify(url)});
  const body = await r.json();
  return { speech: "cache=" + r.headers.get("x-forge-cache") + " status=" + r.status, data: body };
}`;
  const t0 = performance.now();
  const out =
    mode === "run"
      ? await runInSandbox({ mode, code, input: {}, allowedDomains: [domain] })
      : await runInSandbox({ mode, code, allowedDomains: [domain], tests: [{ name: "t", input: {}, assert: "result.speech.includes('status=200')" }] });
  const speech = (out.ok ? String((out.result as { speech?: string })?.speech ?? JSON.stringify(out.result)) : `error: ${out.error}`).toLowerCase();
  return { out, speech, ms: Math.round(performance.now() - t0) };
}

try {
  // Open-Meteo sends no Cache-Control: reused for 10 minutes.
  const geo = "https://geocoding-api.open-meteo.com/v1/search?count=1&name=Nagpur";
  const first = await get(geo, "open-meteo.com");
  const second = await get(geo, "open-meteo.com");
  check(first.speech.includes("cache=null status=200"), `first request goes to the source (${first.ms} ms)`);
  check(second.speech.includes("cache=hit"), `a repeat within 10 minutes is answered from the cache (${second.ms} ms)`);

  // The ISS API says "no-cache": always asked again.
  const iss = "https://api.wheretheiss.at/v1/satellites/25544";
  await get(iss, "wheretheiss.at");
  const again = await get(iss, "wheretheiss.at");
  check(again.speech.includes("cache=null"), `a source that says no-cache is always asked again (${again.speech})`);

  // A source that is down (here: a name that doesn't exist), with a reply from 12 minutes ago.
  const dead = "https://weather.forge-cache-test.invalid/now";
  seedCache(dead, JSON.stringify({ temperature: 21 }), 12 * 60_000);
  const stale = await get(dead, "forge-cache-test.invalid");
  const minutes = Math.round((stale.out.staleMs ?? 0) / 60_000);
  check(stale.speech.includes("cache=stale") && minutes === 12, `a down source is answered from its last reply, reported as ${minutes} minutes old`);

  const tested = await get(dead, "forge-cache-test.invalid", "test");
  const passed = (tested.out.tests as { passed: boolean }[] | undefined)?.every((t) => t.passed);
  check(!passed && tested.out.staleMs === undefined, "a skill being tested never gets old data (its test fails instead)");

  seedCache(dead, JSON.stringify({ temperature: 21 }), 3 * 60 * 60_000);
  const tooOld = await get(dead, "forge-cache-test.invalid");
  check(!tooOld.speech.includes("cache=stale"), "replies older than 2 hours are never used");

  // A skill that turns an error into an answer ("no launch was found"): a refusing or
  // failing source is reported so the user hears "isn't answering", not a wrong answer.
  const hides = (status: number) => `export default async function run() {
  const r = await fetch("https://httpbin.org/status/${status}");
  if (!r.ok) return { speech: "No upcoming launch was found." };
  return { speech: "ok" };
}`;
  const down = await runInSandbox({ mode: "run", code: hides(503), input: {}, allowedDomains: ["httpbin.org"] });
  check(down.ok && down.upstream?.status === 503, "a source that fails is reported even when the skill hides it in its answer");
  const missing = await runInSandbox({ mode: "run", code: hides(404), input: {}, allowedDomains: ["httpbin.org"] });
  check(missing.ok && missing.upstream === undefined, "a 404 is left to the skill: it can be a real \"not found\"");
} finally {
  shutdownSandbox();
}
process.exit(failed ? 1 : 0);
