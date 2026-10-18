// Guided smith for small local models (FORGE_SMITH=guided, the default with
// Ollama). Instead of one open-ended agent loop it runs short, structured
// steps: pick a verified source -> look at real responses -> fill in a code
// template -> repair from test failures. Every reply is constrained to a JSON
// schema by Ollama, so a 7B model can't wander off or send malformed calls.
import { config } from "../config.js";
import { askOllama as ask } from "../llm.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import { CATALOG, catalogById, isGeneric, namedIn, type Source, type SourceKind } from "./catalog.js";
import { createHash } from "node:crypto";
import { designedRecipes, loadRecipe, recipeKey, saveRecipe } from "./recipes.js";
import { ForgeFailed, testSpec, type SmithResult } from "./smith.js";
import type { ForgeEvent, TestReport, ToolSpec } from "./types.js";
import { fixApostrophes, syntaxError, validateSpec } from "./validate.js";

export interface Plan {
  feasible: boolean;
  reason: string;
  source: string;
  name: string;
  title: string;
  description: string;
  inputs: { name: string; type: "string" | "number"; description: string; example: string; another_example?: string; optional?: boolean }[];
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    feasible: { type: "boolean" },
    reason: { type: "string" },
    source: { type: "string", enum: [...CATALOG.map((s) => s.id), "none"] },
    name: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    inputs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["string", "number"] },
          description: { type: "string" },
          example: { type: "string" },
          another_example: { type: "string" },
        },
        required: ["name", "type", "description", "example", "another_example"],
      },
    },
  },
  required: ["feasible", "reason", "source", "name", "title", "description", "inputs"],
};

const CODE_SCHEMA = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };

const REVIEW_SCHEMA = {
  type: "object",
  properties: { natural: { type: "boolean" }, problem: { type: "string" } },
  required: ["natural", "problem"],
};

/** The model listens to its own answer once; judging a sentence is easier for it than writing one. */
async function reviewSpeech(request: string, speech: string): Promise<string | null> {
  const review = await ask<{ natural: boolean; problem: string }>(
    SYSTEM,
    `The user asked a voice assistant: "${request}"
The assistant will say exactly: "${speech}"

Is that a natural, grammatical English answer to the question, with nothing garbled, missing or repeated? Minor style is fine.
Set natural=true unless there is a clear problem. If natural=false, describe the problem in one sentence.`,
    REVIEW_SCHEMA,
  );
  return review.natural ? null : review.problem || "the sentence is not natural English";
}

// Checks every skill must pass on the example input (which is a valid request,
// so "sorry, not found" is a failure there). Kept in sync with speechProblems().
const questionOf = (request: string) => request.toLowerCase().replace(/[?.!\s]+$/, "");
// "Nothing found" or an error on a valid example means the URL or parsing is wrong.
// Placeholders and empty list items: "Unknown headline", "No title", "launched,,."
const PLACEHOLDER = "\\b(unknown|untitled|no title|n\\/a)\\b|,\\s*,|,\\s*\\.|:\\s*\\.";
const NOTHING = "\\berror\\b|\\bfailed\\b|not found|\\bno\\b[^.]{0,40}\\bfound\\b|no (data|results|information)\\b|not available|please provide|\\binvalid\\b";

// An encyclopedia's own words can say "error", "null hypothesis", "unknown origin" or "unable": for a knowledge
// skill (whose answer quotes the article, which the cross-check verifies) only these failures count.
const KNOWLEDGE_NOTHING = "wasn.?t found|not found on|no (article|results)\\b";

export function speechAssert(request: string, kind?: string): string {
  if (kind === "knowledge")
    return [
      "typeof result.speech === 'string' && result.speech.length >= 15",
      "!/\\[object\\b/.test(result.speech)",
      `!/${KNOWLEDGE_NOTHING}/i.test(result.speech)`,
      "!/,\\s*,|,\\s*\\./.test(result.speech)",
      `!result.speech.toLowerCase().includes(${JSON.stringify(questionOf(request))})`,
    ].join(" && ");
  return [
    "typeof result.speech === 'string' && result.speech.length >= 15",
    "!/undefined|NaN|\\[object\\b|\\bnull\\b/.test(result.speech)",
    "!/sorry|couldn.?t|could not|unable|not find|apolog|can.?t be (converted|done|found)/i.test(result.speech)",
    `!/${NOTHING}/i.test(result.speech)`,
    `!/${PLACEHOLDER}/i.test(result.speech)`,
    "!/\\?\\s*$/.test(result.speech)",
    "!/\\d\\.\\d{3,}/.test(result.speech)",
    `!result.speech.toLowerCase().includes(${JSON.stringify(questionOf(request))})`,
  ].join(" && ");
}

/** Plain-language reasons a result fails SPEECH_OK, so the model knows what to fix. */
function speechProblems(result: unknown, request: string, kind?: string): string[] {
  const r = (result ?? {}) as { speech?: unknown; data?: unknown };
  if (typeof r.speech !== "string") return ["run() must return an object with a speech string"];
  const p: string[] = [];
  if (kind === "knowledge") {
    if (r.speech.length < 15) p.push("speech is too short; say the article's summary");
    if (/\[object\b/.test(r.speech)) p.push("speech contains [object Object]: a field name is wrong; use the exact fields from the example response");
    if (new RegExp(KNOWLEDGE_NOTHING, "i").test(r.speech)) p.push("speech says the topic wasn't found, but the example topic exists: the search or the parsing is wrong");
    if (/,\s*,|,\s*\./.test(r.speech)) p.push("speech has empty items (',,'): the fields are read wrongly");
    if (r.speech.toLowerCase().includes(questionOf(request))) p.push("speech repeats the user's question; say only the answer");
    return p;
  }
  if (r.speech.length < 15) p.push("speech is too short; say the actual answer in a full sentence");
  // "[object Object]" may reach here as "[object]": the tidy-up merges repeated words.
  if (/undefined|NaN|\[object\b|\bnull\b/.test(r.speech)) p.push("speech contains undefined/NaN/null/[object Object]: a field name is wrong; use the exact fields from the example response");
  if (/sorry|couldn.?t|could not|unable|not find|apolog|can.?t be (converted|done|found)/i.test(r.speech))
    p.push("speech is an apology, but the example input is valid: the request or the parsing is wrong (check the URL and field names against the example response)");
  if (new RegExp(NOTHING, "i").test(r.speech))
    p.push("speech says nothing was found or an error happened, but the example input is valid: the request or the parsing is wrong (check the URL, the parameter format such as country codes, and field names against the example response)");
  if (new RegExp(PLACEHOLDER, "i").test(r.speech))
    p.push("speech has placeholders or empty items (Unknown, No title, ',,'): the fields are read wrongly; take them from the exact structure of the example response");
  if (/\?\s*$/.test(r.speech)) p.push("speech must end with an answer, not a question");
  if (/\d\.\d{3,}/.test(r.speech)) p.push("round the numbers in speech (Math.round, or toFixed(1) for small values)");
  if (r.speech.toLowerCase().includes(questionOf(request))) p.push("speech repeats the user's question; say only the answer");
  return p;
}

const SYSTEM = "You build small, reliable tools for a voice assistant. Reply only with JSON matching the given schema.";

const KIND_WORDS: Record<SourceKind, string> = { live: "live data", knowledge: "an explanation", fact: "one exact fact", calculation: "a calculation" };
/** The assistant's own view of what kind of answer this needs: a hint for picking the source. */
function kindHint(kind?: SourceKind): string {
  if (!kind) return "";
  const ids = CATALOG.filter((s) => (s.kind ?? "live") === kind).map((s) => s.id);
  return ids.length ? `The assistant expects ${KIND_WORDS[kind]}; the sources that give that are ${ids.join(", ")}: prefer one of them.\n` : "";
}

function catalogMenu(): string {
  return CATALOG.map((s) => `- ${s.id}: ${s.useFor}`).join("\n");
}

function sourceDocs(src: Source): string {
  const eps = src.endpoints.map((e) => `GET ${e.url}\n  returns ${e.returns}`).join("\n");
  return `${eps}${src.notes ? `\nNotes: ${src.notes}` : ""}`;
}

function compact(body: string, max = 1400): string {
  let out = body;
  try {
    out = JSON.stringify(JSON.parse(body));
  } catch {
    // RSS: the stories, not the channel header, are what the code has to read.
    const first = body.indexOf("<item>");
    if (first > 0) out = body.slice(first);
  }
  return out.length > max ? out.slice(0, max) + " …(truncated)" : out;
}

async function samples(src: Source, onEvent: (e: ForgeEvent) => void): Promise<string> {
  const parts: string[] = [];
  for (const ep of src.endpoints) {
    const host = new URL(ep.example).hostname;
    onEvent({ stage: "probe", message: `Looking at ${host}` });
    const out = await runInSandbox({ mode: "probe", url: ep.example, allowedDomains: [host] });
    parts.push(`Example: GET ${ep.example}\nResponse ${out.ok ? `(${out.status}): ${compact(String(out.body ?? ""))}` : `failed: ${out.error}`}`);
  }
  return parts.join("\n\n");
}

const CONTRACT = `Write one JavaScript ES module:

export default async function run(input) {
  // read inputs, e.g. const { city } = input;
  // call ONLY the URLs documented above with fetch(); wrap inputs in encodeURIComponent()
  // const res = await fetch(url); if (!res.ok) return { speech: "a helpful sorry sentence" };
  // const json = await res.json();
  return { speech: "One or two short natural sentences with the real answer.", data: { /* a few key fields */ } };
}

Rules:
- No import or require. Only fetch and built-in JavaScript.
- When something isn't found (a 404, an empty list), return a helpful speech sentence instead.
- No try/catch around the whole function: an unexpected error must surface so it can be fixed (Forge reports a source that is down by itself).
- The same code must work for any input: never write the example values (a city, a word, a code) into the code or the speech; always use the input variables.
- speech is spoken aloud: a complete sentence that answers with the actual values (never repeat the question). Round numbers (format big ones with toLocaleString('en-IN')). No URLs, no markdown.
- Write strings with backticks (template literals) or double quotes, never single quotes, so apostrophes like "don't" are safe. Where the Notes join strings with +, copy that exactly: don't turn it into one template literal.
- Use the exact field names shown in the example responses.`;

function toSnake(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return /^[a-z][a-z0-9_]{2,}$/.test(out) ? out : `skill_${out || "custom"}`.slice(0, 48);
}

// A code fixed in the code is often said as its name ("dollars", "the US").
const NAMES: Record<string, string[]> = {
  usd: ["dollar"], inr: ["rupee"], eur: ["euro"], gbp: ["pound"], jpy: ["yen"], chf: ["franc"],
  us: ["united states", "america"], gb: ["united kingdom", "britain"], de: ["germany"], fr: ["france"], jp: ["japan"], in: ["india"],
};
const spoken = (v: string) => [v.toLowerCase(), ...(NAMES[v.toLowerCase()] ?? [])];
// Short values that are everyday words, so their presence proves nothing.
const COMMON = new Set(["in", "a", "an", "it", "is", "on", "at", "to", "no"]);
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildSpec(request: string, plan: Plan, src: Source, code: string): ToolSpec {
  const properties: Record<string, unknown> = {};
  const input: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of plan.inputs) {
    const key = toSnake(i.name);
    properties[key] = { type: i.type, description: i.description };
    if (!i.optional) required.push(key);
    if (!i.optional || i.example.trim()) input[key] = i.type === "number" ? Number(i.example) : i.example;
  }
  const tests: ToolSpec["tests"] = [{ name: "example", input, assert: speechAssert(request, src.kind), ...(src.reference ? { reference: src.reference } : {}) }];
  // The same skill with different values: an answer that still names the first
  // ones (a word, a coin, a city) has them fixed in its code.
  const other: Record<string, unknown> = { ...input };
  for (const i of plan.inputs) {
    const key = toSnake(i.name);
    const another = i.another_example?.trim();
    // An optional value the user gave is left out of the second test, so the code's other branch (no value) is tested too.
    if (i.optional && String(input[key] ?? "").trim()) delete other[key];
    else if (i.type === "string" && another && another.toLowerCase() !== String(input[key] ?? "").toLowerCase()) other[key] = another;
  }
  const others = Object.values(other).map((v) => String(v).toLowerCase());
  const fixed = Object.entries(input).filter(([k, v]) => typeof v === "string" && v.trim().length >= 2 && k in other && other[k] !== v && !others.some((o) => o.includes(v.toLowerCase())));
  if (JSON.stringify(other) !== JSON.stringify(input))
    tests.push({
      name: "another input",
      input: other,
      assert: [speechAssert(request, src.kind), ...fixed.flatMap(([, v]) => spoken(String(v))).filter((w) => !COMMON.has(w)).map((w) => `!/\\b${escape(w)}${w.length <= 3 ? "\\b" : ""}/i.test(result.speech)`)].join(" && "),
      ...(src.reference ? { reference: src.reference } : {}),
    });
  const description = plan.description.length >= 20 ? plan.description : `${plan.description || plan.title}. Use for ${src.useFor}.`;
  return {
    name: toSnake(plan.name),
    title: plan.title || plan.name,
    description,
    inputSchema: { type: "object", properties, required },
    code,
    allowedDomains: src.domains,
    tests,
    sources: [src.name],
  };
}

function describeFailure(report: TestReport, request: string, spec: ToolSpec): string {
  return report.results
    .filter((r) => !r.passed)
    .map((r) => {
      const test = spec.tests.find((t) => t.name === r.name);
      const problems = r.result !== undefined && r.error?.startsWith("Assertion") ? speechProblems(r.result, request, catalogBySourceName(spec)) : [];
      if (!problems.length && r.name === "another input" && r.error?.startsWith("Assertion")) {
        const first = Object.values(spec.tests[0].input).filter((v) => typeof v === "string");
        problems.push(`with the input ${JSON.stringify(test?.input)} the answer still mentions ${first.map((v) => JSON.stringify(v)).join(" or ")} from the first example: the code has a value fixed in it; use the input instead`);
      }
      const why = `Test with input ${JSON.stringify(test?.input ?? {})}:\n${problems.length ? problems.map((p) => `- ${p}`).join("\n") : (r.error ?? "failed")}`;
      return `${why}${r.result !== undefined ? `\nIt returned: ${JSON.stringify(r.result).slice(0, 600)}` : ""}`;
    })
    .concat(report.logs ? [`console output: ${report.logs.slice(0, 600)}`] : [])
    .join("\n");
}

/** The kind of the source a spec was built from (its cited name). */
const catalogBySourceName = (spec: ToolSpec) => CATALOG.find((s) => spec.sources?.includes(s.name) && s.domains.join() === spec.allowedDomains.join())?.kind;

/**
 * The code works (its second test, with other values, passed) but the source has
 * nothing for the user's own values: rewriting the code can't help, so say so now.
 */
function inputProblem(report: TestReport, spec: ToolSpec, src: Source): void {
  // Only a looked-up name (a topic, a city, a word) can be missing at the source; a calculation can't.
  if (!src.tool?.inputs.some((i) => i.fromRequest)) return;
  const [mine, other] = report.results;
  const said = (mine?.result as { speech?: string } | undefined)?.speech ?? "";
  const nothing = new RegExp(src.kind === "knowledge" ? KNOWLEDGE_NOTHING : NOTHING, "i");
  if (!mine || mine.passed || !other?.passed || (!nothing.test(said) && !/wasn.?t found|couldn.?t find|not on /i.test(said))) return;
  const names = new Set(src.tool?.inputs.filter((i) => i.fromRequest).map((i) => i.name));
  const asked = Object.entries(spec.tests[0].input).filter(([k, v]) => names.has(k) && typeof v === "string" && v.trim()).map(([, v]) => v).join(" and ");
  throw new ForgeFailed(`${src.name} has nothing for "${asked}". Try asking about one thing at a time, by its name: for example "What is an API?"`);
}

/** What the live test asked and answered, and what the cross-check compared, for the build log. */
function tellResult(spec: ToolSpec, report: TestReport, source: string, onEvent: (e: ForgeEvent) => void) {
  const r = report.results[0];
  const speech = (r?.result as { speech?: string } | undefined)?.speech;
  if (speech) onEvent({ stage: "test", message: `Test ${JSON.stringify(spec.tests[0].input)} answered: "${speech.slice(0, 160)}"` });
  const r2 = report.results[1];
  const speech2 = (r2?.result as { speech?: string } | undefined)?.speech;
  if (speech2 && spec.tests[1]) onEvent({ stage: "test", message: `Second test ${JSON.stringify(spec.tests[1].input)}, to check nothing is fixed in the code, answered: "${speech2.slice(0, 120)}"` });
  const c = r?.crossCheck;
  if (typeof c?.said === "string") onEvent({ stage: "test", message: `Cross-check: the answer names "${c.said}", listed by ${source} in the response it read` });
  else if (c?.source !== undefined) onEvent({ stage: "test", message: `Cross-check: the answer says ${c.said}, ${source} says ${c.source}${r.passed ? ", a match" : ""}` });
  else if (c?.skipped) onEvent({ stage: "test", message: `Cross-check skipped: ${c.skipped}` });
}

// Currency and country names a small model gives instead of the code an input asks for.
const CODES: Record<string, string> = {
  rupee: "INR", rupees: "INR", dollar: "USD", dollars: "USD", "us dollar": "USD", "us dollars": "USD", euro: "EUR", euros: "EUR",
  pound: "GBP", pounds: "GBP", yen: "JPY", "japanese yen": "JPY", franc: "CHF", francs: "CHF", dirham: "AED", dirhams: "AED",
  "united states": "US", usa: "US", america: "US", "united kingdom": "GB", uk: "GB", britain: "GB", germany: "DE", france: "FR", japan: "JP",
};
// Unit names a small model gives instead of the unit code an input asks for.
const UNIT_CODES: Record<string, string> = {
  fahrenheit: "f", celsius: "c", centigrade: "c", kelvin: "k", "degrees fahrenheit": "f", "degrees celsius": "c",
  metre: "m", metres: "m", meter: "m", meters: "m", kilometre: "km", kilometres: "km", kilometer: "km", kilometers: "km", centimetre: "cm", centimetres: "cm", centimeters: "cm", millimetres: "mm", millimeters: "mm",
  mile: "mi", miles: "mi", yard: "yd", yards: "yd", foot: "ft", feet: "ft", inch: "in", inches: "in",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", gram: "g", grams: "g", milligram: "mg", milligrams: "mg", pound: "lb", pounds: "lb", lbs: "lb", ounce: "oz", ounces: "oz", tonne: "t", tonnes: "t", ton: "t", tons: "t",
  litre: "l", litres: "l", liter: "l", liters: "l", millilitre: "ml", millilitres: "ml", milliliters: "ml", gallon: "gal", gallons: "gal", cups: "cup",
  "km/h": "kmh", kph: "kmh", "kilometres per hour": "kmh", "kilometers per hour": "kmh", "miles per hour": "mph", "m/s": "ms", "metres per second": "ms", knots: "kn", knot: "kn",
  "square metres": "m2", "square meters": "m2", "square kilometres": "km2", "square kilometers": "km2", hectare: "ha", hectares: "ha", acres: "acre", "square feet": "ft2",
  byte: "b", bytes: "b", kilobytes: "kb", megabytes: "mb", gigabytes: "gb", terabytes: "tb",
};

function codeOf(value: string, description: string): string {
  if (/\bunit code\b/i.test(description)) return UNIT_CODES[value.toLowerCase().replace(/^degrees? /, "degrees ")] ?? UNIT_CODES[value.toLowerCase()] ?? value;
  if (!/\bcode\b/i.test(description)) return value;
  const code = CODES[value.toLowerCase()];
  if (!code) return value;
  return /lowercase/i.test(description) ? code.toLowerCase() : code;
}

/** Turns the plan into the source's one general skill, keeping the user's topic as the test example. */
async function generalTool(request: string, plan: Plan, tool: NonNullable<Source["tool"]>) {
  // Without the examples ("e.g. India cricket"), which a small model tends to copy.
  // Only for free text: a code's examples ("e.g. usd or inr") show the format it needs.
  // The question itself isn't extracted: it is the request, word for word.
  const asked = tool.inputs.filter((i) => !i.wholeRequest);
  const today = `Today is ${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}.`;
  const schema = { type: "object", properties: Object.fromEntries(asked.map((i) => [i.name, { type: "string" }])), required: asked.map((i) => i.name) };
  const field = (i: (typeof tool.inputs)[number]) => `- ${i.name}: ${i.fromRequest ? i.description.replace(/,?\s*e\.g\.[^;]*/, "") : i.description}`;
  const extract = (strict: boolean) =>
    ask<Record<string, string>>(
      "You extract the values a request names.",
      `${today} The user asked: "${request}"\n\nFor each field give the value from the request${asked.some((i) => i.optional) ? ", or an empty string when the user didn't name it" : ""}${
        strict ? ". Copy the user's own words exactly" : ""
      }${asked.filter((i) => i.fromRequest).length > 1 ? ". If the user asks about two things, put the second one in the second field" : ""}:\n${asked.map(field).join("\n")}`,
      schema,
      0,
    );
  // A topic or city the user didn't say was made up: none of its words is in the request,
  // and it isn't what the user's abbreviation stands for (OOP → Object-Oriented Programming).
  const words = request.toLowerCase();
  const said = (value: string) => {
    const parts = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const initials = parts.map((w) => w[0]).join("");
    return parts.some((w) => w.length > 1 && words.includes(w)) || (initials.length > 1 && new RegExp(`\\b${initials}\\b`).test(words));
  };
  const madeUp = (v: Record<string, string>) => tool.inputs.some((i) => i.fromRequest && v[i.name]?.trim() && !said(v[i.name]));
  // A whole sentence is not a topic or a city ("what are the main four pillars of the OOP and what is API").
  const tooLong = (v: Record<string, string>) => tool.inputs.some((i) => i.fromRequest && (v[i.name] ?? "").trim().split(/\s+/).length > 6);
  const short = () =>
    ask<Record<string, string>>(
      "You extract the values a request names.",
      `${today} The user asked: "${request}"\n\nGive each topic, place or name as a short name of one to four words (like a Wikipedia article title or a city name), never a sentence or a question.${
        asked.filter((i) => i.fromRequest).length > 1 ? " If the user asks about two things, put the second one in the second field." : ""
      }${asked.some((i) => i.optional) ? " Use an empty string for a field the user didn't name." : ""}\n${asked.map(field).join("\n")}`,
      schema,
      0,
    );
  let values: Record<string, string> = !asked.length ? {} : await extract(false);
  if (tooLong(values)) values = await short();
  if (madeUp(values)) values = await extract(true);
  if (tooLong(values)) values = await short();
  // "...OOP and what is API": a second question, but no second topic came out.
  const [, second] = asked.filter((i) => i.fromRequest);
  if (second && !values[second.name]?.trim() && /\b(and|also|plus) (what|who|how|why|where|when|which)\b/i.test(request)) {
    const [first] = asked.filter((i) => i.fromRequest);
    // Only the two names, nothing else to fill: the small model gets this one right.
    const two = await ask<Record<string, string>>(
      "You extract the values a request names.",
      `The user asked: "${request}"\n\nThe user asks about two things. Give each as a short name of one to four words, like a Wikipedia article title:\n- ${first.name}: the first thing\n- ${second.name}: the second thing`,
      { type: "object", properties: { [first.name]: { type: "string" }, [second.name]: { type: "string" } }, required: [first.name, second.name] },
      0,
    );
    if (two[second.name]?.trim() && said(two[second.name])) values = { ...values, [second.name]: two[second.name] };
  }
  // A required topic that came out empty ("I have a fever, what should I take?" names no article): ask for a short name.
  const empty = asked.filter((i) => i.fromRequest && !i.optional && !values[i.name]?.trim());
  if (empty.length) {
    const again = await short();
    for (const i of empty) if (again[i.name]?.trim()) values = { ...values, [i.name]: again[i.name] };
  }
  if (madeUp(values)) values = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, tool.inputs.find((i) => i.name === k)?.fromRequest && !said(v) ? "" : v]));
  // A field with a known list of values the model left empty ("When is NASA's next launch?"): take it from the request.
  for (const i of asked) {
    if (values[i.name]?.trim() || !i.known) continue;
    const hit = namedIn(request, i.known);
    if (hit) values = { ...values, [i.name]: hit };
  }
  // Still no topic ("I have a fever and a headache, what should I take?"): the guessed search words the user
  // actually said become the topics (fever, then headache).
  const spoken = (values.keywords ?? "").split(/[^A-Za-z0-9-]+/).filter((w) => w.length > 2 && new RegExp(`\\b${w.toLowerCase()}\\b`).test(words));
  for (const i of asked.filter((x) => x.fromRequest)) {
    if (values[i.name]?.trim() || !spoken.length) continue;
    if (i.optional && !/\band\b|\bor\b|\bvs\b/i.test(request)) continue;
    values = { ...values, [i.name]: spoken.shift()! };
  }
  Object.assign(plan, {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputs: tool.inputs.map((i) => {
      const raw = i.wholeRequest ? request.trim() : codeOf(values[i.name]?.trim() ?? "", i.description);
      const said = i.generic && isGeneric(raw) ? "" : raw;
      // With nothing extracted, the request itself is only a usable value when it is short.
      const fallback = !i.fromRequest || i.optional || request.trim().split(/\s+/).length > 6 ? "" : request;
      const example = i.type === "number" ? String(Number(said.replace(/[^0-9.]/g, "")) || 1) : said || fallback;
      const another = i.another.find((a) => a.toLowerCase() !== example.toLowerCase());
      return { name: i.name, type: i.type ?? "string", description: i.description, example, another_example: another, optional: i.optional };
    }),
  });
}

/** Skills written before for sources without a general tool: reusing one's exact name and inputs reuses its tested code. */
function known(sourceId?: string): string {
  const saved = designedRecipes().filter((r) => !sourceId || r.key.startsWith(`${sourceId}.`));
  if (!saved.length) return "";
  return `Tools already written and verified (source.name(inputs), and the request each was written for):\n${saved.map((r) => `- ${r.key}: "${r.request}"`).join("\n")}\nIf one of them answers exactly this kind of request (current weather is not tomorrow's forecast or sunset time), use its exact name and inputs.\n`;
}

export async function guidedForge(request: string, onEvent: (e: ForgeEvent) => void, kind?: SourceKind): Promise<SmithResult> {
  onEvent({ stage: "thinking", message: "Choosing a data source" });
  // First only the source (a short reply): most sources have one general skill, so
  // the model designs a tool only for the few that don't.
  const pick = await ask<{ feasible: boolean; reason: string; source: string }>(
    SYSTEM,
    `The user asked the assistant: "${request}"

Available public data sources:
${catalogMenu()}
${kindHint(kind)}
Pick the one source that can answer this. If none can (or it needs a login, payment, private data or a physical action), set feasible=false, source="none", and make reason one friendly sentence to the user explaining that you can't do it and why. Otherwise reason is empty.`,
    { type: "object", properties: { feasible: PLAN_SCHEMA.properties.feasible, reason: PLAN_SCHEMA.properties.reason, source: PLAN_SCHEMA.properties.source }, required: ["feasible", "reason", "source"] },
  );
  const src = catalogById.get(pick.source);
  if (!pick.feasible || !src) throw new ForgeFailed(pick.reason || "I can't find a public source for that yet.");
  const plan: Plan = src.tool
    ? { ...pick, name: "", title: "", description: "", inputs: [] }
    : await ask<Plan>(
        SYSTEM,
        `The user asked the assistant: "${request}"

It will be answered from ${src.name}: ${src.useFor}.
${known(src.id)}Design a reusable tool: a snake_case verb name (like get_air_quality), a short title, a description saying exactly when to use it, and its inputs. Make inputs general (e.g. city), with the user's own values as examples, and for each a different realistic another_example (e.g. another city). Every value the user named that could change between questions (a city, a word, a coin, a currency) must be an input, never fixed in the code. Use no inputs if none are needed. Set feasible=true and source="${src.id}".`,
        PLAN_SCHEMA,
      );
  plan.source = src.id;
  if (src.tool) await generalTool(request, plan, src.tool);

  const inputs = plan.inputs.map((i) => `${toSnake(i.name)}: ${i.type}`).join(", ");
  onEvent({ stage: "thinking", message: `Chose ${src.name}, a verified source for ${src.useFor}` });
  onEvent({ stage: "thinking", message: `Designed ${toSnake(plan.name)}(${inputs})` });
  // Code that passed for this kind of skill before: test it live on this request first.
  const key = recipeKey(src.id, Boolean(src.tool), toSnake(plan.name), plan.inputs.map((i) => toSnake(i.name)));
  // Saved code only counts if it passed under the current rules: this source's notes and the checks
  // (not the code-writing prompt, which changes how code is written, not whether it is right).
  const version = createHash("sha1").update(JSON.stringify([src, NOTHING, KNOWLEDGE_NOTHING, PLACEHOLDER, speechAssert.toString(), buildSpec.toString()])).digest("hex").slice(0, 12);
  const recipe = loadRecipe(key, version);
  if (recipe) {
    onEvent({ stage: "thinking", message: `Found code this laptop wrote and verified earlier (for "${recipe.request}"); testing it live on your question` });
    const spec = buildSpec(request, plan, src, recipe.code);
    if (!validateSpec(spec).length) {
      onEvent({ stage: "test", message: "Running a live test in the sandbox" });
      const report = await testSpec(spec);
      tellResult(spec, report, src.name, onEvent);
      if (report.passed) {
        onEvent({ stage: "ready", message: `All tests passed for ${spec.name}, with no new code needed` });
        return { spec, report, attempts: 1 };
      }
      const why = describeFailure(report, request, spec).split("\n").find((l) => l.trim() && !l.startsWith("Test with input"))?.replace(/^- /, "") ?? "";
      inputProblem(report, spec, src);
      onEvent({ stage: "repair", message: `The saved code didn't pass this time (${why.slice(0, 120)}); writing new code` });
    }
  }
  const remember = (r: SmithResult) => {
    saveRecipe(key, r.spec.code, request, version);
    return r;
  };

  const docs = sourceDocs(src);
  const evidence = await samples(src, onEvent);
  const general = src.tool
    ? `\nThis is a general skill for every question of its kind, and the user's question is only its first test: follow the code shape in the Notes exactly, with all its inputs and branches, and don't narrow it to this one question.`
    : "";
  const brief = `The user asked: "${request}"${general}
Tool: ${plan.name}: ${plan.description}
Inputs: ${plan.inputs.length ? plan.inputs.map((i) => `${toSnake(i.name)} (${i.type}) e.g. ${JSON.stringify(i.example)}`).join(", ") : "none"}${
    plan.inputs.length ? `\nThe function's first line must be: const { ${plan.inputs.map((i) => toSnake(i.name)).join(", ")} } = input;` : ""
  }

API documentation:
${docs}

Real responses:
${evidence}`;

  onEvent({ stage: "thinking", message: src.domains.length ? `Writing the code against ${src.domains.join(" and ")}` : "Writing the code (no website needed)" });
  let { code } = await ask<{ code: string }>(SYSTEM, `${brief}\n\n${CONTRACT}`, CODE_SCHEMA);

  let reviewed = false;
  // A version that passed its test but whose wording was flagged; used if the rewording breaks it.
  let working: SmithResult | undefined;
  for (let attempt = 1; attempt <= config.maxSubmissions; attempt++) {
    // Mend the most common small-model slip ('couldn't' in single quotes) without a model round trip.
    if (await syntaxError(code)) {
      const mended = fixApostrophes(code);
      if (mended !== code && !(await syntaxError(mended))) {
        code = mended;
        onEvent({ stage: "repair", message: "Fixed an apostrophe inside a quoted string" });
      }
    }
    const spec = buildSpec(request, plan, src, code);
    onEvent({ stage: "submit", message: `Wrote ${spec.name} (attempt ${attempt})` });

    const problems = validateSpec(spec);
    const syntax = problems.length ? null : await syntaxError(code);
    if (syntax) problems.push(`syntax error at ${syntax}`);
    let failure: string;
    if (problems.length) {
      onEvent({ stage: "repair", message: `Static check failed: ${problems[0].split("\n")[0].replace(/:$/, "")}` });
      failure = `It was rejected before running:\n- ${problems.join("\n- ")}`;
    } else {
      onEvent({ stage: "test", message: "Running a live test in the sandbox" });
      const report = await testSpec(spec);
      const speech = (report.results[0]?.result as { speech?: string } | undefined)?.speech ?? "";
      tellResult(spec, report, src.name, onEvent);
      // A general skill's answer follows its source's shape (weather includes sunset), so it isn't reviewed against this one question.
      const problem = report.passed && !reviewed && !src.tool && attempt < config.maxSubmissions ? await reviewSpeech(request, speech) : null;
      reviewed ||= report.passed;
      if (report.passed && !problem) {
        onEvent({ stage: "ready", message: `All tests passed for ${spec.name}` });
        return remember({ spec, report, attempts: attempt });
      }
      if (problem) {
        onEvent({ stage: "repair", message: `Answer reads badly: ${problem.slice(0, 80)}` });
        working = { spec, report, attempts: attempt };
        failure = `The code works, but the spoken answer has a problem: ${problem}\nIt said: "${speech}"\nChange only how speech is worded.`;
        ({ code } = await ask<{ code: string }>(
          SYSTEM,
          `${brief}\n\n${CONTRACT}\n\nYour previous code:\n${code}\n\n${failure}\n\nReturn the complete corrected module.`,
          CODE_SCHEMA,
        ));
        continue;
      }
      inputProblem(report, spec, src);
      failure = `The live test failed:\n${describeFailure(report, request, spec)}`;
      onEvent({ stage: "repair", message: `Test failed: ${failure.split("\n")[2]?.replace(/^- /, "").slice(0, 80) ?? "fixing"}` });
    }
    if (attempt === config.maxSubmissions) break;
    // Small models tend to re-emit their own broken code, so every other retry
    // starts over (warmer, with the last failure as a warning) instead of patching.
    if (attempt % 2 === 0) {
      onEvent({ stage: "thinking", message: "Starting over with a fresh approach" });
      ({ code } = await ask<{ code: string }>(
        SYSTEM,
        `${brief}\n\n${CONTRACT}\n\nA previous attempt failed like this, avoid it:\n${failure}`,
        CODE_SCHEMA,
        0.6,
      ));
    } else {
      ({ code } = await ask<{ code: string }>(
        SYSTEM,
        `${brief}\n\n${CONTRACT}\n\nYour previous code:\n${code}\n\n${failure}\n\nFix the code. Return the complete corrected module.`,
        CODE_SCHEMA,
      ));
    }
  }
  if (working) {
    onEvent({ stage: "ready", message: `All tests passed for ${working.spec.name}` });
    return remember(working);
  }
  throw new ForgeFailed("I tried a few times but couldn't get that working reliably.");
}
