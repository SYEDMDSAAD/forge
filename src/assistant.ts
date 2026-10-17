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
      return `- ${s.name}: ${s.description}${inputs.length ? ` Inputs: ${inputs.join("; ")}.` : ""}`;
    })
    .join("\n");
}

function missingOf(skill: RouteSkill, input: Record<string, unknown>): string[] {
  return (skill.inputSchema.required ?? []).filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

/** Small local model: pick the skill, then fill its inputs, each constrained to a JSON schema. */
async function routeOllama(utterance: string, skills: RouteSkill[], only?: string): Promise<Picked> {
  let name = only;
  if (!name) {
    const pick = await askOllama<{ skill: string }>(
      SYSTEM,
      `Skills:\n${menu(skills)}\n\nUser: "${utterance}"\n\nWhich skill answers this? Reply with its name, or none.`,
      { type: "object", properties: { skill: { type: "string", enum: [...skills.map((s) => s.name), "none"] } }, required: ["skill"] },
      0,
    );
    name = pick.skill;
  }
  const skill = skills.find((s) => s.name === name);
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
