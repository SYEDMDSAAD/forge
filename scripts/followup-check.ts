// Follow-up questions: Forge learns a skill for one question, then is asked
// related questions. Some the skill answers (another city, another coin) and its
// answer must be right; others only sound related (tomorrow's rain to a
// current-weather skill) and must learn a new skill instead of reusing it.
// Needs Ollama (or another provider).   npx tsx scripts/followup-check.ts [filter]
import { writeFileSync } from "node:fs";
import { route, type RouteSkill } from "../src/assistant.js";
import { forgeTool, ForgeFailed } from "../src/forge/smith.js";
import { runInSandbox, shutdownSandbox } from "../src/sandbox/sandbox.js";

type Ask = [utterance: string, expect: "use" | "new", answerMust?: RegExp];
const GROUPS: { learn: string; asks: Ask[] }[] = [
  {
    learn: "What's the weather in Pune right now?",
    asks: [
      ["What's the temperature in Delhi?", "use", /delhi/i],
      ["Will it rain in Mumbai tomorrow?", "new"],
      ["What's the air quality in Pune?", "new"],
      ["When is sunset in Pune today?", "new"],
    ],
  },
  {
    learn: "Convert 100 US dollars to rupees",
    asks: [
      ["How much is 50 euros in Japanese yen?", "use", /yen|jpy/i],
      ["What's the price of bitcoin in rupees?", "new"],
      ["What was the dollar to rupee rate in 2020?", "new"],
    ],
  },
  {
    learn: "What is the latest news about ISRO?",
    asks: [
      ["Any news on Virat Kohli?", "use", /kohli/i],
      ["What's trending on Hacker News?", "new"],
      ["When is the next rocket launch?", "new"],
    ],
  },
  {
    learn: "When is the next rocket launch?",
    asks: [
      ["When is ISRO's next launch?", "use", /isro|indian space/i],
      ["When did SpaceX last launch a rocket?", "new"],
      ["Where is the ISS right now?", "new"],
    ],
  },
  {
    learn: "What's the price of bitcoin in dollars?",
    asks: [
      ["How much is ethereum worth in rupees?", "use", /ethereum[^]*(₹|rupee|inr)/i],
      ["Convert 100 dollars to euros", "new"],
    ],
  },
  {
    learn: "What does serendipity mean?",
    asks: [
      ["Define ephemeral", "use", /ephemeral/i],
      ["Who was Albert Einstein?", "new"],
      ["Translate hello to Hindi", "new"],
    ],
  },
  {
    learn: "What's the air quality in Delhi?",
    asks: [
      ["Is the air clean in Bengaluru?", "use", /bengaluru|bangalore/i],
      ["What's the weather in Delhi?", "new"],
    ],
  },
  {
    learn: "Can you tell me the difference between merge sort and quicksort?",
    asks: [
      ["What's the difference between bubble sort and quicksort?", "use", /^(?![^]*merge)[^]*bubble/i],
      ["What's the difference between binary search and quicksort?", "use", /^(?![^]*merge)[^]*binary search/i],
      ["Who was Ada Lovelace?", "use", /lovelace/i],
      ["What's the weather in Pune?", "new"],
    ],
  },
  {
    learn: "Where is the ISS right now?",
    asks: [
      ["How many people are in space right now?", "new"],
      ["When will the ISS pass over Pune?", "new"],
    ],
  },
];

const filter = process.argv[2]?.toLowerCase();
const groups = GROUPS.filter((g) => !filter || filter.split("|").some((f) => g.learn.toLowerCase().includes(f)));
const rows: Record<string, unknown>[] = [];
let passed = 0;
let total = 0;
try {
  for (const g of groups) {
    console.log(`\nLearn: ${g.learn}`);
    let spec;
    try {
      ({ spec } = await forgeTool(g.learn));
    } catch (e) {
      if (!(e instanceof ForgeFailed)) throw e;
      console.log(`  (not built: ${e.message}; skipping its follow-ups)`);
      continue;
    }
    const skill: RouteSkill = { name: spec.name, title: spec.title, description: spec.description, inputSchema: spec.inputSchema, request: g.learn };
    console.log(`  built ${spec.name}(${Object.keys(spec.inputSchema.properties ?? {}).join(", ")})`);
    for (const [utterance, expect, answerMust] of g.asks) {
      total++;
      const r = (await route(utterance, [skill]))!;
      let ok: boolean;
      let shown: string;
      if (r.skill === null) {
        ok = expect === "new";
        shown = "learns a new skill";
      } else if (r.missing.length) {
        ok = expect === "new"; // asks the user for a value instead of answering wrongly: safe, but not an answer
        shown = `${r.skill} asks for ${r.missing.join(", ")}`;
      } else {
        const out = await runInSandbox({ mode: "run", code: spec.code, input: r.input, allowedDomains: spec.allowedDomains });
        const speech = (out.result as { speech?: string } | undefined)?.speech ?? out.error ?? "";
        ok = expect === "use" && (!answerMust || answerMust.test(speech));
        shown = `${r.skill} ${JSON.stringify(r.input)}: "${speech.slice(0, 140)}"`;
      }
      if (ok) passed++;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${utterance} -> ${shown}${ok ? "" : `  [want: ${expect === "use" ? "answered by this skill" : "a new skill"}]`}`);
      rows.push({ learn: g.learn, skill: spec.name, utterance, expect, ok, shown });
    }
  }
} finally {
  shutdownSandbox();
}
console.log(`\n${passed}/${total} follow-ups handled correctly`);
const file = `bench/followup-${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.json`;
writeFileSync(file, JSON.stringify(rows, null, 2));
console.log(`saved ${file}`);
process.exit(passed === total ? 0 : 1);
