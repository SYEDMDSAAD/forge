// The demo page's stand-in for the assistant's own reasoning. In production
// Alexa+ (or any LLM client) reads Forge's tool list and decides which skill
// answers a request and with what inputs; the demo page asks this instead.
// It is not part of the MCP server: Forge never routes requests itself.
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { CATALOG, genericInputs, isGeneric, knownInputs, namedIn } from "./forge/catalog.js";
import { askOllama, createClient } from "./llm.js";

// A source's one general skill answers far more than the question it was first
// learned for (explain_topic: any topic), so that question isn't shown as its example.
const GENERAL = new Set(CATALOG.flatMap((s) => (s.tool ? [s.tool.name] : [])));
const example = (s: RouteSkill) => (GENERAL.has(s.name) ? undefined : s.request);

export interface RouteSkill {
  name: string;
  title: string;
  description: string;
  inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  /** The question it was learned for: a concrete example of what it answers. */
  request?: string;
  /** live, knowledge, fact or calculation (from its source). */
  kind?: string;
}

type Picked = { skill: null } | { skill: string; input: Record<string, unknown>; missing: string[] };
export type Route = Picked & { by: string; ms: number };

export const routerModel =
  process.env.FORGE_ROUTER_MODEL ?? { anthropic: "claude-haiku-5-5", bedrock: "anthropic.claude-haiku-5-5", ollama: config.model, mock: "" }[config.provider];

const SYSTEM =
  "You are a voice assistant deciding which of your skills answers the user's request. " +
  "A skill fits only if it answers exactly this kind of question (a weather skill does not answer air quality, a crypto skill does not convert currencies). " +
  "If no skill fits, choose none: a new skill will be learned for it.";

function menu(skills: RouteSkill[]): string {
  return skills
    .map((s) => {
      const inputs = Object.entries(s.inputSchema.properties ?? {}).map(([k, p]) => `${k}: ${p.description ?? p.type}`);
      return `- ${s.name}: ${s.description}${example(s) ? ` Learned for: "${example(s)}".` : ""}${inputs.length ? ` Inputs: ${inputs.join("; ")}.` : ""}`;
    })
    .join("\n");
}

function missingOf(skill: RouteSkill, input: Record<string, unknown>): string[] {
  return (skill.inputSchema.required ?? []).filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

// A small model offered one skill tends to pick it for anything nearby (weather
// for air quality), so it checks each pick as a plain yes/no question. A pick it
// rejects is left out of a second try.
async function pickSkill(utterance: string, skills: RouteSkill[], trustGeneral = false): Promise<RouteSkill | undefined> {
  let left = skills;
  for (let attempt = 0; attempt < 2 && left.length; attempt++) {
    const pick = await askOllama<{ skill: string }>(
      SYSTEM,
      `Skills:\n${menu(left)}\n\nUser: "${utterance}"\n\nWhich skill answers this? Reply with its name, or none.`,
      { type: "object", properties: { skill: { type: "string", enum: [...left.map((s) => s.name), "none"] } }, required: ["skill"] },
      0,
    );
    const skill = left.find((s) => s.name === pick.skill);
    if (!skill) return undefined;
    // The one general skill of the question's kind (explain_topic for a knowledge question) answers it.
    if (trustGeneral && GENERAL.has(skill.name)) return skill;
    const check = await askOllama<{ answers: boolean }>(
      SYSTEM,
      `The user asked: "${utterance}"\n\nSkill: ${skill.description}${example(skill) ? `\nIt was learned for questions like: "${example(skill)}"` : ""}\n\nDoes this skill give the user exactly what they asked for? Something related is not enough: weather now is not tomorrow's forecast, weather is not air quality or sunset time, a currency converter (dollars, rupees, euros) does not price bitcoin or other crypto coins, a word's meaning is not a person's biography, news headlines are not a schedule (when the next rocket launch or match is).`,
      { type: "object", properties: { answers: { type: "boolean" } }, required: ["answers"] },
      0,
    );
    if (check.answers) return skill;
    left = left.filter((s) => s !== skill);
  }
  return undefined;
}

/** Small local model: pick the skill, then fill its inputs, each constrained to a JSON schema. */
async function routeOllama(utterance: string, skills: RouteSkill[], only?: string, kind?: string): Promise<Picked> {
  // The question's kind (from the sorter) narrows the choice to skills of that kind, when there are any.
  const pool = kind ? skills.filter((s) => s.kind === kind) : [];
  // Knowledge and facts each have one general skill that answers every question of the kind; live data and
  // calculations have several different ones (weather is not air quality), so those picks are still checked.
  const trust = pool.length > 0 && (kind === "knowledge" || kind === "fact");
  const skill = only ? skills.find((s) => s.name === only) : await pickSkill(utterance, pool.length ? pool : skills, trust);
  if (!skill) return { skill: null };
  const props = skill.inputSchema.properties ?? {};
  if (!Object.keys(props).length) return { skill: skill.name, input: {}, missing: [] };
  // Every field may be null so the model can say "the user didn't give this" instead of inventing it.
  const schema = {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, p]) => [k, { type: [p.type === "integer" ? "integer" : p.type === "number" ? "number" : "string", "null"] }])),
    required: Object.keys(props),
  };
  const raw = await askOllama<Record<string, unknown>>(
    "You fill in a skill's inputs from what the user said. Reply only with JSON matching the schema.",
    `Skill ${skill.name}: ${skill.description}\nInputs:\n${Object.entries(props)
      .map(([k, p]) => `- ${k} (${p.type ?? "string"}): ${p.description ?? ""}`)
      .join("\n")}\n\nUser: "${utterance}"\n\nUse the user's values, converted to the form each input asks for (for example a currency name to its ISO code). Use null for anything the user didn't say, except an input that asks for your best guess: fill that in.`,
    schema,
    0,
  );
  // "today's hot news" names no topic: leave it out, so the skill reads the top headlines.
  const generic = genericInputs.get(skill.name) ?? [];
  const input = Object.fromEntries(Object.entries(raw).filter(([k, v]) => v !== null && v !== "" && !(generic.includes(k) && typeof v === "string" && isGeneric(v))));
  // A value from a known list the model left out ("When is NASA's next launch?"): take it from the request.
  for (const { name, known } of knownInputs.get(skill.name) ?? []) {
    if (props[name] && !input[name]) {
      const hit = namedIn(utterance, known);
      if (hit) input[name] = hit;
    }
  }
  // A knowledge skill finds the passages that answer the question by these words: always give it some.
  if (props.keywords && !input.keywords) {
    const { keywords } = await askOllama<{ keywords: string }>(
      "You help find the part of a Wikipedia article that answers a question.",
      `Question: "${utterance}"\n\nGive 2 to 5 words likely to appear in the paragraphs that answer it (for \"why do leaves change colour in autumn\": chlorophyll pigment carotenoid).`,
      { type: "object", properties: { keywords: { type: "string" } }, required: ["keywords"] },
      0,
    );
    if (keywords?.trim()) input.keywords = keywords.trim();
  }
  return { skill: skill.name, input, missing: missingOf(skill, input) };
}

/** Claude: the skills are offered as real tools, the way an assistant sees an MCP tool list. */
async function routeClaude(utterance: string, skills: RouteSkill[], only?: string): Promise<Picked> {
  const offered = only ? skills.filter((s) => s.name === only) : skills;
  const res = await createClient().messages.create({
    model: routerModel,
    max_tokens: 1024,
    system: SYSTEM + " Call the skill that fits with the inputs the user gave; never invent an input. If none fits, reply with the word none.",
    tools: offered.map((s) => ({ name: s.name, description: s.description, input_schema: { type: "object" as const, ...s.inputSchema } })),
    tool_choice: only ? { type: "tool", name: only } : { type: "auto" },
    messages: [{ role: "user", content: utterance }],
  });
  const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const skill = use && skills.find((s) => s.name === use.name);
  if (!skill) return { skill: null };
  const generic = genericInputs.get(skill.name) ?? [];
  const input = Object.fromEntries(Object.entries(use.input as Record<string, unknown>).filter(([k, v]) => !(generic.includes(k) && typeof v === "string" && isGeneric(v))));
  return { skill: skill.name, input, missing: missingOf(skill, input) };
}

/**
 * Picks the skill for `utterance` (or, with `only`, just fills that skill's inputs).
 * Returns undefined when no model is configured (mock provider), so the page can fall back.
 */
export async function route(utterance: string, skills: RouteSkill[], only?: string, kind?: string): Promise<Route | undefined> {
  if (config.provider === "mock" || !skills.length) return undefined;
  const t0 = performance.now();
  const r = config.provider === "ollama" ? await routeOllama(utterance, skills, only, kind) : await routeClaude(utterance, skills, only);
  return { ...r, by: routerModel, ms: Math.round(performance.now() - t0) };
}

/** The answer the user just heard, so a follow-up question can be about it. */
export interface LastAnswer {
  question?: string;
  skill: string;
  speech: string;
  data?: unknown;
}
/** `code`: code or pseudo code the user asked for, shown as a block and never read aloud. */
export type FollowUp = { speech: string; code?: string; by: string; ms: number } | { speech: null; by: string; ms: number };

const FOLLOW_SYSTEM =
  "You are a voice assistant. You just answered the user with live data. Decide whether their next question is a follow-up about that answer " +
  "which needs no new live data: it can be answered from the facts in that answer plus general knowledge (what a status means, why launches get delayed, what an AQI of 150 means for health). " +
  "A question that needs any fresh or different data (another place, another day, tomorrow's forecast, a current number, today's news, a different item) is not; a new skill will be learned for it.";

/**
 * With no skill fitting, answers a follow-up about the last answer from that answer and general
 * knowledge, never inventing current facts. `speech: null` means it needs live data: learn a skill.
 */
export async function followUp(utterance: string, last: LastAnswer): Promise<FollowUp | undefined> {
  if (config.provider === "mock") return undefined;
  const t0 = performance.now();
  const context = `Your last answer (from the ${last.skill} skill${last.question ? `, to "${last.question}"` : ""}): "${last.speech}"${
    last.data ? `\nIts data: ${JSON.stringify(last.data).slice(0, 800)}` : ""
  }\n\nThe user now asks: "${utterance}"`;
  const reply = (speech: string | null, code?: string) => ({ speech, ...(speech && code?.trim() ? { code: code.trim() } : {}), by: routerModel, ms: Math.round(performance.now() - t0) });
  const codeRule =
    "If the user asks for code, pseudo code or a formula, write it laid out on separate lines with indentation, and make the spoken answer one short sentence introducing it: code is shown on screen, never read aloud.";
  const answerRules =
    "Answer in two or three short spoken sentences. Use the facts from your last answer where they help, and general knowledge for the rest. " +
    "Never state a current number, date, name or event that isn't in your last answer; if answering needs one, reply with exactly NEED_DATA. No markdown.";
  if (config.provider !== "ollama") {
    const res = await createClient().messages.create({
      model: routerModel,
      max_tokens: 1200,
      system: `${FOLLOW_SYSTEM} If it needs new live data, reply with exactly the word NEED_DATA. Otherwise: ${answerRules} ${codeRule} Put the code in one fenced code block.`,
      messages: [{ role: "user", content: context }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const code = text.match(/```[a-z]*\n([^]*?)```/)?.[1];
    const speech = text.replace(/```[^]*?```/g, "").trim();
    // Numbers inside code (array indexes, loop bounds) are not facts about the world.
    return reply(!speech || /NEED_DATA/.test(text) || !grounded(speech, context) ? null : speech, code);
  }
  const check = await askOllama<{ different_subject: boolean; needs_new_data: boolean }>(
    FOLLOW_SYSTEM,
    `${context}\n\ndifferent_subject: does the user ask about a different place, agency, company, person, item or day than your last answer? ` +
      `needs_new_data: does answering need any current fact that isn't in your last answer?`,
    { type: "object", properties: { different_subject: { type: "boolean" }, needs_new_data: { type: "boolean" } }, required: ["different_subject", "needs_new_data"] },
    0,
  );
  if (check.different_subject) return reply(null);
  const { speech, code } = await askOllama<{ speech: string; code: string }>(
    `You are a friendly voice assistant. ${answerRules} ${codeRule} Put it in code, with real line breaks; otherwise code is an empty string.`,
    context,
    { type: "object", properties: { speech: { type: "string" }, code: { type: "string" } }, required: ["speech", "code"] },
  );
  // Numbers inside code (array indexes, loop bounds) are not facts about the world.
  return reply(grounded(speech.trim(), context) ? speech.trim() : null, code);
}

/**
 * A follow-up answer may only use numbers (values, dates, years) the last answer or
 * the question contained: one it made up ("AQI 85 in Bengaluru") means it needed live data.
 */
export function grounded(speech: string, context: string): boolean {
  // "I don't have information about tomorrow" is a request for live data, not an answer.
  if (!speech || /NEED_DATA|don.?t have (any )?(the )?(information|data|access)|no (information|data) (about|on)|need (more |the |)(data|information)|need data|\b(we|i|you)(.?d| would)? need\b|check a (reliable|local)|i.?m (sorry|not sure)/i.test(speech)) return false;
  const numbers = (t: string) => (t.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = new Set(numbers(context));
  return numbers(speech).every((n) => n <= 10 || known.has(n));
}

// "What about ISRO?", "And Mumbai?", "How about in euros?"
const ELLIPTICAL = /^\s*(and|what about|how about|what of|same for|and for|now)\b.{1,60}$/i;

/**
 * A short follow-up only makes sense with the previous question, so it is rewritten
 * as a full one ("What about ISRO?" after "When is NASA's next launch?" → "When is
 * ISRO's next launch?") before routing or learning. Anything else is left as it is.
 */
export async function standalone(utterance: string, previous?: string): Promise<string> {
  if (!previous || config.provider === "mock" || !ELLIPTICAL.test(utterance)) return utterance;
  // A leading "and" reads to a small model as "both": "and in London?" became "Tokyo and London".
  const follow = utterance.replace(/^\s*(and|now)\s+/i, "");
  const prompt = `Previous question: "${previous}"\nFollow-up: "${follow}"\n\nRewrite the follow-up as one complete question that makes sense on its own. The follow-up replaces one thing in the previous question (a place, an agency, a currency, an item): the old one is dropped, never kept alongside the new one. Keep everything else the same.\nExamples:\n"What's the weather in Pune right now?" + "in Delhi?" = "What's the weather in Delhi right now?"\n"Convert 100 dollars to rupees" + "to euros?" = "Convert 100 dollars to euros"\n"What are the next public holidays in Japan?" + "what about France?" = "What are the next public holidays in France?"`;
  if (config.provider !== "ollama") {
    const res = await createClient().messages.create({ model: routerModel, max_tokens: 100, system: "Reply with only the rewritten question.", messages: [{ role: "user", content: prompt }] });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || utterance;
  }
  const { question } = await askOllama<{ question: string }>("You rewrite follow-up questions.", prompt, { type: "object", properties: { question: { type: "string" } }, required: ["question"] }, 0);
  return question.trim() || utterance;
}
