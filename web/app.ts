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
  /** What kind of answer it gives: shown as a label on every answer. */
  kind?: "live" | "knowledge" | "fact" | "calculation";
}

interface Passage {
  topic: string;
  text: string;
}
type AdviceArea = "medical" | "legal" | "financial";
/** The question being answered, and whether it asks for advice: used when a knowledge skill's passages become an answer. */
let asking: { question: string; advice?: AdviceArea; kind?: string } = { question: "" };

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

// One of each kind: live data, knowledge, a fact, a calculation, today's news, creative writing.
const SUGGESTIONS = [
  "What's the weather in Pune right now?",
  "Explain how photosynthesis works",
  "What's the capital of Australia?",
  "What is 18% of 2500?",
  "What's today's hot news?",
  "Write a short poem about the monsoon",
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
// API jargon the launch and news sources use.
const LABELS: Record<string, string> = { net: "Launch time", lsp_name: "Provider", lsp: "Provider", pad: "Launch pad" };
function label(key: string): string {
  if (LABELS[key.toLowerCase()]) return LABELS[key.toLowerCase()];
  const words = key
    .replace(/pm2_5/i, "PM2.5")
    .split(/[_\s]+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase() === "pm2.5" ? "PM2.5" : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

// The answer the user just heard, so a follow-up question can be about it.
let last: { question?: string; skill: string; speech: string; data: unknown } | undefined;
let lastQuestion = "";
/** A short follow-up ("What about ISRO?") rewritten as a full question by the last route() call. */
let understood: string | undefined;

interface AnswerExtras {
  /** A knowledge answer written from the passages and checked against them (false: the article's own words). */
  composed?: boolean;
  passages?: Passage[];
  /** The advice note shown under an answer to a health, legal or money question. */
  note?: string;
}

/** The label every answer carries: where it came from and how it was checked. */
function kindTag(skill: Skill, extras: AnswerExtras): HTMLElement | undefined {
  if (extras.passages?.length) return extras.composed ? el("span", "tag ok", "✓ Written from the article, checked against it") : el("span", "tag", "The article's own words");
  const label = { live: "Live data", knowledge: "Reference", fact: "Exact fact", calculation: "Calculated" }[skill.kind ?? "live"];
  return el("span", "tag kind", label);
}

function answerCard(skill: Skill, speech: string, data: unknown, footer: string, extras: AnswerExtras = {}) {
  last = { question: lastQuestion, skill: skill.name, speech, data };
  const card = el("div", "card answer");
  card.append(el("div", "card-kicker", skill.title));
  // The spoken answer ends with its citation; show that as a tag under the answer.
  const at = speech.lastIndexOf("Source:");
  card.append(el("div", "card-title", at > 0 ? speech.slice(0, at).trim() : speech));
  // A knowledge answer's data is only its topics and passages, shown below instead.
  if (data && typeof data === "object" && !extras.passages?.length) {
    const stats = el("div", "stats");
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === null || typeof v === "object" || hiddenKey(k) || String(v).length > 40) continue;
      const stat = el("div", typeof v === "number" ? "stat" : "stat text");
      stat.append(el("b", undefined, display(v) + (typeof v === "number" ? unit(k) : "")), el("span", undefined, label(k)));
      stat.title = `${label(k)}: ${display(v)}`;
      stats.append(stat);
      if (stats.childElementCount === 6) break;
    }
    if (stats.childElementCount) card.append(stats);
  }
  if (extras.note) card.append(el("p", "advice-note", extras.note));
  const cite = el("div", "cite");
  const tag = kindTag(skill, extras);
  if (tag) cite.append(tag);
  if (at > 0) cite.append(el("span", "tag src", speech.slice(at).trim().replace(/\.$/, "")));
  else if (extras.passages?.length) cite.append(el("span", "tag src", `Source: ${skill.sources?.join(" and ") ?? "Wikipedia"}`));
  if (skill.crossChecked && !extras.passages?.length) cite.append(el("span", "tag ok", "✓ cross-checked when learned"));
  if (extras.note) cite.append(el("span", "tag warn", "General information, not professional advice"));
  if (cite.childElementCount) card.append(cite);
  if (extras.passages?.length) {
    const details = el("details", "passages");
    details.append(el("summary", undefined, `Read the ${extras.passages.length} passages it used`));
    const list = el("ol");
    for (const p of extras.passages) {
      const li = el("li");
      li.append(el("b", undefined, p.topic), document.createTextNode(` ${p.text}`));
      list.append(li);
    }
    details.append(list);
    card.append(details);
  }
  const via = el("div", "via", footer);
  const more = el("button", "more", "How I got this");
  more.type = "button";
  more.onclick = () => void openSkill(skill.name);
  via.append(more);
  card.append(via);
  addCard(card);
}

/**
 * Shows a skill's answer. A knowledge skill returns the article's passages: the
 * assistant writes a short answer to the exact question from them, checked
 * against them, or falls back to the skill's own words (the article's summary).
 * Returns what should be said aloud.
 */
async function presentAnswer(skill: Skill, speech: string, data: unknown, footer: string): Promise<string> {
  const passages = (data as { passages?: Passage[] } | null)?.passages;
  if (!Array.isArray(passages) || !passages.length) {
    answerCard(skill, speech, data, footer);
    return speech;
  }
  const r: { speech?: string; checked?: boolean; note?: string; by?: string; ms?: number } = await fetch("/assistant/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: asking.question || lastQuestion, passages, advice: asking.advice }),
  })
    .then((res) => res.json())
    .catch(() => ({}));
  const composed = Boolean(r.checked && r.speech);
  const said = composed ? `${r.speech} Source: ${skill.sources?.join(" and ") ?? "Wikipedia"}.` : speech;
  const how = composed ? ` · ${r.by} wrote it from ${passages.length} passages in ${took(r.ms ?? 0)}` : " · the written answer didn't pass the check, so these are the article's own words";
  answerCard(skill, said, data, footer + how, { composed, passages, note: r.note });
  return r.note ? `${said} ${r.note}` : said;
}

/**
 * A follow-up about the last answer that no skill fits ("could this launch be delayed?"),
 * answered from that answer and general knowledge. Null when it needs live data.
 */
async function followUp(utterance: string): Promise<boolean> {
  if (!last) return false;
  const r: { speech: string | null; code?: string; by?: string; ms?: number } = await fetch("/assistant/followup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, last }),
  })
    .then((res) => res.json())
    .catch(() => ({ speech: null }));
  if (!r.speech) return false;
  const card = el("div", "card answer follow");
  card.append(el("div", "card-kicker", "Follow-up"), el("div", "card-title", r.speech));
  if (r.code) {
    const pre = el("pre", "code answer-code");
    pre.append(el("code", undefined, r.code));
    const copy = el("button", "copy", "Copy");
    copy.type = "button";
    copy.onclick = () => {
      void navigator.clipboard?.writeText(r.code!).then(() => (copy.textContent = "Copied"));
    };
    const wrap = el("div", "code-wrap");
    wrap.append(pre, copy);
    card.append(wrap);
  }
  const cite = el("div", "cite");
  cite.append(el("span", "tag src", "From my last answer + general knowledge"), el("span", "tag warn", "Not live data · not cross-checked"));
  card.append(cite, el("div", "via", `${r.by} answered in ${took(r.ms ?? 0)}; it may only repeat numbers from the last answer, so anything current needs a skill`));
  addCard(card);
  speak(r.speech);
  return true;
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

const PHASES = ["Find a source", "Write the code", "Test & cross-check", "Answer · keep it?"];

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
      // Code that passed before is reused: no writing, straight to the live test.
      if (/^Found code/.test(message)) {
        items[1].textContent = "Reuse verified code";
        set(1);
      } else if (/didn't pass this time/.test(message)) items[1].textContent = PHASES[1];
      if (stage === "submit" || stage === "repair" || (stage === "thinking" && /writing|fresh approach/i.test(message))) set(1);
      else if (stage === "test") set(2);
      else if (stage === "ready") set(3);
    },
    waiting(answered = false) {
      stop();
      set(3);
      detail.textContent = answered ? "Answered below. Keep the skill for next time?" : "Waiting for your OK";
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
  $("emptyLog").hidden = true;
  $("app").classList.add("building");
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
  $("app").classList.remove("building");
  buildStep(text, ok ? "ok" : "bad");
  $("spinner").className = `spinner ${ok ? "done" : "fail"}`;
  current?.end(ok, text);
  current = undefined;
}

// ---------- consent ----------

/** What a new skill answered for the user's own request in its live test, before it is installed. */
interface FirstAnswer {
  speech: string;
  data: unknown;
  input: Record<string, unknown>;
}

/**
 * Answers right away when the new skill's live test already did (that test ran on
 * the user's own request), then asks whether to keep the skill for next time.
 * Says it aloud and resolves with the user's choice.
 */
async function consentCard(cap: Skill | null, message: string, answer?: FirstAnswer, intro = "I've learned a new skill"): Promise<boolean> {
  const inputs = answer && Object.keys(answer.input).length ? ` with ${JSON.stringify(answer.input)}` : "";
  const heard = answer && cap ? await presentAnswer(cap, answer.speech, answer.data, `Answered by the new skill's live test${inputs}, before you decide to keep it`) : answer?.speech;
  const node = ($<HTMLTemplateElement>("consent-tpl").content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
  if (answer) {
    node.querySelector(".card-kicker")!.lastChild!.textContent = " Keep this skill for next time?";
    node.querySelector(".yes")!.textContent = "Keep it";
  }
  node.querySelector(".card-title")!.textContent = cap?.title ?? "New skill";
  node.querySelector(".card-body")!.textContent = cap?.description ?? message;
  const domains = node.querySelector(".domains")!;
  for (const d of cap?.allowedDomains ?? []) domains.append(el("code", undefined, d));
  if (cap && !cap.allowedDomains.length) node.querySelector(".access")!.textContent = "Doesn't use the internet: it only calculates";
  if (cap) {
    const passed = cap.tests.filter((t) => t.passed).length;
    const tests = node.querySelector(".tests")!;
    tests.textContent = `Passed ${passed}/${cap.tests.length} live test${cap.tests.length === 1 ? "" : "s"} in the sandbox`;
    tests.classList.toggle("no", passed !== cap.tests.length);
    if (cap.crossChecked && cap.sources?.length) node.querySelector(".cross")!.textContent = `Its answer was cross-checked against ${cap.sources.join(" and ")}`;
  } else node.querySelector(".checks")!.remove();
  addCard(node);
  const sites = (cap?.allowedDomains ?? []).join(" and ");
  speak(
    answer
      ? `${heard} I learned a new skill for this. Want me to keep it, so next time it's instant? ${sites ? `It will only access ${sites}.` : "It doesn't use the internet."}`
      : `${intro}: ${cap?.title ?? "it"}. It will only access ${sites}. Should I install it?`,
  );

  const install = await new Promise<boolean>((resolve) => {
    node.querySelector<HTMLButtonElement>(".yes")!.onclick = () => resolve(true);
    node.querySelector<HTMLButtonElement>(".no")!.onclick = () => resolve(false);
    // Or by voice: "yes, keep it" / "no thanks" (see ask()).
    pendingConsent = resolve;
  });
  pendingConsent = undefined;
  for (const b of node.querySelectorAll("button")) b.disabled = true;
  node.querySelector(install ? ".yes" : ".no")!.textContent = install ? (answer ? "Kept ✓" : "Installed ✓") : answer ? "Not kept" : "Declined";
  return install;
}

// Asked by the server (MCP elicitation) inside a build this page started.
client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
  const cap = (req.params._meta?.["forge/capability"] ?? null) as Skill | null;
  const answer = req.params._meta?.["forge/answer"] as FirstAnswer | undefined;
  buildStep(answer ? "Answered from the live test; waiting for your OK to keep the skill" : "Waiting for your OK", "wait");
  current?.waiting(Boolean(answer));
  return { action: "accept", content: { install: await consentCard(cap, req.params.message, answer) } };
});

// A build that finished in the background, e.g. one a voice assistant started and
// stopped waiting for: the server announces it to every connected client.
async function onSkillReady(cap: Skill & { request?: string }, message: string, answer?: FirstAnswer) {
  if (answer && cap.request) addMsg("note", `About your earlier question: “${cap.request}”`);
  const install = await consentCard(cap, message, answer, "Good news! I've finished learning a new skill");
  const res = (await client.callTool({ name: "approve_capability", arguments: { id: cap.id, approve: install } })) as CallToolResult;
  if (!install) return say(answer ? "Okay, I won't keep it." : "Okay, I've discarded it.");
  if (res.isError) return say("That skill is no longer waiting for approval.");
  await refresh(cap.name);
  const skill = skills.find((s) => s.name === cap.name);
  if (answer) return say("Kept. Next time it's instant.");
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
  const d = n.params.data as { stage?: string; message?: string; capability?: Skill; answer?: FirstAnswer } | undefined;
  if (n.params.logger === "forge" && d?.stage === "skill_ready" && d.capability) return void onSkillReady(d.capability, d.message ?? "", d.answer).catch(() => {});
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
async function route(utterance: string, only?: Skill, kind?: string): Promise<Routed | undefined> {
  type Reply = { fallback?: true; skill?: string | null; input?: Record<string, unknown>; missing?: string[]; by?: string; ms?: number; rewritten?: string };
  const r: Reply = await fetch("/assistant/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, skills: only ? [only] : skills, only: only?.name, previous: lastQuestion || undefined, kind }),
  })
    .then((res) => res.json())
    .catch(() => ({ fallback: true }));
  understood = r.rewritten;
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
      const sources = await resource<{ name: string; kind?: string; useFor: string; domains: string[]; crossChecked: boolean }[]>("forge://sources");
      const KIND: Record<string, string> = { live: "Live data", knowledge: "Knowledge", fact: "Exact facts", calculation: "Calculation" };
      for (const src of sources) {
        const li = el("li");
        li.append(
          el("b", undefined, src.name + (src.crossChecked ? " ✓" : "")),
          el("span", "kind", KIND[src.kind ?? "live"]),
          document.createTextNode(src.useFor + " "),
          el("code", undefined, src.domains.length ? src.domains.join(", ") : "no website"),
        );
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
  speak(await presentAnswer(skill, sc.speech, sc.data, via ? `${via} · ${ran}` : `Learned skill · ${ran}`));
  void refresh();
}

/** Builds a skill for `utterance`. `answered`: the user already heard the answer (from its live test). */
async function learn(utterance: string): Promise<{ skill?: Skill; answered: boolean }> {
  say("I don't have a skill for that yet. Let me see if I can learn one.");
  buildBegin(utterance);
  building = true;
  let result: CallToolResult | undefined;
  const kind = ["live", "knowledge", "fact", "calculation"].includes(asking.kind ?? "") ? asking.kind : undefined;
  const stream = client.experimental.tasks.callToolStream({ name: "forge_capability", arguments: { request: utterance, ...(kind ? { kind } : {}) } }, CallToolResultSchema, {
    timeout: 10 * 60_000,
  });
  for await (const msg of stream) {
    if (msg.type === "taskCreated") buildStep(`Task ${msg.task.taskId.slice(0, 8)} started`);
    else if (msg.type === "result") result = msg.result as CallToolResult;
    else if (msg.type === "error") {
      buildEnd(false, msg.error.message);
      say("Something went wrong while I was learning that.");
      return { answered: false };
    }
  }
  const sc = result?.structuredContent as { status?: string; reason?: string; capability?: Skill; answer?: FirstAnswer } | undefined;
  const answered = Boolean(sc?.answer);
  if (sc?.status === "installed") {
    buildEnd(true, answered ? `Answered, and kept ${sc.capability?.name ?? "the skill"} for next time` : `Installed ${sc.capability?.name ?? "the skill"}`);
    await refresh(sc.capability?.name);
    if (answered) say("Kept. Next time it's instant.");
    return { skill: skills.find((s) => s.name === sc.capability?.name), answered };
  }
  if (sc?.status === "declined") {
    buildEnd(answered, answered ? "Answered; the skill wasn't kept" : "Not installed");
    say(answered ? "Okay, I won't keep it. Ask again any time and I'll learn it again." : "Okay, I won't install it.");
  } else {
    buildEnd(false, sc?.reason ?? "Couldn't build it");
    say(sc?.reason ?? "I couldn't learn that one, sorry.");
  }
  return { answered };
}

async function learnThenAnswer(utterance: string) {
  try {
    const { skill, answered } = await learn(utterance);
    if (answered || !skill) return;
    const routed = await route(utterance, skill);
    if (routed) await useSkill(routed);
  } catch (e) {
    building = false;
    say("Sorry, something went wrong while I was learning that.");
    addMsg("note", e instanceof Error ? e.message : String(e));
  }
}

type Sorted = {
  type?: "live" | "knowledge" | "fact" | "calculation" | "creative" | "chat" | "advice" | "personal" | "emergency";
  advice?: AdviceArea;
  speech?: string;
  rewritten?: string;
  fallback?: true;
  by?: string;
  ms?: number;
};

/** What kind of question this is (src/answers.ts): an emergency, a skill's job, or one answered without a skill. */
async function sortQuestion(utterance: string): Promise<Sorted> {
  return fetch("/assistant/sort", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, previous: lastQuestion || undefined }),
  })
    .then((res) => res.json())
    .catch(() => ({ fallback: true }));
}

const HELPLINES: [string, string][] = [
  ["Emergency 112", "tel:112"],
  ["Ambulance 108", "tel:108"],
  ["Tele-MANAS 14416", "tel:14416"],
];

/** Said first and plainly, with the numbers to call: no model, no skill. */
function emergencyCard(speech: string) {
  const card = el("div", "card emergency");
  card.append(el("div", "card-kicker", "Get help now"), el("div", "card-title", speech));
  const row = el("div", "actions");
  for (const [label, href] of HELPLINES) {
    const a = el("a", "call", label);
    a.href = href;
    row.append(a);
  }
  card.append(row);
  addCard(card);
  speak(speech);
}

/** Personal data or an action: what can't be done, and a few things that can. */
function cannotCard(speech: string) {
  const card = el("div", "card cannot");
  card.append(el("div", "card-kicker", "Not something I can do"), el("p", "card-body", speech));
  const chips = el("div", "chips small");
  for (const text of SUGGESTIONS.slice(0, 4)) {
    const b = el("button", undefined, text);
    b.type = "button";
    b.onclick = () => void ask(text);
    chips.append(b);
  }
  card.append(chips);
  addCard(card);
  speak(speech);
}

/** Chat and creative writing: the model's own words, labelled, with nothing to check. */
async function chatReply(utterance: string, type: "chat" | "creative") {
  const r: { speech?: string | null; by?: string; ms?: number } = await fetch("/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, type }),
  })
    .then((res) => res.json())
    .catch(() => ({}));
  if (!r.speech) return say("Sorry, I couldn't come up with anything for that.");
  if (type === "chat") return say(r.speech);
  const card = el("div", "card answer creative");
  card.append(el("div", "card-kicker", "Written for you"), el("div", "card-title", r.speech));
  const cite = el("div", "cite");
  cite.append(el("span", "tag warn", "Written by the model · not checked"));
  card.append(cite, el("div", "via", `${r.by} wrote it in ${took(r.ms ?? 0)}`));
  addCard(card);
  speak(r.speech);
}

// A spoken "yes, keep it" or "not now" answers the open "Keep this skill?" card.
let pendingConsent: ((keep: boolean) => void) | undefined;
const YES = /^(yes|yeah|yep|sure|ok(ay)?|keep( it)?|please do|do it)\b/i;
const NO = /^(no|nope|not now|skip( it)?|don'?t|no thanks|discard)\b/i;

async function ask(utterance: string) {
  if (busy || !utterance.trim()) return;
  $("app").classList.remove("left-open");
  $("scrim").hidden = !$("app").classList.contains("right-open");
  if (pendingConsent && (YES.test(utterance.trim()) || NO.test(utterance.trim()))) {
    addMsg("user", utterance);
    pendingConsent(YES.test(utterance.trim()));
    return;
  }
  busy = true;
  state.thinking = true;
  showState();
  stopSpeaking();
  addMsg("user", utterance);
  const doneTyping = typing();
  try {
    // 1. What kind of question: emergencies first, then whether it needs a skill at all.
    const sorted = await sortQuestion(utterance);
    if (sorted.type === "emergency" && sorted.speech) return emergencyCard(sorted.speech);
    const asked = sorted.rewritten ?? utterance;
    if (asked !== utterance) addMsg("note", `Understood as: “${asked}”`);
    if (sorted.type === "personal" && sorted.speech) return cannotCard(sorted.speech);
    if (sorted.type === "chat" || sorted.type === "creative") {
      // "Show me that as code", "is that safe?": about the last answer, not new chat.
      if (last && (await followUp(asked))) return;
      return await chatReply(asked, sorted.type);
    }
    // 2. A skill's job: live data, knowledge, a fact, a calculation (or advice, from knowledge).
    // Advice is answered from knowledge (Wikipedia), with its note.
    const kind = sorted.type === "advice" ? "knowledge" : sorted.type;
    asking = { question: asked, advice: sorted.advice, kind };
    const routed = await route(asked, undefined, kind);
    if (routed) {
      lastQuestion = asked;
      await useSkill(routed);
    } else if (await followUp(asked)) {
      // answered from the last answer; nothing to learn
    } else if (building) say("I'm still learning the last thing you asked. Ask me this again in a minute.");
    // Learning runs in the background, so the conversation can go on meanwhile.
    else {
      lastQuestion = asked;
      void learnThenAnswer(asked);
    }
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
  voiceTurn = false;
  void ask(text);
});

// ---------- panes ----------
// Wide screens: the activity pane collapses (remembered). Narrow: both side panes are drawers.

const app = $("app");
const narrow = (px: number) => window.matchMedia(`(max-width: ${px}px)`).matches;
const remember = (key: string, value?: string) => {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
};
function syncPanes() {
  const open = narrow(1180) ? app.classList.contains("right-open") : !app.classList.contains("right-closed");
  $("rightToggle").setAttribute("aria-expanded", String(open));
  $("scrim").hidden = !(app.classList.contains("right-open") || app.classList.contains("left-open"));
}
function toggleRight(show?: boolean) {
  if (narrow(1180)) {
    app.classList.remove("left-open");
    app.classList.toggle("right-open", show);
  } else {
    app.classList.toggle("right-closed", show === undefined ? undefined : !show);
    remember("forge.activity", app.classList.contains("right-closed") ? "closed" : "open");
  }
  syncPanes();
}
if (remember("forge.activity") === "closed") app.classList.add("right-closed");
$("rightToggle").onclick = () => toggleRight();
$("rightClose").onclick = () => toggleRight(false);
$("leftToggle").onclick = () => {
  app.classList.remove("right-open");
  app.classList.toggle("left-open");
  syncPanes();
};
$("scrim").onclick = () => {
  app.classList.remove("left-open", "right-open");
  syncPanes();
};
window.addEventListener("resize", syncPanes);
syncPanes();

// ---------- voice in ----------
// Conversation mode: after a spoken answer to a spoken question, the mic stays open
// for a few seconds, like Alexa's follow-up mode, so the next question needs no click.

type Recognition = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void };
const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
let rec: Recognition | undefined;
/** The last question was spoken, so a spoken answer may be followed by listening again. */
let voiceTurn = false;
const FOLLOW_UP_MS = 8000;

function listen(followUp = false) {
  if (!SR) return addMsg("note", "Voice input needs Chrome. You can type instead.");
  rec = new SR() as Recognition;
  rec.lang = "en-IN";
  rec.interimResults = true;
  state.listening = true;
  showState();
  let heard = false;
  // A follow-up window closes by itself if nothing is said.
  const closer = followUp ? setTimeout(() => !heard && rec?.stop(), FOLLOW_UP_MS) : undefined;
  if (followUp) $("hint").textContent = "Listening for a follow-up… (or click the mic to stop)";
  rec.onresult = (e) => {
    heard = true;
    const r = e.results[e.results.length - 1];
    input.value = r[0].transcript;
    if (r.isFinal) {
      input.value = "";
      voiceTurn = true;
      void ask(r[0].transcript);
    }
  };
  rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && addMsg("note", `Mic: ${e.error}`);
  rec.onend = () => {
    clearTimeout(closer);
    rec = undefined;
    state.listening = false;
    showState();
  };
  rec.start();
}

orb.onclick = () => {
  if (state.speaking) return stopSpeaking();
  if (rec) return rec.stop();
  listen();
};

// ---------- voice out ----------

setupVoice({
  picker: $<HTMLSelectElement>("voice"),
  status: $("voiceStatus"),
  enabled: () => $<HTMLInputElement>("speak").checked,
  onSpeaking: (on) => {
    state.speaking = on;
    showState();
    // Conversation mode: a spoken answer to a spoken question opens the mic again.
    if (!on && voiceTurn && conversation() && !rec && !busy) listen(true);
  },
});
$<HTMLInputElement>("speak").addEventListener("change", (e) => (e.target as HTMLInputElement).checked || stopSpeaking());
const conversation = () => $<HTMLInputElement>("converse").checked;
try {
  $<HTMLInputElement>("converse").checked = localStorage.getItem("forge.converse") !== "off";
} catch {}
$<HTMLInputElement>("converse").addEventListener("change", (e) => {
  try {
    localStorage.setItem("forge.converse", (e.target as HTMLInputElement).checked ? "on" : "off");
  } catch {}
});
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
