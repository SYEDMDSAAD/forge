// The second live test: a skill is also run with different input values, and an
// answer that still names the first ones (here the word "serendipity") means
// that value is fixed in its code, so the skill is not kept.
//   npx tsx scripts/fixed-value-check.ts
import { catalogById } from "../src/forge/catalog.js";
import { buildSpec, type Plan } from "../src/forge/guided.js";
import { testSpec } from "../src/forge/smith.js";
import { shutdownSandbox } from "../src/sandbox/sandbox.js";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const plan: Plan = {
  feasible: true,
  reason: "",
  source: "dictionary",
  name: "get_definition",
  title: "Definition",
  description: "The meaning of an English word.",
  inputs: [{ name: "word", type: "string", description: "the word", example: "serendipity", another_example: "ephemeral" }],
};
const code = (said: string) => `export default async function run({ word }) {
  const res = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word));
  const d = (await res.json())[0].meanings[0].definitions[0].definition;
  return { speech: ${said} + " means " + d };
}`;

try {
  const spec = buildSpec("What does serendipity mean?", plan, catalogById.get("dictionary")!, code("word"));
  check(spec.tests.length === 2 && spec.tests[1].input.word === "ephemeral", "the skill gets a second test with another word");
  const honest = await testSpec(spec);
  check(honest.passed, "a skill that uses its input passes both tests");
  const fixed = await testSpec(buildSpec("What does serendipity mean?", plan, catalogById.get("dictionary")!, code('"Serendipity"')));
  check(!fixed.passed && fixed.results[0].passed && !fixed.results[1].passed, "a skill that always says serendipity passes the first test but fails the second");
} finally {
  shutdownSandbox();
}
process.exit(failed ? 1 : 0);
