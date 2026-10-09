// Drives forge_capability two ways against a mock smith (FORGE_PROVIDER=mock):
//  1. as an MCP task (callToolStream): task id, status updates, consent via tasks/result
//  2. as a plain tools/call: SDK auto-polling, consent over the open response stream
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

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

async function connect() {
  const client = new Client({ name: "e2e-tasks", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  const prompts: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    return { action: "accept", content: { install: true } };
  });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8798/mcp")));
  return { client, prompts, listChanged: () => listChanged };
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
    check(/degrees in Mumbai/.test(String((call.structuredContent as any)?.speech)), `forged tool answers: ${(call.structuredContent as any)?.speech}`);
    await client.callTool({ name: "remove_capability", arguments: { name: "get_current_weather" } });
    await client.close();
  }

  // 2. Plain call (no task param): automatic polling
  {
    const { client, prompts } = await connect();
    const res = await client.callTool({ name: "forge_capability", arguments: { request: "what's the weather in Pune" } }, undefined, { timeout: 120_000 });
    check(prompts.length === 1, "consent prompt delivered on plain call");
    check((res.structuredContent as any)?.status === "installed", `plain call result: ${(res.structuredContent as any)?.status}`);
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
