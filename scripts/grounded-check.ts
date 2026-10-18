// A follow-up answer may only repeat numbers from the last answer; a new one
// means it was made up, so the page learns a skill instead.   npx tsx scripts/grounded-check.ts
import { grounded } from "../src/assistant.js";

const context = 'Your last answer: "The air quality in Delhi is unhealthy, with a US AQI of 162." The user now asks: "What about Bengaluru?"';
const cases: [string, boolean][] = [
  ["No, with an AQI of 162 it's not safe for kids to play outside.", true],
  ["The air quality in Bengaluru is moderate at 85.", false],
  ["ISRO's next launch is on 21 July 2023.", false],
  ["I don't have information about tomorrow's forecast.", false],
  ["To know that, we'd need last year's rate.", false],
  ["To answer that, we need the exchange rate from then.", false],
  ["Delays happen for two or three reasons: weather and technical checks.", true],
];
let failed = false;
for (const [speech, want] of cases) {
  const ok = grounded(speech, context) === want;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${want ? "kept" : "rejected"}: ${speech}`);
}
process.exit(failed ? 1 : 0);
