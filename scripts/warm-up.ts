// Learns one skill per verified source ahead of time, so the first real
// question of each kind is answered in seconds: the code that passes is saved
// as a recipe (src/forge/recipes.ts), not installed. Each later request still
// tests it live on its own question, cross-checks it, and asks before keeping it.
//   npm run warm-up            (about 10 minutes on a laptop GPU; skips kinds already saved)
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

const REQUESTS = [
  "What's the weather in Pune right now?",
  "What's the air quality in Delhi?",
  "Where is the ISS right now?",
  "Convert 100 US dollars to rupees",
  "What's the price of bitcoin in dollars?",
  "Who was Ada Lovelace?",
  "What is the latest news about ISRO?",
  "What's trending on Hacker News?",
  "What does serendipity mean?",
  "When is the next rocket launch?",
  "What are the next public holidays in the US?",
  "Were there any big earthquakes today?",
];

const t0 = Date.now();
try {
  for (const request of REQUESTS) {
    const t = Date.now();
    let reused = false;
    try {
      const { spec } = await forgeTool(request, (e) => {
        if (e.message.startsWith("Found code")) reused = true;
      });
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
