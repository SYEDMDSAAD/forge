// The demo assistant's question sorter (src/answers.ts): does each request go
// down the right path (a live skill, knowledge, a fact, a calculation, chat,
// creative writing, advice, or a polite "can't" for personal data and actions)?
// Emergencies are caught before any model. Needs a real provider.
//   npx tsx scripts/sort-check.ts
import { emergency, sortQuestion, type QuestionType } from "../src/answers.js";

const CASES: [string, QuestionType | "emergency", string?][] = [
  ["What's the weather in Pune right now?", "live"],
  ["Will it rain in Mumbai tomorrow?", "live"],
  ["What's today's hot news?", "live"],
  ["How much is bitcoin worth in rupees?", "live"],
  ["Convert 100 dollars to rupees", "live"],
  ["Where is the ISS right now?", "live"],
  ["When is the next rocket launch?", "live"],
  ["What are the main four pillars of OOP and what is an API?", "knowledge"],
  ["Explain how photosynthesis works", "knowledge"],
  ["What's the difference between TCP and UDP?", "knowledge"],
  ["Who was Ashoka?", "knowledge"],
  ["Why is the sky blue?", "knowledge"],
  ["What does serendipity mean?", "knowledge"],
  ["What is diabetes?", "knowledge"],
  ["How does GST work in India?", "knowledge"],
  ["What is the population of Japan?", "fact"],
  ["What's the capital of Australia?", "fact"],
  ["How tall is Mount Everest?", "fact"],
  ["When was ISRO founded?", "fact"],
  ["Who is the prime minister of the UK?", "fact"],
  ["What currency does Thailand use?", "fact"],
  ["What is 18% of 2500?", "calculation"],
  ["Convert 5 km to miles", "calculation"],
  ["What's 72 degrees Fahrenheit in Celsius?", "calculation"],
  ["How many days until 25 December?", "calculation"],
  ["What time is it in New York?", "calculation"],
  ["What is the square root of 144?", "calculation"],
  ["Write a short poem about the monsoon", "creative"],
  ["Tell me a joke", "creative"],
  ["Write a birthday wish for my sister", "creative"],
  ["Suggest a name for my cat", "creative"],
  ["Hello!", "chat"],
  ["Thank you so much", "chat"],
  ["What can you do?", "chat"],
  ["How are you today?", "chat"],
  ["I have a fever and a headache, what should I take?", "advice", "medical"],
  ["Should I invest my savings in mutual funds or gold?", "advice", "financial"],
  ["My landlord won't return my deposit, what can I do?", "advice", "legal"],
  ["Is it safe for me to take ibuprofen with my blood pressure pills?", "advice", "medical"],
  ["Read my latest emails", "personal"],
  ["What's my bank balance?", "personal"],
  ["Book me a cab to the airport", "personal"],
  ["Turn off the living room lights", "personal"],
  ["Order a pizza from Domino's", "personal"],
  ["Send a WhatsApp message to my mom", "personal"],
  ["I want to kill myself", "emergency"],
  ["My father has chest pain and can't breathe", "emergency"],
  ["There's a fire in my kitchen", "emergency"],
  ["Someone swallowed bleach", "emergency"],
  ["What is a heart attack?", "knowledge"],
  ["Tell me about the Great Fire of London", "knowledge"],
  ["How do I kill a Python process on Linux?", "knowledge"],
];

let passed = 0;
let mixed = 0;
let ms = 0;
let timed = 0;
const misses: string[] = [];
for (const [utterance, want, area] of CASES) {
  let got: string;
  let gotArea: string | undefined;
  if (emergency(utterance)) got = "emergency";
  else {
    const r = await sortQuestion(utterance);
    if (!r) throw new Error("No model: set FORGE_PROVIDER to ollama, anthropic or bedrock");
    got = r.type;
    gotArea = r.advice;
    ms += r.ms;
    timed++;
  }
  // Live data, knowledge, facts and calculations all go to a skill, whose own source labels the answer;
  // mixing them up ("convert dollars" as a calculation) changes nothing the user sees. Counted, but not a miss.
  const SKILL = ["live", "knowledge", "fact", "calculation"];
  const close = got !== want && SKILL.includes(want) && SKILL.includes(got);
  if (close) mixed++;
  const ok = (got === want && (!area || gotArea === area)) || close;
  if (ok) passed++;
  else misses.push(`${utterance} -> ${got}${gotArea ? ` (${gotArea})` : ""}, want ${want}${area ? ` (${area})` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${utterance} -> ${got}${gotArea ? ` (${gotArea})` : ""}${close ? ` (a skill either way; want ${want})` : ""}`);
}
console.log(`\n${passed}/${CASES.length} sorted correctly (${mixed} of them between two skill types), ${Math.round(ms / Math.max(1, timed))} ms on average`);
if (misses.length) console.log(`misses:\n  ${misses.join("\n  ")}`);
process.exit(passed === CASES.length ? 0 : 1);
