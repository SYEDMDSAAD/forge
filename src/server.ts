import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import {
  ElicitResultSchema,
  type CallToolResult,
  type ElicitRequestFormParams,
  type ElicitResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import * as z from "zod/v4";
import { ForgeFailed, forgeTool } from "./forge/smith.js";
import { Registry } from "./forge/registry.js";
import { sourcesOf } from "./forge/export.js";
import { CATALOG } from "./forge/catalog.js";
import type { Capability, ForgeEvent } from "./forge/types.js";
import { runInSandbox } from "./sandbox/sandbox.js";
import { config } from "./config.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const registry = new Registry();

// Forging takes 30-120s, so forge_capability runs as an MCP task (spec 2025-11-25):
// task-aware clients get a task id at once and poll its status; others get the
// SDK's automatic polling and see an ordinary blocking call.
const taskStore = new InMemoryTaskStore();
const taskMessageQueue = new InMemoryTaskMessageQueue();
const taskCalls = new Set<string>();

/**
 * index.ts records which tools/call requests the client sent task-augmented
 * (`params.task`). Inside a task the consent prompt has to be queued for
 * tasks/result; in a plain call it goes straight down the open response stream.
 */
export function markTaskCall(sessionId: string, requestId: string | number) {
  taskCalls.add(`${sessionId}:${requestId}`);
}

const INSTRUCTIONS = `Forge lets this assistant learn new abilities while talking to the user.
- When the user asks for something none of your tools can do, and it could be answered from public information on the internet, say you'll learn it (e.g. "Give me a minute, I'll learn how") and call forge_capability with their request in their own words.
- If forge_capability answers that it is still learning, tell the user and offer to check back; list_capabilities shows progress.
- A skill that is built but waiting for the user's OK shows as pending in list_capabilities: say what it does and which sites it uses, ask the user, then call approve_capability.
- When a Forge result says "Also tell the user", pass that news on: it is the outcome of something the user asked to be learned earlier.
- To use a learned skill, call it directly if it is in your tool list, otherwise call use_skill with its name and input (list_capabilities shows each skill's input).
Learned skills return a short \`speech\` string written to be spoken aloud.`;

/** One forge_capability call, tracked so clients that can't wait can check on it later. */
interface ForgeJob {
  id: string;
  request: string;
  status: "learning" | "pending_approval" | "installed" | "declined" | "failed";
  message: string;
  startedAt: string;
  capabilityId?: string;
  /** The caller stopped waiting ("I'm learning that now"), so the outcome must be announced. */
  background?: boolean;
}
const jobs = new Map<string, ForgeJob>();

function trackJob(request: string): ForgeJob {
  const job: ForgeJob = { id: randomUUID().slice(0, 8), request, status: "learning", message: "Starting", startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  const finished = [...jobs.values()].filter((j) => j.status !== "learning");
  for (const old of finished.slice(0, Math.max(0, finished.length - 20))) jobs.delete(old.id);
  return job;
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

const consentText = (cap: Capability) =>
  `It ${lowerFirst(cap.spec.description)} It will only access ${cap.spec.allowedDomains.join(", ")}. (approve with id ${cap.id})`;
const readyText = (cap: Capability) => `"${cap.spec.title}" is ready and needs your OK. ${consentText(cap)}`;
const learnedText = (cap: Capability) => {
  const answer = firstAnswer(cap);
  return answer
    ? `I've learned how to answer "${cap.request}": ${answer.speech} Should I keep this skill, "${cap.spec.title}", so next time it's instant? ${consentText(cap)}`
    : `I've finished learning "${cap.spec.title}" and it needs your OK. ${consentText(cap)}`;
};

/**
 * Outcomes of background builds the user hasn't heard yet, for one session. A
 * voice assistant only speaks tool results, so this news rides along with the
 * next answer from any Forge tool; a session hears each item once.
 */
function newsFor(told: Set<string>): string[] {
  const news: string[] = [];
  for (const job of jobs.values()) {
    if (!job.background || told.has(job.id)) continue;
    const cap = job.capabilityId ? registry.get(job.capabilityId) : undefined;
    if (job.status === "pending_approval" && cap?.status === "pending") news.push(learnedText(cap));
    else if (job.status === "failed") news.push(`I couldn't learn "${job.request}": ${job.message}`);
    else continue;
    told.add(job.id);
  }
  return news;
}

/** Live sessions, told the moment a background build finishes (MCP log notice). */
const announcers = new Set<(job: ForgeJob) => void>();

const text = (t: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});


function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "a moment ago";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  return `about ${h} hour${h === 1 ? "" : "s"} ago`;
}

/** Run a learned skill in a fresh sandbox runner; every answer names its source. */
/** The answer with its source named, unless it already names it. */
function cite(cap: Capability, speech: string): string {
  const sources = sourcesOf(cap);
  return sources.some((s) => speech.toLowerCase().includes(s.toLowerCase())) ? speech : `${speech} Source: ${sources.join(" and ")}.`;
}

/**
 * The answer a new skill gave to the user's own request in its live test, before
 * it was installed. The user hears it right away; installing only makes the next
 * question like it instant.
 */
export function firstAnswer(cap: Capability): { speech: string; data: unknown; input: Record<string, unknown> } | undefined {
  const r = cap.testReport.results[0];
  const result = r?.passed ? (r.result as { speech?: string; data?: unknown } | undefined) : undefined;
  if (!result?.speech) return undefined;
  return { speech: cite(cap, result.speech), data: result.data ?? null, input: cap.spec.tests[0]?.input ?? {} };
}

async function runSkill(cap: Capability, input: Record<string, unknown>): Promise<CallToolResult> {
  const out = await runInSandbox({ mode: "run", code: cap.spec.code, input, allowedDomains: cap.spec.allowedDomains });
  registry.recordUse(cap.id);
  const sources = sourcesOf(cap);
  if (out.upstream) {
    // The source is down or refusing, not the skill broken: say so in words a listener understands.
    const why = out.upstream.reason ? ` (${lowerFirst(out.upstream.reason.replace(/\.$/, ""))})` : out.upstream.status ? ` (error ${out.upstream.status})` : "";
    const speech = `${sources.join(" and ")} isn't answering right now${why}. Try again in a minute.`;
    return { ...text(speech, { speech, unavailable: true, sources }), isError: true };
  }
  if (!out.ok) {
    // The skill crashed on this input (its tests passed on others): say so plainly, keep the detail for the log.
    const values = Object.values(input).filter((v) => typeof v === "string" || typeof v === "number");
    const speech = `Sorry, I couldn't answer that with the ${cap.spec.title} skill${values.length ? ` for ${values.join(", ")}` : ""}. Try asking a different way.`;
    console.error(`skill ${cap.spec.name} failed on ${JSON.stringify(input)}: ${out.error}`);
    return { ...text(speech, { speech, error: String(out.error).slice(0, 300) }), isError: true };
  }
  const result = out.result as { speech: string; data?: unknown };
  let cited = cite(cap, result.speech);
  if (out.staleMs !== undefined) cited += ` ${sources.join(" and ")} isn't responding, so that's from ${ago(out.staleMs)}.`;
  return {
    content: [
      { type: "text", text: cited },
      ...(result.data !== undefined ? [{ type: "text" as const, text: JSON.stringify(result.data) }] : []),
    ],
    structuredContent: { speech: cited, data: result.data ?? null, sources, ...(out.staleMs !== undefined ? { staleSeconds: Math.round(out.staleMs / 1000) } : {}) },
  };
}

function inputSchemaFor(cap: Capability) {
  try {
    return z.fromJSONSchema(cap.spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
  } catch {
    return z.looseObject({});
  }
}

function summarize(cap: Capability) {
  return {
    id: cap.id,
    name: cap.spec.name,
    title: cap.spec.title,
    description: cap.spec.description,
    status: cap.status,
    allowedDomains: cap.spec.allowedDomains,
    sources: sourcesOf(cap),
    crossChecked: cap.spec.tests.some((t) => t.reference),
    tests: cap.testReport.results.map((r) => ({ name: r.name, passed: r.passed, ms: r.durationMs })),
    attempts: cap.attempts,
    uses: cap.uses,
    request: cap.request,
    createdAt: cap.createdAt,
  };
}

/** One McpServer per client session; all of them share the registry. */
export function createServer(): McpServer {
  const mcp = new McpServer(
    { name: "forge", title: "Forge — the assistant that learns", version: "0.1.0" },
    {
      capabilities: { logging: {}, tools: { listChanged: true }, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
      instructions: INSTRUCTIONS,
      taskStore,
      taskMessageQueue,
    },
  );
  const forged = new Map<string, RegisteredTool>();
  const told = new Set<string>();
  const withNews = (result: CallToolResult): CallToolResult => {
    const news = newsFor(told);
    if (!news.length) return result;
    return {
      ...result,
      content: [...result.content, { type: "text", text: `Also tell the user: ${news.join(" ")}` }],
      ...(result.structuredContent ? { structuredContent: { ...result.structuredContent, news } } : {}),
    };
  };

  const installForged = (cap: Capability) => {
    forged.get(cap.spec.name)?.remove();
    const handle = mcp.registerTool(
      cap.spec.name,
      {
        title: cap.spec.title,
        description: `${cap.spec.description}\n\n(Forged by Forge from the request: "${cap.request}")`,
        inputSchema: inputSchemaFor(cap),
        annotations: { readOnlyHint: true, openWorldHint: true },
        _meta: { "forge/capabilityId": cap.id, "forge/allowedDomains": cap.spec.allowedDomains },
      },
      async (input: Record<string, unknown>) => withNews(await runSkill(cap, input)),
    );
    forged.set(cap.spec.name, handle);
  };

  for (const cap of registry.active()) installForged(cap);
  const onActivated = (cap: Capability) => installForged(cap); // registerTool emits tools/list_changed
  const onRemoved = (name: string) => {
    forged.get(name)?.remove();
    forged.delete(name);
  };
  registry.on("activated", onActivated);
  registry.on("removed", onRemoved);
  const announce = (job: ForgeJob) => {
    const cap = job.capabilityId ? registry.get(job.capabilityId) : undefined;
    const ready = job.status === "pending_approval" && cap;
    const data = ready
      ? { stage: "skill_ready", message: learnedText(cap), jobId: job.id, capability: summarize(cap), answer: firstAnswer(cap) }
      : { stage: "skill_failed", message: `I couldn't learn "${job.request}": ${job.message}`, jobId: job.id };
    void mcp.server.sendLoggingMessage({ level: "notice", logger: "forge", data }).catch(() => {});
  };
  announcers.add(announce);
  mcp.server.onclose = () => {
    registry.off("activated", onActivated);
    registry.off("removed", onRemoved);
    announcers.delete(announce);
  };

  const report = (extra: Extra) => {
    let step = 0;
    const token = extra._meta?.progressToken;
    return async (e: ForgeEvent) => {
      step++;
      await mcp.sendLoggingMessage({ level: "info", logger: "forge", data: { stage: e.stage, message: e.message } }, extra.sessionId).catch(() => {});
      if (token !== undefined) {
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: e.message } }).catch(() => {});
      }
    };
  };

  /** Ask the human before a new capability goes live. Uses MCP elicitation when the client supports it. */
  /** Resolves null when the user can't be asked right now; the skill then waits as pending. */
  type Elicit = (params: ElicitRequestFormParams) => Promise<ElicitResult | null>;
  const askConsent = async (cap: Capability, elicit: Elicit): Promise<"accept" | "decline" | "unsupported"> => {
    if (!mcp.server.getClientCapabilities()?.elicitation) return "unsupported";
    const passed = cap.testReport.results.filter((r) => r.passed).length;
    const answer = firstAnswer(cap);
    const res = await elicit({
      mode: "form",
      // Structured details so a client can render the answer and a consent card instead of plain text.
      _meta: { "forge/capability": summarize(cap), ...(answer ? { "forge/answer": answer } : {}) },
      message:
        (answer ? `${answer.speech}\n\n` : "") +
        `I learned a new skill to answer that: "${cap.spec.title}". ${cap.spec.description}\n` +
        `It passed ${passed}/${cap.testReport.results.length} live tests and will only access: ${cap.spec.allowedDomains.join(", ")}.\n` +
        (answer ? `Keep it, so next time a question like this is answered instantly?` : `Install it?`),
      requestedSchema: {
        type: "object",
        properties: { install: { type: "boolean", title: answer ? "Keep this skill for next time" : "Install this skill", default: true } },
        required: ["install"],
      },
    });
    if (!res) return "unsupported";
    return res.action === "accept" && res.content?.install === true ? "accept" : "decline";
  };

  /** Build, test, ask consent, install. Shared by the task and the plain-call paths. */
  const forgeAndInstall = async (job: ForgeJob, emit: (e: ForgeEvent) => void, elicit: Elicit): Promise<CallToolResult> => {
    const request = job.request;
    let built;
    try {
      built = await forgeTool(request, (e) => {
        job.message = e.message;
        emit(e);
      });
    } catch (e) {
      job.status = "failed";
      job.message = e instanceof Error ? e.message : String(e);
      if (e instanceof ForgeFailed) return text(e.message, { status: "failed", reason: e.message });
      throw e;
    }

    const cap: Capability = {
      id: randomUUID().slice(0, 8),
      status: "pending",
      spec: built.spec,
      request,
      createdAt: new Date().toISOString(),
      attempts: built.attempts,
      testReport: built.report,
      uses: 0,
    };
    registry.addPending(cap);
    job.capabilityId = cap.id;
    job.status = "pending_approval";
    job.message = `Built ${cap.spec.title}; waiting for the user's OK`;

    const consent = await askConsent(cap, elicit);
    if (consent === "decline") {
      registry.remove(cap.id);
      job.status = "declined";
      job.message = "The user declined it";
      const answer = firstAnswer(cap);
      return text(
        answer
          ? `The user chose not to keep the new skill, so it was discarded. The answer it found: ${answer.speech}`
          : "The user chose not to install the new skill. It has been discarded.",
        { status: "declined", ...(answer ? { answer } : {}) },
      );
    }
    const answer = firstAnswer(cap);
    if (consent === "unsupported") {
      const sites = cap.spec.allowedDomains.join(", ");
      return text(
        answer
          ? `Tell the user the answer now: ${answer.speech}\n` +
              `Then ask if they want to keep the skill "${cap.spec.title}" so next time it's instant (it will only access ${sites}); if yes, call approve_capability with id "${cap.id}".`
          : `Built "${cap.spec.title}" and it passed its tests, but it needs the user's OK before installing. ` +
              `Tell the user what it does and that it will access ${sites}, ask if they want it, then call approve_capability with id "${cap.id}".`,
        { status: "pending_approval", capability: summarize(cap), ...(answer ? { answer } : {}) },
      );
    }
    registry.activate(cap.id);
    job.status = "installed";
    job.message = `Installed ${cap.spec.title}`;
    return text(
      answer
        ? `Installed the new skill "${cap.spec.name}". The answer to the user's request: ${answer.speech}`
        : `Installed the new skill "${cap.spec.name}". Call it now (directly or via use_skill) to answer the user's request.`,
      { status: "installed", capability: summarize(cap), ...(answer ? { answer } : {}) },
    );
  };

  mcp.experimental.tasks.registerToolTask(
    "forge_capability",
    {
      title: "Learn a new skill",
      description:
        "Builds, tests and installs a brand-new skill for a request that no existing tool can handle (anything answerable from public internet data: live status, schedules, prices, notices, feeds, lookups). Learning takes 30-120 seconds; if the client can't wait, this returns at once with status 'learning' and the skill shows up in list_capabilities when it's ready. Pass the user's request in their own words.",
      inputSchema: {
        request: z.string().min(5).describe("What the user wants, in their words, including any specifics (places, names, numbers)"),
      },
      annotations: { openWorldHint: true },
      execution: { taskSupport: "optional" },
    },
    {
      async createTask({ request }, extra) {
        const asTask = taskCalls.delete(`${extra.sessionId}:${extra.requestId}`);
        // pollInterval is advice to task clients; for plain calls it paces the SDK's own
        // internal polling, which must not add latency to the "learning" answer.
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl ?? 15 * 60_000, pollInterval: asTask ? 1000 : 50 });
        const job = trackJob(request);
        const progress = report(extra);
        // A plain call that outlives FORGE_WAIT_MS is answered "still learning";
        // the work carries on detached from the request.
        let settled = false;
        let detached = false;
        const settle = async (status: "completed" | "failed", result: CallToolResult) => {
          if (settled) return;
          settled = true;
          await extra.taskStore.storeTaskResult(task.taskId, status, result).catch(() => {});
        };

        const emit = (e: ForgeEvent) => {
          if (detached) return;
          void progress(e);
          void extra.taskStore.updateTaskStatus(task.taskId, "working", e.message).catch(() => {});
        };
        const elicit: Elicit = async (params) => {
          if (detached) return null;
          if (!asTask) return mcp.server.elicitInput(params, { relatedRequestId: extra.requestId });
          // Queued for delivery on the client's tasks/result call while the task shows input_required.
          await extra.taskStore.updateTaskStatus(task.taskId, "input_required", "Waiting for the user's OK");
          const res = await mcp.server.request({ method: "elicitation/create", params }, ElicitResultSchema, {
            relatedTask: { taskId: task.taskId },
          });
          await extra.taskStore.updateTaskStatus(task.taskId, "working", "Installing").catch(() => {});
          return res;
        };

        if (!asTask && Number.isFinite(config.forgeWaitMs)) {
          setTimeout(() => {
            if (settled) return;
            detached = true;
            job.background = true;
            void settle(
              "completed",
              withNews(text(
                `I'm learning that now. It usually takes a minute or two. Tell the user, and check list_capabilities in a bit: ` +
                  `when the skill is ready it will need the user's OK before it's installed.`,
                { status: "learning", jobId: job.id },
              )),
            );
          }, config.forgeWaitMs);
        }

        void (async () => {
          try {
            await settle("completed", await forgeAndInstall(job, emit, elicit));
          } catch (e) {
            job.status = "failed";
            job.message = e instanceof Error ? e.message : String(e);
            await settle("failed", { ...text(`Forge error: ${job.message}`), isError: true });
          }
          if (job.background && (job.status === "pending_approval" || job.status === "failed")) for (const tell of announcers) tell(job);
        })();
        return { task };
      },
      getTask: (_args, { taskId, taskStore }) => taskStore.getTask(taskId),
      getTaskResult: (_args, { taskId, taskStore }) => taskStore.getTaskResult(taskId) as Promise<CallToolResult>,
    },
  );

  mcp.registerTool(
    "approve_capability",
    {
      title: "Approve or reject a learned skill",
      description: "Installs (approve=true) or discards (approve=false) a skill that forge_capability built, after the user has said yes or no.",
      inputSchema: { id: z.string(), approve: z.boolean() },
    },
    async ({ id, approve }) => {
      const cap = registry.get(id);
      if (!cap || cap.status !== "pending") return { ...text(`No pending skill with id ${id}.`), isError: true };
      if (!approve) {
        registry.remove(id);
        return text("Discarded.", { status: "declined" });
      }
      registry.activate(id);
      for (const job of jobs.values()) if (job.capabilityId === id) job.status = "installed";
      return withNews(
        text(`Installed "${cap.spec.name}". Call it now (directly or via use_skill) to answer the user's request${cap.request ? `: "${cap.request}"` : ""}.`, {
          status: "installed",
          capability: summarize(cap),
        }),
      );
    },
  );

  mcp.registerTool(
    "use_skill",
    {
      title: "Use a learned skill",
      description:
        "Runs a skill this assistant has learned, by name. Use it for any skill listed by list_capabilities that isn't in your tool list directly. Returns a short sentence to say to the user.",
      inputSchema: {
        name: z.string().describe("The skill's name from list_capabilities, e.g. get_current_weather"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Arguments matching the skill's input schema"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, input }) => {
      const cap = registry.byName(name);
      if (!cap) {
        const names = registry.active().map((c) => c.spec.name);
        return withNews({ ...text(`No learned skill called "${name}". Learned skills: ${names.join(", ") || "none yet"}.`), isError: true });
      }
      const parsed = inputSchemaFor(cap).safeParse(input);
      if (!parsed.success) {
        return {
          ...text(`Wrong input for ${name}: ${z.prettifyError(parsed.error)}\nExpected input schema: ${JSON.stringify(cap.spec.inputSchema)}`),
          isError: true,
        };
      }
      return withNews(await runSkill(cap, parsed.data as Record<string, unknown>));
    },
  );

  mcp.registerTool(
    "list_capabilities",
    {
      title: "List learned skills",
      description:
        "Lists the skills this assistant has taught itself (with each one's input, for use_skill), skills waiting for the user's OK, and skills still being learned.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const skills = registry.active().map((c) => ({ ...summarize(c), inputSchema: c.spec.inputSchema }));
      const pending = registry.pending().map(summarize);
      const learning = [...jobs.values()].filter((j) => j.status === "learning");
      const failed = [...jobs.values()].filter((j) => j.status === "failed");
      newsFor(told); // everything below covers it

      const parts: string[] = [];
      parts.push(
        skills.length
          ? `I've learned ${skills.length} skill${skills.length > 1 ? "s" : ""}: ${skills.map((c) => c.title).join(", ")}.`
          : "I haven't learned any new skills yet.",
      );
      for (const p of registry.pending()) parts.push(readyText(p));
      for (const j of learning) parts.push(`Still learning "${j.request}": ${j.message}.`);
      for (const j of failed.slice(-2)) parts.push(`Couldn't learn "${j.request}": ${j.message}`);
      return text(parts.join(" "), { skills, pending, learning, failed });
    },
  );

  mcp.registerTool(
    "remove_capability",
    {
      title: "Forget a learned skill",
      description: "Uninstalls a learned skill by its tool name.",
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      const cap = registry.byName(name);
      if (!cap) return { ...text(`No learned skill called ${name}.`), isError: true };
      registry.remove(cap.id);
      return withNews(text(`Forgot "${cap.spec.title}".`, { status: "removed" }));
    },
  );

  // Where live data can come from: the verified, keyless sources new skills are built on.
  mcp.registerResource(
    "sources",
    "forge://sources",
    { title: "Verified live data sources", description: "The public, keyless APIs Forge builds new skills on", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(CATALOG.map((s) => ({ id: s.id, name: s.name, useFor: s.useFor, domains: s.domains, crossChecked: Boolean(s.reference) }))),
        },
      ],
    }),
  );

  // Full source and test evidence of every learned skill, for transparency.
  mcp.registerResource(
    "capability",
    new ResourceTemplate("forge://capabilities/{name}", {
      list: async () => ({
        resources: registry.active().map((c) => ({
          uri: `forge://capabilities/${c.spec.name}`,
          name: c.spec.name,
          title: c.spec.title,
          description: c.spec.description,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Learned skill source", description: "Source code, tests and test results of a skill Forge built", mimeType: "application/json" },
    async (uri, { name }) => {
      const cap = registry.byName(String(name));
      if (!cap) throw new Error(`No learned skill called ${name}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...summarize(cap), spec: cap.spec, testReport: cap.testReport }, null, 2) }] };
    },
  );

  return mcp;
}
