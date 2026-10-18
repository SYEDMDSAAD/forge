// The demo page's stand-in for the rest of an assistant's own reasoning, next to
// src/assistant.ts (which picks a learned skill): what kind of question this is,
// replies that need no skill (chat, creative, personal requests, emergencies), and
// a short answer written from a knowledge skill's passages and checked against
// them. In production Alexa+ does all of this itself; Forge's MCP server never does.
import { config } from "./config.js";
import { routerModel } from "./assistant.js";
import { askOllama, createClient } from "./llm.js";

/**
 * live/knowledge/fact/calculation are answered by Forge skills (learned if needed);
 * the rest are answered here without one.
 */
export type QuestionType = "live" | "knowledge" | "fact" | "calculation" | "creative" | "chat" | "advice" | "personal";
export type AdviceArea = "medical" | "legal" | "financial";
export interface Sorted {
  type: QuestionType;
  advice?: AdviceArea;
  by: string;
  ms: number;
}

const TYPES: Record<QuestionType, string> = {
  live: "needs today's or right-now data: weather, air quality, news, prices, exchange rates, rocket launches, earthquakes, where the ISS is, public holidays",
  knowledge: "explaining something that doesn't change from day to day: what or who something is, how or why it works, history, science, technology, programming, the difference between two things, the meaning of a word",
  fact: "one exact value about a place, person or thing: a population, capital, height, area, founding date, birth date, currency, official language, a leader",
  calculation: "arithmetic, percentages, converting units (km to miles, Celsius to Fahrenheit), how many days until a date, what time it is in a city; not money (currency conversion and prices use live rates)",
  creative: "writing something new: a poem, a story, a joke, a wish or message, a name idea, a short speech",
  chat: "greetings, thanks, small talk, or questions about the assistant itself",
  advice: "a health, medical, legal or money question about what the user should do: symptoms, medicines, a dispute, investing, taxes",
  personal: "needs the user's own accounts or private data, or an action in the world: their email, messages, calendar, bank, orders, contacts, booking or buying something, controlling devices",
};

/** One quick, schema-constrained call: what kind of question this is. */
export async function sortQuestion(utterance: string): Promise<Sorted | undefined> {
  if (config.provider === "mock") return undefined;
  const t0 = performance.now();
  const system =
    "You sort a voice assistant's requests by what is needed to answer them. Types:\n" +
    Object.entries(TYPES).map(([t, d]) => `- ${t}: ${d}`).join("\n") +
    "\nAdvice is only for what the user should do about their own health, legal trouble or money; explaining a disease, a law or a tax in general is knowledge, and programming or computer questions are knowledge even when they use words like kill or execute.";
  const schema = {
    type: "object",
    properties: { type: { type: "string", enum: Object.keys(TYPES) }, advice: { type: "string", enum: ["none", "medical", "legal", "financial"] } },
    required: ["type", "advice"],
  };
  const r =
    config.provider === "ollama"
      ? await askOllama<{ type: QuestionType; advice: string }>(system, `Request: "${utterance}"\n\nWhich type is it? For advice, which area?`, schema, 0)
      : await claudeJson<{ type: QuestionType; advice: string }>(system, `Request: "${utterance}"\n\nWhich type is it, and for advice which area? Reply with JSON {"type": ..., "advice": "none"|"medical"|"legal"|"financial"}.`);
  const type = r.type in TYPES ? r.type : "knowledge";
  const advice = type === "advice" && ["medical", "legal", "financial"].includes(r.advice) ? (r.advice as AdviceArea) : undefined;
  return { type, ...(advice ? { advice } : {}), by: routerModel, ms: Math.round(performance.now() - t0) };
}

// ---------- emergencies: a fixed answer, before any model ----------

const SELF_HARM = /\b(kill(ing)? myself|suicid\w*|end (my|it all)|take my (own )?life|self[- ]?harm|hurt(ing)? myself|want(ed)? to die|don'?t want to live)\b/i;
const MEDICAL = /\b(chest pain|heart attack|can'?t breathe|cannot breathe|not breathing|stopped breathing|unconscious|passed out|stroke|seizure|severe bleeding|bleeding (a lot|heavily)|overdos\w*|swallowed (poison|bleach)|poisoned|snake ?bite|choking)\b/i;
const DANGER = /\b(house|home|building|flat|kitchen) (is )?on fire|there'?s a fire|caught fire|(gas|cylinder) leak|being attacked|someone (is )?(breaking in|attacking)/i;

/**
 * India's numbers, said first and plainly: 112 (all emergencies), 108 (ambulance),
 * Tele-MANAS 14416 (free 24x7 mental-health support).
 */
export function emergency(utterance: string): string | undefined {
  // Self-harm always gets the helpline, however it's asked.
  if (SELF_HARM.test(utterance))
    return "I'm really sorry you're feeling this way, and you don't have to go through it alone. Please call Tele-MANAS on 14416, free and open day and night, or 112 if you're in danger right now. If you can, tell someone you trust what's happening.";
  // "What is a heart attack?" asks for an explanation; "my father has chest pain" is happening now.
  if (!happeningNow(utterance)) return undefined;
  if (MEDICAL.test(utterance))
    return "This could be an emergency. Please call 112, or 108 for an ambulance, right now. Stay with the person, keep them still and comfortable, and follow what the operator tells you.";
  if (DANGER.test(utterance))
    return "Please get to safety first, then call 112 right now. Don't go back in for belongings.";
  return undefined;
}

/** Someone is involved (I, my father, she), or it isn't a general what/how/why question. */
function happeningNow(utterance: string): boolean {
  const general = /^\s*(what|why|how|explain|define|describe|tell me about|history of)\b/i.test(utterance);
  const person = /\b(i|i'?m|me|my|mine|we|our|us|someone|somebody|he|she|they|his|her|their|him|baby|child|kid|friend|father|mother|dad|mom|mum|wife|husband|brother|sister|son|daughter|grandma|grandpa|neighbou?r)\b/i.test(utterance);
  return person || !general;
}

// ---------- replies that need no skill ----------

/** Chat and creative writing: the model's own words, labelled as such by the page. */
export async function chatAnswer(utterance: string, type: "chat" | "creative"): Promise<{ speech: string; by: string; ms: number } | undefined> {
  if (config.provider === "mock") return undefined;
  const t0 = performance.now();
  const system =
    type === "creative"
      ? "You are a warm, friendly voice assistant. Write what the user asks for, kept short enough to read aloud (under 120 words), in plain text with no markdown. Never state facts about current events, prices or real people's private lives."
      : "You are Forge, a friendly voice assistant that learns new skills: live data (weather, news, prices), explaining things from Wikipedia, exact facts, and calculations, and it asks before keeping a new skill. Reply in one or two short spoken sentences, plain text. Never claim to know current events or the user's personal data.";
  const speech = await sayText(system, utterance, type === "creative" ? 400 : 120);
  return speech ? { speech, by: routerModel, ms: Math.round(performance.now() - t0) } : undefined;
}

/** Personal data and actions: what can't be done, and what can, without a learning wait. */
export function personalReply(): string {
  return "I can't reach your personal accounts or act for you, like reading your messages, checking your bank or orders, or booking things. I can tell you the weather, the news and prices, explain almost anything, look up facts, and do calculations.";
}

const ADVICE_NOTE: Record<AdviceArea, string> = {
  medical: "This is general information, not medical advice: please see a doctor about your own situation, and call 112 in an emergency.",
  legal: "This is general information, not legal advice: for your own situation, please talk to a lawyer or your local legal aid service.",
  financial: "This is general information, not financial advice: for your own money, please talk to a registered financial adviser.",
};
export const adviceNote = (area: AdviceArea) => ADVICE_NOTE[area];

// ---------- answers written from a knowledge skill's passages ----------

export interface Passage {
  topic: string;
  text: string;
}
/** `note`: the advice note to add after the answer (also when it falls back to the article's own words). */
export type Composed = { speech: string; checked: boolean; note?: string; by: string; ms: number };

/**
 * A short answer to the user's exact question, written only from the passages a
 * knowledge skill returned, then checked against them. If the model brings in
 * anything the passages don't say (twice), `checked` is false and the caller
 * falls back to the skill's own words.
 */
export async function composeAnswer(question: string, passages: Passage[], advice?: AdviceArea): Promise<Composed | undefined> {
  if (config.provider === "mock" || !passages.length) return undefined;
  const t0 = performance.now();
  const source = passages.map((p, i) => `[${i + 1}] (${p.topic}) ${p.text}`).join("\n\n");
  const system =
    "You are a voice assistant answering from Wikipedia passages. Answer the user's exact question in two to four short spoken sentences, using only facts the passages state, " +
    "in plain text with no markdown and no list markers. Answer every part of the question (a two-part question gets both parts). Prefer the passages' own words for names and terms. " +
    "If the passages don't answer part of the question, say that the article doesn't cover it; never fill the gap yourself.";
  for (const strict of [false, true, true]) {
    const speech = await sayText(
      system + (strict ? " Your last answer used words the passages don't contain: stay even closer to their wording." : ""),
      `Passages:\n${source}\n\nThe user asked: "${question}"`,
      300,
    );
    const why = speech ? unsupported(speech, passages, question) : ["no answer"];
    if (!why.length) return { speech, checked: true, ...(advice ? { note: adviceNote(advice) } : {}), by: routerModel, ms: Math.round(performance.now() - t0) };
    console.error(`compose: answer rejected (${why.join("; ")}): ${speech.slice(0, 200)}`);
  }
  return { speech: "", checked: false, ...(advice ? { note: adviceNote(advice) } : {}), by: routerModel, ms: Math.round(performance.now() - t0) };
}

// Words every answer may use whatever the passages say.
const COMMON = new Set(
  "about after also although among another answer article because before being between both called cannot common could cover covers different does doesn during each either example first following found further general however important include includes including known large later least less makes many might more most often other others part people since small some something sometimes still such than that their there these thing things those though three through together under until usually various very where whether which while within without would years".split(
    " ",
  ),
);
const stem = (w: string) => w.slice(0, 5);

/**
 * The check: every number in the answer is in the passages or the question, every
 * capitalised name is, and at least 85% of its other longer words are (by their
 * first five letters, so "encapsulates" matches "encapsulation").
 */
export function supported(answer: string, passages: Passage[], question: string): boolean {
  return unsupported(answer, passages, question).length === 0;
}

/** Why an answer isn't supported by its passages (empty when it is): for the check and its log. */
export function unsupported(answer: string, passages: Passage[], question: string): string[] {
  const source = `${passages.map((p) => `${p.topic} ${p.text}`).join(" ")} ${question}`;
  const lower = source.toLowerCase();
  const numbers = (t: string) => (t.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = new Set(numbers(source));
  const why: string[] = [];
  const newNumbers = numbers(answer).filter((n) => n > 10 && !known.has(n));
  if (newNumbers.length) why.push(`numbers not in the passages: ${newNumbers.join(", ")}`);
  // Names: capitalised words not at the start of a sentence.
  const names = (answer.match(/(?<![.!?]\s|^)\b[A-Z][a-zA-Z]{2,}/g) ?? []).filter((n) => !lower.includes(n.toLowerCase()));
  if (names.length) why.push(`names not in the passages: ${names.join(", ")}`);
  const words = (answer.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !COMMON.has(w));
  const stems = new Set((lower.match(/[a-z]{5,}/g) ?? []).map(stem));
  const missing = words.filter((w) => !stems.has(stem(w)));
  if (words.length && (words.length - missing.length) / words.length < 0.85) why.push(`too many words not in the passages: ${missing.join(", ")}`);
  return why;
}

// ---------- model calls ----------

async function sayText(system: string, user: string, maxTokens: number): Promise<string> {
  if (config.provider === "ollama") {
    const { speech } = await askOllama<{ speech: string }>(system, user, { type: "object", properties: { speech: { type: "string" } }, required: ["speech"] }, 0.3);
    return (speech ?? "").replace(/\s+/g, " ").trim();
  }
  const res = await createClient().messages.create({ model: routerModel, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").replace(/\s+/g, " ").trim();
}

async function claudeJson<T>(system: string, user: string): Promise<T> {
  const text = await sayText(system, user, 200);
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
}
