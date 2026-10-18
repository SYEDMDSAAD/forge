// Follow-up questions no skill fits: is it about the last answer and answerable
// from it plus general knowledge (answer now), or does it need new live data
// (learn a skill, never guess)? Needs a real provider.
//   npx tsx scripts/conversation-check.ts
import { followUp, standalone, type LastAnswer } from "../src/assistant.js";

const LAUNCH: LastAnswer = {
  question: "When is NASA's next launch?",
  skill: "get_next_launch",
  speech: "The next rocket launch is SLS Block 1: Artemis III by National Aeronautics and Space Administration on 30 Jun 2027, 5:30 am India time.",
  data: { launch: "SLS Block 1 | Artemis III", time: "2027-06-30T00:00:00Z", status: "To Be Determined", location: "Kennedy Space Center, FL, USA" },
};
const WEATHER: LastAnswer = {
  question: "What's the weather in Pune right now?",
  skill: "get_current_weather",
  speech: "It's 28 degrees in Pune right now, clear sky, humidity 50%, wind 4 km/h, no rain.",
  data: { temperature: 28, humidity: 50, wind_speed: 4, precipitation: 0 },
};
const AIR: LastAnswer = { question: "What's the air quality in Delhi?", skill: "get_air_quality", speech: "The air quality in Delhi is unhealthy, with a US AQI of 162.", data: { us_aqi: 162 } };
const MONEY: LastAnswer = { question: "Convert 100 US dollars to rupees", skill: "convert_currency", speech: "100 US dollars is about 9,678 rupees.", data: { rate: 96.78 } };

// [last answer, follow-up, answer now?]
const CASES: [LastAnswer, string, boolean][] = [
  [LAUNCH, "Is it possible that this launch will be delayed, or what happens if it fails?", true],
  [LAUNCH, "What does To Be Determined mean?", true],
  [LAUNCH, "When is ISRO's next launch?", false],
  [LAUNCH, "What's the weather at Kennedy Space Center now?", false],
  [WEATHER, "Should I carry an umbrella then?", true],
  [WEATHER, "Will it rain tomorrow?", false],
  [WEATHER, "What about Mumbai?", false],
  [AIR, "Is that safe for kids to play outside?", true],
  [AIR, "What about Bengaluru?", false],
  [MONEY, "What is an exchange rate?", true],
  [MONEY, "Was it cheaper last year?", false],
];

let passed = 0;
for (const [last, utterance, answer] of CASES) {
  const r = await followUp(utterance, last);
  if (!r) throw new Error("No model: set FORGE_PROVIDER to ollama, anthropic or bedrock");
  const ok = (r.speech !== null) === answer;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} [${last.skill}] ${utterance} -> ${r.speech === null ? "needs live data: learn a skill" : `"${r.speech}"`} (${r.ms} ms)`);
}
// Short follow-ups are rewritten as full questions before routing: [previous, follow-up, words the rewrite must have]
const REWRITES: [string, string, RegExp[]][] = [
  ["When is NASA's next launch?", "What about ISRO?", [/isro/i, /launch/i]],
  ["What's the weather in Pune right now?", "And Mumbai?", [/mumbai/i, /weather/i]],
  ["Convert 100 US dollars to rupees", "How about in euros?", [/100/, /euro/i]],
  ["What's the air quality in Delhi?", "Is that safe for kids?", []], // not elliptical: left as it is
];
for (const [previous, utterance, must] of REWRITES) {
  const q = await standalone(utterance, previous);
  const ok = must.length ? must.every((m) => m.test(q)) : q === utterance;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} after "${previous}": "${utterance}" -> "${q}"`);
}
const total = CASES.length + REWRITES.length;
console.log(`\n${passed}/${total} follow-ups handled correctly`);
process.exit(passed === total ? 0 : 1);
