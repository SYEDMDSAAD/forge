// Time a trivial forged-tool call through the sandbox: npx tsx scripts/sandbox-latency.ts [runs]
import * as sb from "../src/sandbox/sandbox.js";

const runs = Number(process.argv[2] ?? 5);
const code = `export default async function run({ n }) { return { speech: "ok " + n }; }`;
const times: number[] = [];
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const out = await sb.runInSandbox({ mode: "run", code, input: { n: i }, allowedDomains: [] });
  times.push(Math.round(performance.now() - t0));
  if (!out.ok) console.log("error:", out.error);
  await new Promise((r) => setTimeout(r, 1500)); // let the pool refill, like real gaps between requests
}
console.log("ms per call:", times.join(", "));
sb.shutdownSandbox();
