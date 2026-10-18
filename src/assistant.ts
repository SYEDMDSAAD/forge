// The demo page's stand-in for the assistant's own reasoning. In production
// Alexa+ (or any LLM client) reads Forge's tool list and decides which skill
// answers a request and with what inputs; the demo page asks this instead.
// It is not part of the MCP server: Forge never routes requests itself.
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { askOllama, createClient } from "./llm.js";

export interface RouteSkill {
  name: string;
  title: string;
  description: string;
  inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  /** The question it was learned for: a concrete example of what it answers. */
  request?: string;
}

type Picked = { skill: null } | { skill: string; input: Record<string, unknown>; missing: string[] };
export type Route = Picked & { by: string; ms: number };

const routerModel =
  process.env.FORGE_ROUTER_MODEL ?? { anthropic: "claude-haiku-5-5", bedrock: "anthropic.claude-haiku-5-5", ollama: config.model, mock: "" }[config.provider];

const SYSTEM =
  "You are a voice assistant deciding which of your skills answers the user's request. " +
  "A skill fits only if it answers exactly this kind of question with live data (a weather skill does not answer air quality, a crypto skill does not convert currencies). " +
  "If no skill fits, choose none: a new skill will be learned for it.";

function menu(skills: RouteSkill[]): string {
  return skills
    .map((s) => {
      const inputs = Object.entries(s.inputSchema.properties ?? {}).map(([k, p]) => `${k}: ${p.description ?? p.type}`);
      return `- ${s.name}: ${s.description}${s.request ? ` Learned for: "${s.request}".` : ""}${inputs.length ? ` Inputs: ${inputs.join("; ")}.` : ""}`;
    })
    .join("\n");
}

function missingOf(skill: RouteSkill, input: Record<string, unknown>): string[] {
  return (skill.inputSchema.required ?? []).filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

// A small model offered one skill tends to pick it for anything nearby (weather
// for air quality), so it checks each pick as a plain yes/no question. A pick it
// rejects is left out of a second try.
async function pickSkill(utterance: string, skills: RouteSkill[]): Promise<RouteSkill | undefined> {
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
    const check = await askOllama<{ answers: boolean }>(
      SYSTEM,
      `The user asked: "${utterance}"\n\nSkill: ${skill.description}${skill.request ? `\nIt was learned for questions like: "${skill.request}"` : ""}\n\nDoes this skill give the user exactly what they asked for? Something related is not enough: weather now is not tomorrow's forecast, weather is not air quality or sunset time, a currency converter (dollars, rupees, euros) does not price bitcoin or other crypto coins, a word's meaning is not a person's biography, news headlines are not a schedule (when the next rocket launch or match is).`,
      { type: "object", properties: { answers: { type: "boolean" } }, required: ["answers"] },
      0,
    );
    if (check.answers) return skill;
    left = left.filter((s) => s !== skill);
  }
  return undefined;
}

/** Small local model: pick the skill, then fill its inputs, each constrained to a JSON schema. */
async function routeOllama(utterance: string, skills: RouteSkill[], only?: string): Promise<Picked> {
  const skill = only ? skills.find((s) => s.name === only) : await pickSkill(utterance, skills);
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
      .join("\n")}\n\nUser: "${utterance}"\n\nUse the user's values, converted to the form each input asks for (for example a currency name to its ISO code). Use null for anything the user didn't say.`,
    schema,
    0,
  );
  const input = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== ""));
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
  const input = use.input as Record<string, unknown>;
  return { skill: skill.name, input, missing: missingOf(skill, input) };
}

/**
 * Picks the skill for `utterance` (or, with `only`, just fills that skill's inputs).
 * Returns undefined when no model is configured (mock provider), so the page can fall back.
 */
export async function route(utterance: string, skills: RouteSkill[], only?: string): Promise<Route | undefined> {
  if (config.provider === "mock" || !skills.length) return undefined;
  const t0 = performance.now();
  const r = config.provider === "ollama" ? await routeOllama(utterance, skills, only) : await routeClaude(utterance, skills, only);
  return { ...r, by: routerModel, ms: Math.round(performance.now() - t0) };
}

/** The answer the user just heard, so a follow-up question can be about it. */
export interface LastAnswer {
  question?: string;
  skill: string;
  speech: string;
  data?: unknown;
}
export type FollowUp = { speech: string; by: string; ms: number } | { speech: null; by: string; ms: number };

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
  const reply = (speech: string | null) => ({ speech, by: routerModel, ms: Math.round(performance.now() - t0) });
  const answerRules =
    "Answer in two or three short spoken sentences. Use the facts from your last answer where they help, and general knowledge for the rest. " +
    "Never state a current number, date, name or event that isn't in your last answer; if answering needs one, reply with exactly NEED_DATA. No markdown.";
  if (config.provider !== "ollama") {
    const res = await createClient().messages.create({
      model: routerModel,
      max_tokens: 400,
      system: `${FOLLOW_SYSTEM} If it needs new live data, reply with exactly the word NEED_DATA. Otherwise: ${answerRules}`,
      messages: [{ role: "user", content: context }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return reply(!text || /NEED_DATA/.test(text) || !grounded(text, context) ? null : text);
  }
  const check = await askOllama<{ different_subject: boolean; needs_new_data: boolean }>(
    FOLLOW_SYSTEM,
    `${context}\n\ndifferent_subject: does the user ask about a different place, agency, company, person, item or day than your last answer? ` +
      `needs_new_data: does answering need any current fact that isn't in your last answer?`,
    { type: "object", properties: { different_subject: { type: "boolean" }, needs_new_data: { type: "boolean" } }, required: ["different_subject", "needs_new_data"] },
    0,
  );
  if (check.different_subject) return reply(null);
  const { speech } = await askOllama<{ speech: string }>(`You are a friendly voice assistant. ${answerRules}`, context, {
    type: "object",
    properties: { speech: { type: "string" } },
    required: ["speech"],
  });
  return reply(grounded(speech.trim(), context) ? speech.trim() : null);
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
  const prompt = `Previous question: "${previous}"\nFollow-up: "${utterance}"\n\nRewrite the follow-up as one complete question that makes sense on its own. The follow-up replaces one thing in the previous question (a place, an agency, a currency, an item); it does not add to it. Keep everything else the same.`;
  if (config.provider !== "ollama") {
    const res = await createClient().messages.create({ model: routerModel, max_tokens: 100, system: "Reply with only the rewritten question.", messages: [{ role: "user", content: prompt }] });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || utterance;
  }
  const { question } = await askOllama<{ question: string }>("You rewrite follow-up questions.", prompt, { type: "object", properties: { question: { type: "string" } }, required: ["question"] }, 0);
  return question.trim() || utterance;
}
