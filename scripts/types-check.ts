// End to end for each kind of answer: knowledge (passages, then an answer written
// from them and checked), exact facts, calculations, and live data. Each request
// is learned (or reuses a saved recipe), run on its own question, and its answer
// is checked for the right content. Needs Ollama.   npx tsx scripts/types-check.ts [filter]
import { composeAnswer } from "../src/answers.js";
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

type Kind = "knowledge" | "fact" | "calculation" | "live";
const CASES: [Kind, string, RegExp][] = [
  ["knowledge", "What are the main four pillars of OOP and what is an API?", /encapsulation[^]*(api|application programming interface)/i],
  ["knowledge", "Explain how photosynthesis works", /light[^]*(energy|chemical)/i],
  ["knowledge", "What's the difference between TCP and UDP?", /(TCP|Transmission Control)[^]*(UDP|User Datagram)/i],
  ["knowledge", "Who was Ada Lovelace?", /mathematician/i],
  ["knowledge", "Why is the sky blue?", /scatter/i],
  ["fact", "What's the capital of Australia?", /canberra/i],
  ["fact", "What is the population of Japan?", /12,3\d,\d\d,\d\d\d|123,\d{3},\d{3}/],
  ["fact", "How tall is Mount Everest?", /8,84[89]/],
  ["fact", "When was ISRO founded?", /1969/],
  ["fact", "What currency does Thailand use?", /baht/i],
  ["calculation", "What is 18% of 2500?", /\b450\b/],
  ["calculation", "Convert 5 km to miles", /3\.11/],
  ["calculation", "What's 72 degrees Fahrenheit in Celsius?", /22\.2/],
  ["calculation", "How many days until 1 January 2027?", /\b\d+ days\b/],
  ["calculation", "What time is it in Tokyo?", /tokyo/i],
  ["live", "What's the weather in Pune right now?", /pune[^]*°C/i],
  ["live", "Convert 100 US dollars to rupees", /INR|rupee/i],
];

const filter = process.argv[2]?.toLowerCase();
const cases = CASES.filter(([kind, q]) => !filter || filter.split("|").some((f) => kind === f || q.toLowerCase().includes(f)));
const byKind = new Map<Kind, { ok: number; n: number; seconds: number[] }>();
try {
  for (const [kind, request, must] of cases) {
    const t0 = Date.now();
    let speech = "";
    let how = "";
    try {
      // As the demo page does: the sorter's kind of answer is a hint for picking the source.
      const { spec, report } = await forgeTool(request, () => {}, kind);
      const result = report.results[0]?.result as { speech?: string; data?: { passages?: { topic: string; text: string }[] } } | undefined;
      speech = result?.speech ?? "";
      how = spec.name;
      const passages = result?.data?.passages;
      if (passages?.length) {
        const c = await composeAnswer(request, passages);
        if (c?.checked) speech = c.speech;
        how += c?.checked ? ", written from the passages and checked" : ", the article's own words";
      }
    } catch (e) {
      if (!(e instanceof ForgeFailed)) throw e;
      speech = `(not built: ${e.message})`;
    }
    const s = (Date.now() - t0) / 1000;
    const ok = !speech.startsWith("(not built") && must.test(speech);
    const row = byKind.get(kind) ?? { ok: 0, n: 0, seconds: [] };
    row.n++;
    if (ok) row.ok++;
    row.seconds.push(s);
    byKind.set(kind, row);
    console.log(`${ok ? "PASS" : "FAIL"} ${s.toFixed(0).padStart(3)} s  [${kind}] ${request}\n           ${how}: "${speech.slice(0, 220)}"`);
  }
} finally {
  shutdownSandbox();
}
console.log("");
for (const [kind, r] of byKind) {
  const sorted = [...r.seconds].sort((a, b) => a - b);
  console.log(`${kind}: ${r.ok}/${r.n} right, median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} s`);
}
