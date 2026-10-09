// Run the smith directly: npx tsx scripts/forge-cli.ts "tell me when the next ISS pass over Pune is"
import { forgeTool } from "../src/forge/smith.js";

const request = process.argv.slice(2).join(" ") || "What's the air quality in Delhi right now?";
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const { spec, report, attempts } = await forgeTool(request, (e) => console.log(`${stamp()} [${e.stage}] ${e.message}`));
console.log(`\n${stamp()} built ${spec.name} in ${attempts} attempt(s); domains: ${spec.allowedDomains.join(", ")}`);
for (const r of report.results) console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name}: ${JSON.stringify((r.result as any)?.speech)}`);
console.log("\n" + spec.code);
