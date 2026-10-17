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
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $<HTMLOListElement>("chat");
const ring = $("ring");
const input = $<HTMLInputElement>("say");

const client = new Client({ name: "forge-web", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
let tools: Tool[] = [];
let skills: Skill[] = [];
let busy = false;

// ---------- rendering ----------

function scroll() {
  chat.scrollTop = chat.scrollHeight;
}

function addMsg(kind: "user" | "bot" | "note", text: string) {
  const li = document.createElement("li");
  li.className = `msg ${kind}`;
  li.textContent = text;
  chat.append(li);
  scroll();
  return li;
}

function addCard(el: HTMLElement) {
  const li = document.createElement("li");
  li.style.display = "contents";
  li.append(el);
  chat.append(li);
  scroll();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Bookkeeping fields APIs commonly return that mean nothing to a listener.
const HIDDEN_KEYS = new Set(["interval", "id", "generationtime_ms", "utc_offset_seconds", "elevation"]);

function display(v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  if (typeof v === "number" && !Number.isInteger(v)) return String(Math.round(v * 10) / 10);
  return String(v);
}

function answerCard(skill: Skill | undefined, speech: string, data: unknown) {
  const card = el("div", "card");
  card.append(el("div", "card-kicker", skill ? `${skill.title} · learned skill` : "Answer"));
  card.append(el("div", "card-title", speech));
  if (data && typeof data === "object") {
    const dl = el("dl");
    for (const [k, v] of Object.entries(data as Record<string, unknown>).slice(0, 8)) {
      if (v === null || typeof v === "object" || HIDDEN_KEYS.has(k)) continue;
      dl.append(el("dt", undefined, k.replace(/_/g, " ")), el("dd", undefined, display(v)));
    }
    if (dl.childElementCount) card.append(dl);
  }
  addCard(card);
}

function speak(text: string) {
  if (!$<HTMLInputElement>("speak").checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
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
    list.append(el("li", "empty", "Nothing learned yet. Ask for something new."));
    return;
  }
  for (const s of skills) {
    const li = el("li", s.name === freshName ? "fresh" : undefined);
    li.append(el("div", "name", s.title), el("code", undefined, s.name));
    const passed = s.tests.filter((t) => t.passed).length;
    li.append(el("div", "meta", `${passed}/${s.tests.length} live tests · ${s.allowedDomains.join(", ")} · used ${s.uses}×`));
    list.append(li);
  }
}

// ---------- build timeline ----------

let buildStart = 0;
function buildBegin(request: string) {
  buildStart = performance.now();
  $("build").hidden = false;
  $("build-title").textContent = `Learning: “${request}”`;
  $("spinner").className = "spinner";
  $("steps").replaceChildren();
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
}

// ---------- consent (MCP elicitation) ----------

client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
  const cap = (req.params._meta?.["forge/capability"] ?? null) as Skill | null;
  buildStep("Waiting for your OK", "wait");
  const node = ($<HTMLTemplateElement>("consent-tpl").content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
  node.querySelector(".card-title")!.textContent = cap?.title ?? "New skill";
  node.querySelector(".card-body")!.textContent = cap?.description ?? req.params.message;
  const domains = node.querySelector(".domains")!;
  for (const d of cap?.allowedDomains ?? []) domains.append(el("li", undefined, d));
  if (cap) {
    const passed = cap.tests.filter((t) => t.passed).length;
    const checked = cap.crossChecked && cap.sources?.length ? `, answer cross-checked against ${cap.sources.join(" and ")}` : "";
    node.querySelector(".tests")!.textContent = `✓ Passed ${passed}/${cap.tests.length} live tests in the sandbox${checked}`;
  }
  addCard(node);
  speak(`I've learned a new skill: ${cap?.title ?? "it"}. It will only access ${(cap?.allowedDomains ?? []).join(" and ")}. Should I install it?`);

  const install = await new Promise<boolean>((resolve) => {
    node.querySelector<HTMLButtonElement>(".yes")!.onclick = () => resolve(true);
    node.querySelector<HTMLButtonElement>(".no")!.onclick = () => resolve(false);
  });
  for (const b of node.querySelectorAll("button")) b.disabled = true;
  node.querySelector(install ? ".yes" : ".no")!.textContent = install ? "Installed" : "Declined";
  return { action: "accept", content: { install } };
});

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
  const d = n.params.data as { stage?: string; message?: string } | undefined;
  if (!building || n.params.logger !== "forge" || !d?.message) return;
  buildStep(d.message, STEP_KIND[d.stage ?? ""] ?? "");
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
  const took = `${((r.ms ?? 0) / 1000).toFixed(1)} s`;
  addMsg("note", skill ? `${r.by} picked ${skill.name} ${JSON.stringify(r.input)} in ${took}` : `${r.by}: no learned skill fits (${took})`);
  return skill && { skill, input: r.input ?? {}, missing: r.missing ?? [] };
}

// ---------- the conversation ----------

async function useSkill({ skill, input, missing }: Routed) {
  if (missing.length) {
    say(`I can do that with ${skill.title}, but I need the ${missing.join(" and ")}.`);
    return;
  }
  const direct = tools.some((t) => t.name === skill.name);
  const res = (await client.callTool(
    direct ? { name: skill.name, arguments: input } : { name: "use_skill", arguments: { name: skill.name, input } },
  )) as CallToolResult;
  const sc = res.structuredContent as { speech?: string; data?: unknown } | undefined;
  if (res.isError || !sc?.speech) {
    say(`Sorry, ${skill.title} ran into a problem.`);
    addMsg("note", String((res.content[0] as { text?: string })?.text ?? "").slice(0, 300));
    return;
  }
  answerCard(skill, sc.speech, sc.data);
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

async function ask(utterance: string) {
  if (busy || !utterance.trim()) return;
  busy = true;
  ring.className = "ring busy";
  addMsg("user", utterance);
  try {
    let routed = await route(utterance);
    if (!routed) {
      const learned = await learn(utterance);
      if (learned) routed = await route(utterance, learned);
    }
    if (routed) await useSkill(routed);
  } catch (e) {
    say("Sorry, something went wrong.");
    addMsg("note", e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    ring.className = "ring";
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
const mic = $<HTMLButtonElement>("mic");
if (!SR) {
  mic.disabled = true;
  mic.title = "Voice input needs Chrome";
} else {
  let rec: Recognition | undefined;
  mic.onclick = () => {
    if (rec) return rec.stop();
    rec = new SR() as Recognition;
    rec.lang = "en-IN";
    rec.interimResults = true;
    mic.classList.add("on");
    ring.className = "ring listening";
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      input.value = r[0].transcript;
      if (r.isFinal) {
        input.value = "";
        void ask(r[0].transcript);
      }
    };
    rec.onerror = (e) => addMsg("note", `Mic: ${e.error}`);
    rec.onend = () => {
      rec = undefined;
      mic.classList.remove("on");
      if (!busy) ring.className = "ring";
    };
    rec.start();
  };
}

// ---------- start ----------

(async () => {
  const conn = $("conn");
  try {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.origin));
    await client.connect(transport);
    conn.textContent = `connected · ${client.getServerVersion()?.title ?? client.getServerVersion()?.name}`;
    conn.className = "conn ok";
    $("proto").textContent = transport.protocolVersion ?? "";
    const health = await (await fetch("/health")).json();
    $("mode").textContent = `${health.provider}/${health.model}`;
    await refresh();
    addMsg("note", "Ask me something. If I can't do it yet, I'll learn how.");
  } catch (e) {
    conn.textContent = `not connected: ${e instanceof Error ? e.message : e}`;
    conn.className = "conn bad";
  }
})();
