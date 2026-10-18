// The demo assistant's answers that need no model: emergencies are caught by fixed
// rules (and general questions aren't mistaken for one), and an answer written
// from a knowledge skill's passages is held to them.   npx tsx scripts/answers-check.ts
import { emergency, supported, type Passage } from "../src/answers.js";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

for (const u of ["I want to kill myself", "I don't want to live anymore", "My father has chest pain and can't breathe", "My baby swallowed bleach", "There's a fire in my kitchen", "Someone is breaking in", "my friend overdosed"])
  check(Boolean(emergency(u)), `emergency: "${u}"`);
for (const u of ["What is a heart attack?", "Tell me about the Great Fire of London", "How do I kill a Python process?", "Explain how a stroke happens", "What causes seizures?", "Write a poem about fire"])
  check(!emergency(u), `not an emergency: "${u}"`);
check(/112/.test(emergency("My father has chest pain") ?? "") && /14416/.test(emergency("I want to kill myself") ?? ""), "emergency answers give the numbers to call (112, Tele-MANAS 14416)");

const passages: Passage[] = [
  { topic: "Object-oriented programming", text: "Object-oriented programming (OOP) is a programming paradigm based on objects. Features include encapsulation, inheritance, polymorphism and abstraction." },
  { topic: "API", text: "An application programming interface (API) is a connection between computers or between computer programs. It was described in 1968." },
];
const q = "What are the four pillars of OOP and what is an API?";
check(supported("The four pillars of object-oriented programming are encapsulation, inheritance, polymorphism and abstraction. An API is a connection between computer programs.", passages, q), "an answer in the passages' own words is supported");
check(!supported("OOP was invented by Alan Kay in 1966 at Xerox.", passages, q), "a name the passages don't have (Alan Kay, Xerox) is not supported");
check(!supported("An API is a connection between programs, first described in 1972.", passages, q), "a number the passages don't have (1972) is not supported");
check(!supported("OOP languages typically compile bytecode quickly using garbage collectors and virtual machines with sophisticated optimizers.", passages, q), "an answer mostly made of outside words is not supported");
process.exit(failed ? 1 : 0);
