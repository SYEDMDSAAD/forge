// Reliability benchmark for the smith: npx tsx scripts/forge-bench.ts [filter]
// Builds each request from scratch and reports pass/fail, attempts and time.
import { ForgeFailed, forgeTool } from "../src/forge/smith.js";
import { config } from "../src/config.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

const CASES: { request: string; expect: "build" | "refuse" }[] = [
  { request: "What's the weather in Pune right now?", expect: "build" },
  { request: "Will it rain in Mumbai tomorrow?", expect: "build" },
  { request: "What's the air quality in Delhi?", expect: "build" },
  { request: "Where is the ISS right now?", expect: "build" },
  { request: "Convert 100 US dollars to rupees", expect: "build" },
  { request: "What's the price of bitcoin in rupees?", expect: "build" },
  { request: "Who was APJ Abdul Kalam?", expect: "build" },
  { request: "What are the top stories on Hacker News?", expect: "build" },
  { request: "What does the word ephemeral mean?", expect: "build" },
  { request: "When is the next rocket launch?", expect: "build" },
  { request: "Were there any big earthquakes today?", expect: "build" },
  { request: "Book me a cab to the airport", expect: "refuse" },
];

const filter = process.argv[2]?.toLowerCase();
const cases = CASES.filter((c) => !filter || c.request.toLowerCase().includes(filter));
console.log(`smith=${config.smith} provider=${config.provider} model=${config.model}\n`);

let ok = 0;
for (const c of cases) {
  const t0 = Date.now();
  let line: string;
  let lastProblem = "";
  try {
    const { spec, report, attempts } = await forgeTool(c.request, (e) => {
      if (e.stage === "repair") lastProblem = e.message;
    });
    const speech = (report.results[0]?.result as { speech?: string })?.speech;
    const good = c.expect === "build";
    if (good) ok++;
    line = `${good ? "PASS" : "FAIL"} built ${spec.name} in ${attempts} attempt(s): ${speech}`;
  } catch (e) {
    if (!(e instanceof ForgeFailed)) throw e;
    const good = c.expect === "refuse";
    if (good) ok++;
    line = `${good ? "PASS" : "FAIL"} refused: ${e.message}${lastProblem ? ` (last problem: ${lastProblem})` : ""}`;
  }
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${c.request}\n        ${line}`);
}
console.log(`\n${ok}/${cases.length} as expected`);
shutdownSandbox();
