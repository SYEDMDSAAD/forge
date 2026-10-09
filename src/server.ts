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
import type { Capability, ForgeEvent } from "./forge/types.js";
import { runInSandbox } from "./sandbox/sandbox.js";

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
When the user asks for something none of your tools can do, and it could be done by reading public information on the internet, tell the user you'll learn it (e.g. "Give me a minute, I'll learn how") and call forge_capability with their request in their own words. When it returns, the new tool is installed: call it right away to answer the user.
Forged tools return a short \`speech\` string written to be spoken aloud.`;

const text = (t: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

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
    tests: cap.testReport.results.map((r) => ({ name: r.name, passed: r.passed, ms: r.durationMs })),
    attempts: cap.attempts,
    uses: cap.uses,
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
      async (input: Record<string, unknown>) => {
        const out = await runInSandbox({ mode: "run", code: cap.spec.code, input, allowedDomains: cap.spec.allowedDomains });
        registry.recordUse(cap.id);
        if (!out.ok) return { ...text(`The ${cap.spec.title} tool failed: ${out.error}`), isError: true };
        const result = out.result as { speech: string; data?: unknown };
        return {
          content: [
            { type: "text", text: result.speech },
            ...(result.data !== undefined ? [{ type: "text" as const, text: JSON.stringify(result.data) }] : []),
          ],
          structuredContent: { speech: result.speech, data: result.data ?? null },
        };
      },
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
  mcp.server.onclose = () => {
    registry.off("activated", onActivated);
    registry.off("removed", onRemoved);
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
  type Elicit = (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  const askConsent = async (cap: Capability, elicit: Elicit): Promise<"accept" | "decline" | "unsupported"> => {
    if (!mcp.server.getClientCapabilities()?.elicitation) return "unsupported";
    const passed = cap.testReport.results.filter((r) => r.passed).length;
    const res = await elicit({
      mode: "form",
      message:
        `I learned a new skill: "${cap.spec.title}". ${cap.spec.description}\n` +
        `It passed ${passed}/${cap.testReport.results.length} live tests and will only access: ${cap.spec.allowedDomains.join(", ")}.\n` +
        `Install it?`,
      requestedSchema: {
        type: "object",
        properties: { install: { type: "boolean", title: "Install this skill", default: true } },
        required: ["install"],
      },
    });
    return res.action === "accept" && res.content?.install === true ? "accept" : "decline";
  };

  /** Build, test, ask consent, install. Shared by the task and the plain-call paths. */
  const forgeAndInstall = async (request: string, emit: (e: ForgeEvent) => void, elicit: Elicit): Promise<CallToolResult> => {
    let built;
    try {
      built = await forgeTool(request, emit);
    } catch (e) {
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

    const consent = await askConsent(cap, elicit);
    if (consent === "decline") {
      registry.remove(cap.id);
      return text("The user chose not to install the new skill. It has been discarded.", { status: "declined" });
    }
    if (consent === "unsupported") {
      return text(
        `Built "${cap.spec.title}" and it passed its tests, but it needs the user's OK before installing. ` +
          `Tell the user what it does and that it will access ${cap.spec.allowedDomains.join(", ")}, ask if they want it, then call approve_capability with id "${cap.id}".`,
        { status: "pending_approval", capability: summarize(cap) },
      );
    }
    registry.activate(cap.id);
    return text(`Installed the new tool "${cap.spec.name}". Call it now to answer the user's request.`, {
      status: "installed",
      capability: summarize(cap),
    });
  };

  mcp.experimental.tasks.registerToolTask(
    "forge_capability",
    {
      title: "Learn a new skill",
      description:
        "Builds, tests and installs a brand-new tool for a request that no existing tool can handle (anything answerable from public internet data: live status, schedules, prices, notices, feeds, lookups). Takes 30-120 seconds. Pass the user's request in their own words.",
      inputSchema: {
        request: z.string().min(5).describe("What the user wants, in their words, including any specifics (places, names, numbers)"),
      },
      annotations: { openWorldHint: true },
      execution: { taskSupport: "optional" },
    },
    {
      async createTask({ request }, extra) {
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl ?? 15 * 60_000, pollInterval: 1000 });
        const key = `${extra.sessionId}:${extra.requestId}`;
        const asTask = taskCalls.delete(key);
        const progress = report(extra);

        const emit = (e: ForgeEvent) => {
          void progress(e);
          void extra.taskStore.updateTaskStatus(task.taskId, "working", e.message).catch(() => {});
        };
        const elicit: Elicit = async (params) => {
          if (!asTask) return mcp.server.elicitInput(params, { relatedRequestId: extra.requestId });
          // Queued for delivery on the client's tasks/result call while the task shows input_required.
          await extra.taskStore.updateTaskStatus(task.taskId, "input_required", "Waiting for the user's OK");
          const res = await mcp.server.request({ method: "elicitation/create", params }, ElicitResultSchema, {
            relatedTask: { taskId: task.taskId },
          });
          await extra.taskStore.updateTaskStatus(task.taskId, "working", "Installing").catch(() => {});
          return res;
        };

        void (async () => {
          try {
            const result = await forgeAndInstall(request, emit, elicit);
            await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
          } catch (e) {
            await extra.taskStore
              .storeTaskResult(task.taskId, "failed", { ...text(`Forge error: ${e instanceof Error ? e.message : e}`), isError: true })
              .catch(() => {});
          }
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
      return text(`Installed "${cap.spec.name}". Call it now to answer the user's request.`, { status: "installed", capability: summarize(cap) });
    },
  );

  mcp.registerTool(
    "list_capabilities",
    {
      title: "List learned skills",
      description: "Lists the skills this assistant has taught itself, with what they access and how often they've been used.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const caps = registry.active().map(summarize);
      const speech = caps.length
        ? `I've learned ${caps.length} skill${caps.length > 1 ? "s" : ""}: ${caps.map((c) => c.title).join(", ")}.`
        : "I haven't learned any new skills yet.";
      return text(speech, { capabilities: caps });
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
      return text(`Forgot "${cap.spec.title}".`, { status: "removed" });
    },
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
