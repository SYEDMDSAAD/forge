// Drives forge_capability two ways against a mock smith (FORGE_PROVIDER=mock):
//  1. as an MCP task (callToolStream): task id, status updates, consent via tasks/result
//  2. like Alexa+: plain tools/call, no elicitation, fixed tool list. Must answer
//     fast ("learning"), then list_capabilities -> approve_capability -> use_skill.
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, LoggingMessageNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const dataDir = "data-e2e-tasks";
rmSync(dataDir, { recursive: true, force: true });
const server = spawn("npx", ["tsx", "src/index.ts"], {
  env: { ...process.env, PORT: "8798", FORGE_PROVIDER: "mock", FORGE_DATA_DIR: dataDir, FORGE_MOCK_PACE_MS: "300" },
  stdio: ["ignore", "pipe", "inherit"],
  detached: true,
});
await new Promise((r) => server.stdout!.on("data", (d) => String(d).includes("Forge MCP") && r(null)));
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function connect(elicitation = true) {
  const client = new Client({ name: "e2e-tasks", version: "1" }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  const prompts: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return { action: "accept", content: { install: true } };
    });
  }
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);
  const notices: { stage?: string; message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    if (n.params.level === "notice") notices.push(n.params.data as { stage?: string; message?: string });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8798/mcp")));
  return { client, prompts, notices, listChanged: () => listChanged };
}

try {
  // 1. Task-augmented call
  {
    const { client, prompts, listChanged } = await connect();
    const forgeTool = (await client.listTools()).tools.find((t) => t.name === "forge_capability");
    check(forgeTool?.execution?.taskSupport === "optional", "forge_capability advertises taskSupport=optional");

    const seen: string[] = [];
    let result: any;
    const stream = client.experimental.tasks.callToolStream({ name: "forge_capability", arguments: { request: "what's the weather in Pune" } }, CallToolResultSchema);
    for await (const msg of stream) {
      if (msg.type === "taskCreated") seen.push(`created ${msg.task.taskId.slice(0, 8)}`);
      if (msg.type === "taskStatus") seen.push(`${msg.task.status}: ${msg.task.statusMessage ?? ""}`);
      if (msg.type === "result") result = msg.result;
      if (msg.type === "error") throw msg.error;
    }
    console.log("  task updates:", seen.join(" | "));
    check(seen[0]?.startsWith("created"), "client received a task id immediately");
    check(prompts.length === 1, "consent prompt delivered inside the task");
    check(result?.structuredContent?.status === "installed", `task result: ${result?.structuredContent?.status}`);
    await new Promise((r) => setTimeout(r, 300));
    check(listChanged() >= 1, "tools/list_changed after install");
    const call = await client.callTool({ name: "get_current_weather", arguments: { city: "Mumbai" } });
    check(/degrees in Mumbai/.test(String((call.structuredContent as any)?.speech)), `forged tool answers: ${(call.structuredContent as any)?.speech ?? JSON.stringify(call.content)}`);
    await client.callTool({ name: "remove_capability", arguments: { name: "get_current_weather" } });
    await client.close();
  }

  // 2. Alexa-like client
  {
    const { client, prompts, notices } = await connect(false);
    let t0 = performance.now();
    const res = await client.callTool({ name: "forge_capability", arguments: { request: "what's the weather in Pune" } });
    const ms = Math.round(performance.now() - t0);
    check((res.structuredContent as any)?.status === "learning" && ms < 1000, `plain call answers "learning" fast (${ms}ms)`);

    let list: any;
    for (let i = 0; i < 60; i++) {
      list = (await client.callTool({ name: "list_capabilities", arguments: {} })).structuredContent;
      if (list.pending.length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("  list_capabilities says:", (await client.callTool({ name: "list_capabilities", arguments: {} })).content[0].text);
    check(list.pending.length === 1, "skill waits as pending for the user's OK");
    check(prompts.length === 0, "no elicitation sent to a client without it");
    await new Promise((r) => setTimeout(r, 300));
    const ready = notices.find((n) => n.stage === "skill_ready");
    check(!!ready && /finished learning/.test(ready.message ?? ""), `background build announced with a notice: "${ready?.message?.slice(0, 70)}"`);

    const approved = await client.callTool({ name: "approve_capability", arguments: { id: list.pending[0].id, approve: true } });
    check((approved.structuredContent as any)?.status === "installed", "approve_capability installs it");

    const bad = await client.callTool({ name: "use_skill", arguments: { name: "get_current_weather", input: {} } });
    check(bad.isError === true && /Wrong input/.test(String((bad.content as any)[0].text)), "use_skill rejects bad input with the schema");

    t0 = performance.now();
    const used = await client.callTool({ name: "use_skill", arguments: { name: "get_current_weather", input: { city: "Delhi" } } });
    const speech = String((used.structuredContent as any)?.speech);
    check(/degrees in Delhi/.test(speech), `use_skill answers: ${used.isError ? JSON.stringify(used.content) : speech} (${Math.round(performance.now() - t0)}ms)`);
    await client.callTool({ name: "remove_capability", arguments: { name: "get_current_weather" } });
    await client.close();
  }
} catch (e) {
  console.log("FAIL threw:", e);
  failed = true;
} finally {
  process.kill(-server.pid!);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
