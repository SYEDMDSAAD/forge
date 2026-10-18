// Forge demo client: an Alexa+-style assistant UI that is itself an MCP client.
// It calls forge_capability as an MCP task (live build steps), answers the
// server's elicitation with a consent card, and follows tools/list_changed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ElicitResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { setupVoice, speak, stopSpeaking } from "./voice.js";

interface Skill {
  id: string;
  name: string;
  title: string;
  description: string;
  allowedDomains: string[];
  inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  tests: { name: string; passed: boolean; ms: number }[];
  uses: number;
  sources?: string[];
  crossChecked?: boolean;
  request?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $<HTMLOListElement>("chat");
const input = $<HTMLInputElement>("say");
const orb = $<HTMLButtonElement>("mic");

const client = new Client({ name: "forge-web", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
let tools: Tool[] = [];
let skills: Skill[] = [];
let busy = false;

// ---------- what the assistant is doing ----------
// The orb (also the mic button) shows it: listening, speaking, thinking or idle.

const state = { listening: false, speaking: false, thinking: false };

function showState() {
  orb.dataset.state = state.listening ? "listening" : state.speaking ? "speaking" : state.thinking ? "thinking" : "idle";
  orb.title = state.speaking ? "Stop speaking (Esc)" : state.listening ? "Stop listening" : "Speak (Chrome)";
  $("hint").textContent = state.speaking ? "Esc stops speaking" : "";
}

// ---------- rendering ----------

const SUGGESTIONS = [
  "What's the weather in Pune right now?",
  "What's the air quality in Delhi?",
  "Where is the ISS right now?",
  "Convert 100 US dollars to rupees",
  "When is the next rocket launch?",
];

function renderChips() {
  for (const text of SUGGESTIONS) {
    const b = el("button", undefined, text);
    b.type = "button";
    b.onclick = () => void ask(text);
    $("chips").append(b);
  }
}

function scroll() {
  chat.scrollTop = chat.scrollHeight;
}

function append(li: HTMLLIElement) {
  $("welcome").hidden = true;
  chat.querySelector(".typing")?.remove();
  chat.append(li);
  scroll();
}

function addMsg(kind: "user" | "bot" | "note", text: string) {
  const li = el("li", `msg ${kind}`, text);
  append(li);
  return li;
}

function addCard(card: HTMLElement) {
  const li = el("li");
  li.style.display = "contents";
  li.append(card);
  append(li);
}

/** Three dots while the assistant works out an answer; returns a function that removes them. */
function typing(): () => void {
  const li = el("li", "msg bot typing");
  li.setAttribute("aria-label", "Thinking");
  li.append(el("i"), el("i"), el("i"));
  append(li);
  return () => li.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Bookkeeping fields APIs commonly return that mean nothing to a listener.
const HIDDEN_KEYS = new Set(["interval", "id", "generationtime_ms", "utc_offset_seconds", "elevation"]);
const hiddenKey = (k: string) => HIDDEN_KEYS.has(k) || /(^|_)(code|id)$/i.test(k);

function display(v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  if (typeof v === "number") return (Number.isInteger(v) ? v : Math.round(v * 10) / 10).toLocaleString("en-IN");
  return String(v);
}

// Units the common keyless sources use by default (Open-Meteo: °C, %, km/h, mm).
function unit(key: string): string {
  const k = key.toLowerCase();
  if (/humidity|probability|chance|percent|change/.test(k)) return "%";
  if (/temp|feels/.test(k)) return "°";
  if (/wind|speed|velocity/.test(k)) return " km/h";
  if (/precip|rain/.test(k)) return " mm";
  if (/altitude/.test(k)) return " km";
  if (/^pm\d/.test(k)) return " µg/m³";
  return "";
}

/** "us_aqi" → "US AQI", "pm2_5" → "PM2.5", "wind_speed" → "Wind speed". */
const ACRONYMS = new Set(["aqi", "us", "uv", "iss", "pm10", "utc", "usd", "inr", "eur"]);
function label(key: string): string {
  const words = key
    .replace(/pm2_5/i, "PM2.5")
    .split(/[_\s]+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase() === "pm2.5" ? "PM2.5" : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function answerCard(skill: Skill, speech: string, data: unknown, footer: string) {
  const card = el("div", "card answer");
  card.append(el("div", "card-kicker", skill.title));
  // The spoken answer ends with its citation; show that as a tag under the answer.
  const at = speech.lastIndexOf("Source:");
  card.append(el("div", "card-title", at > 0 ? speech.slice(0, at).trim() : speech));
  if (data && typeof data === "object") {
    const stats = el("div", "stats");
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === null || typeof v === "object" || hiddenKey(k) || String(v).length > 40) continue;
      const stat = el("div", "stat");
      stat.append(el("b", undefined, display(v) + (typeof v === "number" ? unit(k) : "")), el("span", undefined, label(k)));
      stat.title = `${label(k)}: ${display(v)}`;
      stats.append(stat);
      if (stats.childElementCount === 6) break;
    }
    if (stats.childElementCount) card.append(stats);
  }
  const cite = el("div", "cite");
  if (at > 0) cite.append(el("span", "tag src", speech.slice(at).trim().replace(/\.$/, "")));
  if (skill.crossChecked) cite.append(el("span", "tag ok", "✓ cross-checked when learned"));
  if (cite.childElementCount) card.append(cite);
  const via = el("div", "via", footer);
  const more = el("button", "more", "How I got this");
  more.type = "button";
  more.onclick = () => void openSkill(skill.name);
  via.append(more);
  card.append(via);
  addCard(card);
}

function say(text: string) {
  addMsg("bot", text);
  speak(text);
}

function renderSkills(freshName?: string) {
  const list = $("skills");
  $("count").textContent = String(skills.length);
  list.replaceChildren();
  if (!skills.length) {
    list.append(el("li", "empty", "Nothing learned yet. Ask for something new and watch it learn."));
    return;
  }
  for (const s of skills) {
    const li = el("li", s.name === freshName ? "fresh" : undefined);
    const row = el("div", "row");
    const name = el("div", "name", s.title);
    name.title = "See how this skill works";
    name.onclick = () => void openSkill(s.name);
    row.append(name);
    if (s.request) {
      const t = el("button", "try", "Ask");
      t.type = "button";
      t.title = `Ask: ${s.request}`;
      t.onclick = () => void ask(s.request!);
      row.append(t);
    }
    li.append(row);
    const passed = s.tests.filter((t) => t.passed).length;
    const from = s.sources?.length ? s.sources.join(", ") : s.allowedDomains.join(", ");
    li.append(el("div", "meta", `${from} · ${passed}/${s.tests.length} tests${s.crossChecked ? " · cross-checked" : ""} · used ${s.uses}×`));
    list.append(li);
  }
}

// ---------- build timeline ----------
// In the conversation: four steps anyone can follow. In the side panel: the full log.

const PHASES = ["Find a source", "Write the code", "Test & cross-check", "Your OK"];

function learnCard(request: string) {
  const card = el("div", "card learn");
  const kicker = el("div", "card-kicker");
  const label = el("span", undefined, "Learning a new skill");
  const timer = el("span", "timer", "0 s");
  kicker.append(label, timer);
  const phases = el("ol", "phases");
  const items = PHASES.map((p) => phases.appendChild(el("li", undefined, p)));
  const detail = el("p", "detail", "Starting…");
  card.append(kicker, el("div", "card-title", `“${request}”`), phases, detail);
  addCard(card);

  const t0 = performance.now();
  let stopped: number | undefined;
  // The clock stops when the skill is ready: waiting for the user's OK isn't learning time.
  const seconds = () => Math.round(((stopped ?? performance.now()) - t0) / 1000);
  const tick = setInterval(() => (timer.textContent = `${seconds()} s`), 1000);
  const stop = () => {
    stopped ??= performance.now();
    clearInterval(tick);
    timer.textContent = `${seconds()} s`;
  };
  let at = 0;
  const set = (n: number, failed = false) => {
    at = n;
    items.forEach((li, i) => (li.className = i < n ? "done" : i === n ? (failed ? "fail" : "active") : ""));
  };
  set(0);
  return {
    step(stage: string, message: string) {
      detail.textContent = stage === "repair" ? `Fixing: ${message}` : /^writing the code/i.test(message) ? `${message}. The slowest step: usually under a minute.` : message;
      if (stage === "ready") stop();
      if (stage === "submit" || stage === "repair" || (stage === "thinking" && /writing|fresh approach/i.test(message))) set(1);
      else if (stage === "test") set(2);
      else if (stage === "ready") set(3);
    },
    waiting() {
      stop();
      set(3);
      detail.textContent = "Waiting for your OK";
    },
    end(ok: boolean, text: string) {
      stop();
      if (ok) {
        items.forEach((li) => (li.className = "done"));
        label.textContent = `Learned in ${seconds()} s`;
        card.classList.add("learned");
      } else {
        set(at, true);
        label.textContent = "Not learned";
        card.classList.add("failed");
      }
      detail.textContent = text;
    },
  };
}

let current: ReturnType<typeof learnCard> | undefined;
let buildStart = 0;

function buildBegin(request: string) {
  buildStart = performance.now();
  $("build").hidden = false;
  $("build-title").textContent = `Build log: “${request}”`;
  $("spinner").className = "spinner";
  $("steps").replaceChildren();
  current = learnCard(request);
}

function buildStep(text: string, kind: "" | "ok" | "bad" | "wait" = "") {
  const steps = $("steps");
  if (steps.lastElementChild?.querySelector("span")?.textContent === text) return;
  const li = el("li", kind);
  li.append(el("time", undefined, `${((performance.now() - buildStart) / 1000).toFixed(1)}s`), el("span", undefined, text));
  steps.append(li);
}

function buildEnd(ok: boolean, text: string) {
  building = false;
  buildStep(text, ok ? "ok" : "bad");
  $("spinner").className = `spinner ${ok ? "done" : "fail"}`;
  current?.end(ok, text);
  current = undefined;
}

// ---------- consent ----------

/** Shows the consent card, says it aloud, and resolves with the user's choice. */
async function consentCard(cap: Skill | null, message: string, intro = "I've learned a new skill"): Promise<boolean> {
  const node = ($<HTMLTemplateElement>("consent-tpl").content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
  node.querySelector(".card-title")!.textContent = cap?.title ?? "New skill";
  node.querySelector(".card-body")!.textContent = cap?.description ?? message;
  const domains = node.querySelector(".domains")!;
  for (const d of cap?.allowedDomains ?? []) domains.append(el("code", undefined, d));
  if (cap) {
    const passed = cap.tests.filter((t) => t.passed).length;
    const tests = node.querySelector(".tests")!;
    tests.textContent = `Passed ${passed}/${cap.tests.length} live test${cap.tests.length === 1 ? "" : "s"} in the sandbox`;
    tests.classList.toggle("no", passed !== cap.tests.length);
    if (cap.crossChecked && cap.sources?.length) node.querySelector(".cross")!.textContent = `Its answer was cross-checked against ${cap.sources.join(" and ")}`;
  } else node.querySelector(".checks")!.remove();
  addCard(node);
  speak(`${intro}: ${cap?.title ?? "it"}. It will only access ${(cap?.allowedDomains ?? []).join(" and ")}. Should I install it?`);

  const install = await new Promise<boolean>((resolve) => {
    node.querySelector<HTMLButtonElement>(".yes")!.onclick = () => resolve(true);
    node.querySelector<HTMLButtonElement>(".no")!.onclick = () => resolve(false);
  });
  for (const b of node.querySelectorAll("button")) b.disabled = true;
  node.querySelector(install ? ".yes" : ".no")!.textContent = install ? "Installed ✓" : "Declined";
  return install;
}

// Asked by the server (MCP elicitation) inside a build this page started.
client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
  buildStep("Waiting for your OK", "wait");
  current?.waiting();
  const cap = (req.params._meta?.["forge/capability"] ?? null) as Skill | null;
  return { action: "accept", content: { install: await consentCard(cap, req.params.message) } };
});

// A build that finished in the background, e.g. one a voice assistant started and
// stopped waiting for: the server announces it to every connected client.
async function onSkillReady(cap: Skill & { request?: string }, message: string) {
  const install = await consentCard(cap, message, "Good news! I've finished learning a new skill");
  const res = (await client.callTool({ name: "approve_capability", arguments: { id: cap.id, approve: install } })) as CallToolResult;
  if (!install) return say("Okay, I've discarded it.");
  if (res.isError) return say("That skill is no longer waiting for approval.");
  await refresh(cap.name);
  const skill = skills.find((s) => s.name === cap.name);
  if (!skill || !cap.request) return;
  addMsg("note", `Answering the earlier request: “${cap.request}”`);
  const routed = await route(cap.request, skill);
  if (routed) await useSkill(routed);
}

// ---------- skills & tools ----------

async function refresh(freshName?: string) {
  tools = (await client.listTools()).tools;
  const res = await client.callTool({ name: "list_capabilities", arguments: {} });
  skills = ((res.structuredContent as { skills?: Skill[] })?.skills ?? []) as Skill[];
  renderSkills(freshName);
}

client.setNotificationHandler(ToolListChangedNotificationSchema, () => void refresh());

// Every build step arrives as a log message. (Task status is only sampled once
// a second, so fast steps like "Wrote … attempt 2" would be missed.)
let building = false;
const STEP_KIND: Record<string, "" | "ok" | "bad"> = { repair: "bad", ready: "ok" };
client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
  const d = n.params.data as { stage?: string; message?: string; capability?: Skill } | undefined;
  if (n.params.logger === "forge" && d?.stage === "skill_ready" && d.capability) return void onSkillReady(d.capability, d.message ?? "").catch(() => {});
  if (n.params.logger === "forge" && d?.stage === "skill_failed" && d.message) return void say(d.message);
  if (!building || n.params.logger !== "forge" || !d?.message) return;
  buildStep(d.message, STEP_KIND[d.stage ?? ""] ?? "");
  current?.step(d.stage ?? "", d.message);
});

// ---------- routing ----------
// Deciding which skill answers a request is the assistant's job (Alexa+ or an
// LLM reading the tool list). The page asks a model for it (src/assistant.ts);
// without one (mock provider) it falls back to this keyword matcher.

const STOP = new Set("a an and are can could does for from get give how is it its me my now of on please right show tell that the this to was what whats what's when where which who will with would you your yet today".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

function match(utterance: string): Skill | undefined {
  const asked = words(utterance);
  let best: { s: Skill; score: number } | undefined;
  for (const s of skills) {
    const nameWords = new Set(words(s.name.replace(/_/g, " ")));
    const all = new Set([...nameWords, ...words(s.title), ...words(s.description)]);
    let score = 0;
    for (const w of asked) score += nameWords.has(w) ? 2 : all.has(w) ? 1 : 0;
    if (score >= 2 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s;
}

function extractInput(utterance: string, skill: Skill): { input: Record<string, unknown>; missing: string[] } {
  const input: Record<string, unknown> = {};
  const props = skill.inputSchema.properties ?? {};
  const place = utterance.match(/\b(?:in|for|at|of|near|from|to)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/)?.[1];
  const capitalized = utterance.slice(1).match(/\b[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)*/)?.[0];
  const numbers = utterance.match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const [key, p] of Object.entries(props)) {
    if (p.type === "number" || p.type === "integer") {
      if (numbers.length) input[key] = Number(numbers.shift());
    } else if (p.type === "string" || p.type === undefined) {
      const v = place ?? capitalized;
      if (v) input[key] = v;
    }
  }
  const missing = (skill.inputSchema.required ?? []).filter((k) => input[k] === undefined);
  return { input, missing };
}

interface Routed {
  skill: Skill;
  input: Record<string, unknown>;
  missing: string[];
  /** Who picked the skill, for the answer card. */
  via?: string;
}

/** Which skill answers `utterance`, with what inputs. With `only`, just fills that skill's inputs. */
async function route(utterance: string, only?: Skill): Promise<Routed | undefined> {
  type Reply = { fallback?: true; skill?: string | null; input?: Record<string, unknown>; missing?: string[]; by?: string; ms?: number };
  const r: Reply = await fetch("/assistant/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, skills: only ? [only] : skills, only: only?.name }),
  })
    .then((res) => res.json())
    .catch(() => ({ fallback: true }));
  if (r.fallback) {
    const skill = only ?? match(utterance);
    return skill && { skill, ...extractInput(utterance, skill) };
  }
  const skill = skills.find((s) => s.name === r.skill);
  if (!skill) return undefined;
  const via = only ? `Answered with the skill it just learned, ${skill.name} ${JSON.stringify(r.input ?? {})}` : `${r.by} picked ${skill.name} ${JSON.stringify(r.input)} in ${took(r.ms ?? 0)}`;
  return { skill, input: r.input ?? {}, missing: r.missing ?? [], via };
}

// ---------- what Forge did, in full ----------
// Both panels read MCP resources, so any client can show the same evidence.

let health: { provider?: string; model?: string; smith?: string; sandbox?: string; attempts?: number; voice?: boolean } = {};

async function resource<T>(uri: string): Promise<T> {
  const res = await client.readResource({ uri });
  return JSON.parse(String((res.contents[0] as { text?: string }).text ?? "null")) as T;
}

async function openHow() {
  const local = health.provider === "ollama";
  $("how-model").textContent = local ? `A free local model (${health.model}, running on this laptop)` : `The model (${health.model})`;
  $("how-attempts").textContent = String(health.attempts ?? 4);
  $("how-sandbox").textContent = health.sandbox === "docker" ? "a container with no network of its own" : "a separate process (Docker is off on this machine, so it is less isolated)";
  const list = $("sources");
  if (!list.childElementCount) {
    try {
      const sources = await resource<{ name: string; useFor: string; domains: string[]; crossChecked: boolean }[]>("forge://sources");
      for (const src of sources) {
        const li = el("li");
        li.append(el("b", undefined, src.name + (src.crossChecked ? " ✓" : "")), document.createTextNode(src.useFor + " "), el("code", undefined, src.domains.join(", ")));
        if (src.crossChecked) li.title = "Numbers from this source are cross-checked";
        list.append(li);
      }
    } catch {
      list.append(el("li", undefined, "Couldn't load the list of sources."));
    }
  }
  const models = $("models");
  models.replaceChildren();
  const item = (what: string, how: string) => {
    const li = el("li");
    li.append(el("b", undefined, what), document.createTextNode(` ${how}`));
    models.append(li);
  };
  item("Writes and repairs skills:", local ? `${health.model} via Ollama, in short steps each constrained to a JSON schema` : `${health.model} (${health.provider})`);
  item("Picks which skill answers:", `${local ? health.model : "the same provider"}, checking each pick with a yes/no question`);
  item("Speaks:", health.voice ? "Kokoro (82M parameters), on this laptop's CPU" : "the browser's built-in voice");
  $<HTMLDialogElement>("how").showModal();
}

interface SkillRecord extends Skill {
  attempts?: number;
  createdAt?: string;
  spec: { code: string; inputSchema: Skill["inputSchema"]; tests: { input: Record<string, unknown> }[] };
  testReport: {
    fetched: string[];
    results: { passed: boolean; durationMs: number; result?: { speech?: string }; error?: string; crossCheck?: { said?: number; source?: number; skipped?: string } }[];
  };
}

async function openSkill(name: string) {
  let rec: SkillRecord;
  try {
    rec = await resource<SkillRecord>(`forge://capabilities/${name}`);
  } catch {
    return addMsg("note", `Couldn't load the details of ${name}.`);
  }
  $("skill-title").textContent = rec.title;
  $("skill-desc").textContent = rec.description;
  const facts = $("skill-facts");
  facts.replaceChildren();
  const fact = (term: string, ...value: (string | Node)[]) => {
    const dd = el("dd");
    dd.append(...value);
    facts.append(el("dt", undefined, term), dd);
    return dd;
  };
  const code = (t: string) => el("code", undefined, t);
  if (rec.request) fact("You asked", `“${rec.request}”`);
  fact("Tool", code(rec.name));
  const inputs = Object.entries(rec.spec.inputSchema.properties ?? {});
  fact("Inputs", ...(inputs.length ? inputs.flatMap(([k, p]) => [code(k), ` (${p.type ?? "string"})${p.description ? `: ${p.description}` : ""}`, el("br")]) : ["none"]));
  fact("Live data from", `${(rec.sources ?? []).join(", ") || "—"} `, ...rec.allowedDomains.map((d) => code(d + " ")));
  const r = rec.testReport.results[0];
  const test = rec.spec.tests[0];
  if (r && test) {
    const dd = fact("Live test", `${JSON.stringify(test.input)} → `);
    dd.append(el("span", r.passed ? "ok" : "bad", r.passed ? `passed in ${took(r.durationMs)}` : `failed: ${r.error ?? ""}`));
    if (r.result?.speech) fact("It answered", `“${r.result.speech}”`);
    const c = r.crossCheck;
    if (typeof c?.said === "string") fact("Cross-check", el("span", "ok", `✓ the answer quotes “${c.said}”, a headline in the ${rec.sources?.join(" and ") ?? "source"} feed it read`));
    else if (c?.source !== undefined) fact("Cross-check", el("span", "ok", `✓ the answer said ${c.said}; ${rec.sources?.join(" and ") ?? "the source"} reported ${c.source}`));
    else if (c?.skipped) fact("Cross-check", `skipped: ${c.skipped}`);
    else if (rec.crossChecked) fact("Cross-check", el("span", "ok", "✓ matched the source"));
    else fact("Cross-check", "none for this source (its answers aren't numbers Forge has a reference for)");
  }
  const fetched = [...new Set(rec.testReport.fetched ?? [])];
  if (fetched.length) fact("Live requests in the test", ...fetched.slice(0, 6).flatMap((u) => [code(u), el("br")]));
  fact("Built", `${rec.attempts ?? 1} attempt${rec.attempts === 1 ? "" : "s"}${rec.createdAt ? ` · ${new Date(rec.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""} · used ${rec.uses}×`);
  $("skill-code").textContent = rec.spec.code;
  const askBtn = $<HTMLButtonElement>("skill-ask");
  askBtn.hidden = !rec.request;
  askBtn.onclick = () => {
    $<HTMLDialogElement>("skill").close();
    void ask(rec.request!);
  };
  $<HTMLDialogElement>("skill").showModal();
}

$("howBtn").onclick = () => void openHow();

// ---------- the conversation ----------

async function useSkill({ skill, input, missing, via }: Routed) {
  if (missing.length) {
    say(`I can do that with ${skill.title}, but I need the ${missing.join(" and ")}.`);
    return;
  }
  const direct = tools.some((t) => t.name === skill.name);
  const t0 = performance.now();
  const res = (await client.callTool(
    direct ? { name: skill.name, arguments: input } : { name: "use_skill", arguments: { name: skill.name, input } },
  )) as CallToolResult;
  const sc = res.structuredContent as { speech?: string; data?: unknown } | undefined;
  if (res.isError && sc?.speech) return say(sc.speech); // e.g. the source is down right now
  if (res.isError || !sc?.speech) {
    say(`Sorry, ${skill.title} ran into a problem.`);
    addMsg("note", String((res.content[0] as { text?: string })?.text ?? "").slice(0, 300));
    return;
  }
  const ran = `ran in the sandbox in ${took(performance.now() - t0)}`;
  answerCard(skill, sc.speech, sc.data, via ? `${via} · ${ran}` : `Learned skill · ${ran}`);
  speak(sc.speech);
  void refresh();
}

/** Builds a skill for `utterance`; returns it once installed. */
async function learn(utterance: string): Promise<Skill | undefined> {
  say("I can't do that yet. Give me a minute — I'll learn how.");
  buildBegin(utterance);
  building = true;
  let result: CallToolResult | undefined;
  const stream = client.experimental.tasks.callToolStream({ name: "forge_capability", arguments: { request: utterance } }, CallToolResultSchema, {
    timeout: 10 * 60_000,
  });
  for await (const msg of stream) {
    if (msg.type === "taskCreated") buildStep(`Task ${msg.task.taskId.slice(0, 8)} started`);
    else if (msg.type === "result") result = msg.result as CallToolResult;
    else if (msg.type === "error") {
      buildEnd(false, msg.error.message);
      say("Something went wrong while I was learning that.");
      return undefined;
    }
  }
  const sc = result?.structuredContent as { status?: string; reason?: string; capability?: Skill } | undefined;
  if (sc?.status === "installed") {
    buildEnd(true, `Installed ${sc.capability?.name ?? "the skill"}`);
    await refresh(sc.capability?.name);
    return skills.find((s) => s.name === sc.capability?.name);
  }
  if (sc?.status === "declined") {
    buildEnd(false, "Not installed");
    say("Okay, I won't install it.");
  } else {
    buildEnd(false, sc?.reason ?? "Couldn't build it");
    say(sc?.reason ?? "I couldn't learn that one, sorry.");
  }
  return undefined;
}

async function learnThenAnswer(utterance: string) {
  try {
    const learned = await learn(utterance);
    const routed = learned && (await route(utterance, learned));
    if (routed) await useSkill(routed);
  } catch (e) {
    building = false;
    say("Sorry, something went wrong while I was learning that.");
    addMsg("note", e instanceof Error ? e.message : String(e));
  }
}

async function ask(utterance: string) {
  if (busy || !utterance.trim()) return;
  busy = true;
  state.thinking = true;
  showState();
  stopSpeaking();
  addMsg("user", utterance);
  const doneTyping = typing();
  try {
    const routed = await route(utterance);
    if (routed) await useSkill(routed);
    else if (building) say("I'm still learning the last thing you asked. Ask me this again in a minute.");
    // Learning runs in the background, so the conversation can go on meanwhile.
    else void learnThenAnswer(utterance);
  } catch (e) {
    say("Sorry, something went wrong.");
    addMsg("note", e instanceof Error ? e.message : String(e));
  } finally {
    doneTyping();
    busy = false;
    state.thinking = false;
    showState();
  }
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  void ask(text);
});

// ---------- voice in ----------

type Recognition = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void };
const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
let rec: Recognition | undefined;
orb.onclick = () => {
  if (state.speaking) return stopSpeaking();
  if (rec) return rec.stop();
  if (!SR) return addMsg("note", "Voice input needs Chrome. You can type instead.");
  rec = new SR() as Recognition;
  rec.lang = "en-IN";
  rec.interimResults = true;
  state.listening = true;
  showState();
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    input.value = r[0].transcript;
    if (r.isFinal) {
      input.value = "";
      void ask(r[0].transcript);
    }
  };
  rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && addMsg("note", `Mic: ${e.error}`);
  rec.onend = () => {
    rec = undefined;
    state.listening = false;
    showState();
  };
  rec.start();
};

// ---------- voice out ----------

setupVoice({
  picker: $<HTMLSelectElement>("voice"),
  status: $("voiceStatus"),
  enabled: () => $<HTMLInputElement>("speak").checked,
  onSpeaking: (on) => {
    state.speaking = on;
    showState();
  },
});
$<HTMLInputElement>("speak").addEventListener("change", (e) => (e.target as HTMLInputElement).checked || stopSpeaking());
document.addEventListener("keydown", (e) => e.key === "Escape" && stopSpeaking());

// ---------- start ----------

renderChips();
showState();
(async () => {
  const conn = $("conn");
  try {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.origin));
    await client.connect(transport);
    conn.lastElementChild!.textContent = "Connected";
    conn.title = `MCP server: ${client.getServerVersion()?.title ?? client.getServerVersion()?.name}`;
    conn.className = "conn ok";
    $("proto").textContent = transport.protocolVersion ?? "";
    health = await (await fetch("/health")).json();
    $("mode").textContent = health.provider === "ollama" ? `${health.model} · on this laptop` : `${health.provider} · ${health.model}`;
    await refresh();
  } catch (e) {
    conn.lastElementChild!.textContent = "Not connected";
    conn.title = e instanceof Error ? e.message : String(e);
    conn.className = "conn bad";
  }
})();
