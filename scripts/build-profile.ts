// Where a from-scratch build spends its time: each build-log step with the
// seconds since the previous one. Needs Ollama.   npx tsx scripts/build-profile.ts ["request" ...]
process.env.FORGE_RECIPES ??= "0";
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

const requests = process.argv.slice(2).length ? process.argv.slice(2) : ["What does serendipity mean?", "What are the next public holidays in the US?"];
try {
  for (const request of requests) {
    console.log(`\n${request}`);
    const t0 = performance.now();
    let last = t0;
    const line = (msg: string) => {
      const now = performance.now();
      console.log(`  +${((now - last) / 1000).toFixed(1).padStart(5)} s  ${msg.replace(/\s+/g, " ").slice(0, 150)}`);
      last = now;
    };
    try {
      await forgeTool(request, (e) => line(`[${e.stage}] ${e.message}`));
      line("done");
    } catch (e) {
      if (!(e instanceof ForgeFailed)) throw e;
      line(`not built: ${e.message}`);
    }
    console.log(`  total ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  shutdownSandbox();
}
