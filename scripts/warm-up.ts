// Learns one skill per verified source ahead of time, so the first real
// question of each kind is answered in seconds: the code that passes is saved
// as a recipe (src/forge/recipes.ts), not installed. Each later request still
// tests it live on its own question, cross-checks it, and asks before keeping it.
//   npm run warm-up            (about 15 minutes on a laptop GPU; skips kinds already saved)
import type { SourceKind } from "../src/forge/catalog.js";
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

// One request per source, with the kind of answer the demo page's sorter would pass.
const REQUESTS: [string, SourceKind][] = [
  ["What's the weather in Pune right now?", "live"],
  ["What's the air quality in Delhi?", "live"],
  ["Where is the ISS right now?", "live"],
  ["Convert 100 US dollars to rupees", "live"],
  ["What's the price of bitcoin in dollars?", "live"],
  ["What is the latest news about ISRO?", "live"],
  ["What's trending on Hacker News?", "live"],
  ["When is the next rocket launch?", "live"],
  ["What are the next public holidays in the US?", "live"],
  ["Were there any big earthquakes today?", "live"],
  ["What are the main four pillars of OOP and what is an API?", "knowledge"],
  ["What does serendipity mean?", "knowledge"],
  ["What's the capital of Australia?", "fact"],
  ["What is 18% of 2500?", "calculation"],
  ["Convert 5 km to miles", "calculation"],
  ["How many days until 1 January 2027?", "calculation"],
  ["What time is it in Tokyo?", "calculation"],
];

const t0 = Date.now();
try {
  for (const [request, kind] of REQUESTS) {
    const t = Date.now();
    let reused = false;
    try {
      const { spec } = await forgeTool(
        request,
        (e) => {
          if (e.message.startsWith("Found code")) reused = true;
        },
        kind,
      );
      console.log(`${reused ? "already saved" : "saved"}  ${spec.name}  (${Math.round((Date.now() - t) / 1000)} s)  ${request}`);
    } catch (e) {
      if (!(e instanceof ForgeFailed)) throw e;
      console.log(`not built  (${Math.round((Date.now() - t) / 1000)} s)  ${request}: ${e.message}`);
    }
  }
} finally {
  shutdownSandbox();
}
console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)} s`);
