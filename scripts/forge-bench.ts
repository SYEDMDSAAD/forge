// Reliability benchmark for the smith. Builds each request from scratch and
// reports pass/fail, attempts and time.
//   npx tsx scripts/forge-bench.ts [filter]                 # the 12 core requests
//   npx tsx scripts/forge-bench.ts --large --runs=3         # 30 new phrasings, 3 runs, saved to bench/
// Measures learning from scratch, so code saved by earlier runs is not reused.
process.env.FORGE_RECIPES ??= "0";
import { mkdirSync, writeFileSync } from "node:fs";
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
  { request: "When is NASA's next launch?", expect: "build" },
  { request: "Were there any big earthquakes today?", expect: "build" },
  { request: "Book me a cab to the airport", expect: "refuse" },
];

// Phrasings the smith was never tuned on, across every catalog source, plus
// requests that need a login, payment or private data and must be refused.
const LARGE: typeof CASES = [
  { request: "How hot is it in Chennai right now?", expect: "build" },
  { request: "Is it windy in Kolkata?", expect: "build" },
  { request: "What's the forecast for Bengaluru this weekend?", expect: "build" },
  { request: "What time is sunset in Jaipur today?", expect: "build" },
  { request: "Do I need an umbrella in Mumbai tomorrow?", expect: "build" },
  { request: "How polluted is the air in Lucknow?", expect: "build" },
  { request: "What's the PM2.5 level in Kanpur?", expect: "build" },
  { request: "Which country is the space station flying over?", expect: "build" },
  { request: "How fast is the ISS moving?", expect: "build" },
  { request: "How many euros is 5000 rupees?", expect: "build" },
  { request: "What's the dollar to yen exchange rate?", expect: "build" },
  { request: "How much is one ethereum worth in dollars?", expect: "build" },
  { request: "Is dogecoin up or down today?", expect: "build" },
  { request: "Tell me about the Taj Mahal", expect: "build" },
  { request: "Who is Sundar Pichai?", expect: "build" },
  { request: "What's trending on Hacker News?", expect: "build" },
  { request: "Define serendipity", expect: "build" },
  { request: "What's the meaning of the word ubiquitous?", expect: "build" },
  { request: "When is the next SpaceX launch?", expect: "build" },
  { request: "What's the next rocket going to space?", expect: "build" },
  { request: "What was the strongest earthquake today?", expect: "build" },
  { request: "Was there an earthquake in Japan recently?", expect: "build" },
  { request: "What's the next public holiday in the US?", expect: "build" },
  { request: "Any public holidays coming up in Germany?", expect: "build" },
  { request: "What car model has Elon Musk launched recently?", expect: "build" },
  { request: "What is the latest news about ISRO?", expect: "build" },
  { request: "Any news on the India cricket team today?", expect: "build" },
  { request: "Order a pizza from Domino's", expect: "refuse" },
  { request: "Read my latest emails", expect: "refuse" },
  { request: "What's my bank balance?", expect: "refuse" },
  { request: "Send a WhatsApp message to my mom", expect: "refuse" },
  { request: "Check the status of my Amazon order", expect: "refuse" },
  { request: "Book me a train ticket to Delhi", expect: "refuse" },
];

const args = process.argv.slice(2);
const large = args.includes("--large");
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 1);
const filter = args.find((a) => !a.startsWith("--"))?.toLowerCase();
const cases = (large ? LARGE : CASES).filter((c) => !filter || filter.split("|").some((f) => c.request.toLowerCase().includes(f)));
console.log(`smith=${config.smith} provider=${config.provider} model=${config.model} cases=${cases.length} runs=${runs}\n`);

interface Row {
  run: number;
  request: string;
  expect: "build" | "refuse";
  outcome: "built" | "refused";
  asExpected: boolean;
  seconds: number;
  attempts?: number;
  skill?: string;
  speech?: string;
  reason?: string;
}
const rows: Row[] = [];
let ok = 0;
for (let run = 1; run <= runs; run++) for (const c of cases) {
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
    rows.push({ run, ...c, outcome: "built", asExpected: good, seconds: (Date.now() - t0) / 1000, attempts, skill: spec.name, speech });
  } catch (e) {
    if (!(e instanceof ForgeFailed)) throw e;
    const good = c.expect === "refuse";
    if (good) ok++;
    line = `${good ? "PASS" : "FAIL"} refused: ${e.message}${lastProblem ? ` (last problem: ${lastProblem})` : ""}`;
    rows.push({ run, ...c, outcome: "refused", asExpected: good, seconds: (Date.now() - t0) / 1000, reason: e.message + (lastProblem ? ` (last problem: ${lastProblem})` : "") });
  }
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]${runs > 1 ? ` run ${run}` : ""} ${c.request}\n        ${line}`);
}
console.log(`\n${ok}/${rows.length} as expected`);

if (runs > 1 || large) {
  const builds = rows.filter((r) => r.outcome === "built" && r.asExpected);
  const times = builds.map((r) => r.seconds).sort((a, b) => a - b);
  const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / Math.max(d, 1))}%)`;
  for (let run = 1; run <= runs; run++) {
    const r = rows.filter((x) => x.run === run);
    console.log(`run ${run}: ${pct(r.filter((x) => x.asExpected).length, r.length)}`);
  }
  const shouldBuild = rows.filter((r) => r.expect === "build");
  const shouldRefuse = rows.filter((r) => r.expect === "refuse");
  console.log(`built when it should: ${pct(shouldBuild.filter((r) => r.asExpected).length, shouldBuild.length)}`);
  console.log(`refused when it should: ${pct(shouldRefuse.filter((r) => r.asExpected).length, shouldRefuse.length)}`);
  console.log(`first-attempt builds: ${pct(builds.filter((r) => r.attempts === 1).length, builds.length)}`);
  if (times.length) {
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`build time: mean ${mean.toFixed(0)} s, median ${times[Math.floor(times.length / 2)].toFixed(0)} s, slowest ${times.at(-1)!.toFixed(0)} s`);
  }
  const flaky = cases.filter((c) => rows.filter((r) => r.request === c.request && !r.asExpected).length);
  for (const c of flaky) console.log(`  missed ${rows.filter((r) => r.request === c.request && !r.asExpected).length}/${runs}: ${c.request}`);
  mkdirSync("bench", { recursive: true });
  const file = `bench/${large ? "large" : "core"}-${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.json`;
  writeFileSync(file, JSON.stringify({ smith: config.smith, provider: config.provider, model: config.model, runs, rows }, null, 2));
  console.log(`saved ${file}`);
}
shutdownSandbox();
