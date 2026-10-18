// How fast a new question is answered when a recipe for its kind of skill was
// saved earlier (npm run warm-up), and whether the reused code still answers it
// right. Needs Ollama (or another provider).   npx tsx scripts/recipe-check.ts
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

const ASKS: [string, RegExp][] = [
  ["What does ephemeral mean?", /ephemeral/i],
  ["Any news on Virat Kohli?", /kohli/i],
  ["How much is ethereum worth in rupees?", /ethereum[^]*inr/i],
  ["What's the difference between bubble sort and quicksort?", /bubble/i],
  ["How is the air in Mumbai today?", /mumbai/i],
  ["How hot is it in Chennai right now?", /chennai/i],
  ["When are the next public holidays in Germany?", /./],
  ["How much is 50 euros in yen?", /jpy|yen/i],
];
const times: number[] = [];
let reusedCount = 0;
let right = 0;
try {
  for (const [request, must] of ASKS) {
    const t0 = Date.now();
    let reused = false;
    try {
      const { spec, report } = await forgeTool(request, (e) => {
        if (e.message.startsWith("Found code")) reused = true;
        if (e.stage === "repair" && /didn't pass this time/.test(e.message)) reused = false;
      });
      const s = (Date.now() - t0) / 1000;
      times.push(s);
      if (reused) reusedCount++;
      const speech = (report.results[0]?.result as { speech?: string })?.speech ?? "";
      const ok = must.test(speech);
      if (ok) right++;
      console.log(`${ok ? "PASS" : "FAIL"} ${s.toFixed(0).padStart(3)} s ${reused ? "reused " : "written"} ${spec.name}: ${request} -> "${speech.slice(0, 110)}"`);
    } catch (e) {
      if (!(e instanceof ForgeFailed)) throw e;
      console.log(`FAIL not built: ${request}: ${e.message}`);
    }
  }
} finally {
  shutdownSandbox();
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`\n${right}/${ASKS.length} right, ${reusedCount} reused saved code; median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} s, slowest ${sorted.at(-1)?.toFixed(0)} s`);
