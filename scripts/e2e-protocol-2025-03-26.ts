// Talks to Forge exactly like a client on MCP protocol 2025-03-26 (the version the
// Alexa+ lifecycle docs show): raw JSON-RPC over HTTP, no SDK, no MCP-Protocol-Version
// header, no elicitation or tasks capability. That version has no structuredContent,
// so every answer must be readable from `content` text alone.
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 8797;
const dataDir = "data-e2e-protocol";
rmSync(dataDir, { recursive: true, force: true });
const server = spawn("npx", ["tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), FORGE_PROVIDER: "mock", FORGE_DATA_DIR: dataDir, FORGE_MOCK_PACE_MS: "300" },
  stdio: ["ignore", "pipe", "inherit"],
  detached: true,
});
await new Promise((r) => server.stdout!.on("data", (d) => String(d).includes("Forge MCP") && r(null)));
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

let session: string | undefined;
let nextId = 1;
/** One JSON-RPC message; returns the response to it (from JSON or an SSE stream) and how long it took. */
async function rpc(method: string, params: object = {}, notify = false) {
  const t0 = performance.now();
  const res = await fetch(`http://localhost:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params }),
  });
  session ??= res.headers.get("mcp-session-id") ?? undefined;
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (notify) return { status: res.status, ms, msg: undefined as any };
  const messages = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
    : [JSON.parse(text)];
  return { status: res.status, ms, msg: messages.find((m) => "result" in m || "error" in m), all: messages };
}
const call = async (name: string, args: object) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { ...r, text: String(r.msg?.result?.content?.map((c: any) => c.text).join(" ") ?? JSON.stringify(r.msg?.error)) };
};

try {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "alexa-style-2025-03-26", version: "1" } });
  check(init.msg?.result?.protocolVersion === "2025-03-26", `server agrees to protocol 2025-03-26 (got ${init.msg?.result?.protocolVersion})`);
  check(!!session, "server issues an Mcp-Session-Id");
  check((await rpc("notifications/initialized", {}, true)).status === 202, "initialized notification accepted without an MCP-Protocol-Version header");

  const tools = (await rpc("tools/list")).msg?.result?.tools ?? [];
  const names = tools.map((t: any) => t.name);
  check(["forge_capability", "use_skill", "list_capabilities", "approve_capability"].every((n) => names.includes(n)), `fixed tool surface listed: ${names.join(", ")}`);
  check(tools.every((t: any) => t.inputSchema?.type === "object" && t.description), "every tool has a description and an object inputSchema");

  const learn = await call("forge_capability", { request: "what's the weather in Pune" });
  check(learn.ms < 500 && /learn/i.test(learn.text), `forge_capability answers in ${learn.ms}ms (< 500ms) with text: "${learn.text.slice(0, 90)}"`);
  check(!learn.all?.some((m: any) => m.method === "elicitation/create"), "no elicitation sent to a client that didn't declare it");

  let pending: { text: string; ms: number } = { text: "", ms: 0 };
  for (let i = 0; i < 60 && !/needs your OK/i.test(pending.text); i++) {
    await new Promise((r) => setTimeout(r, 500));
    pending = await call("list_capabilities", {});
  }
  check(/needs your OK/i.test(pending.text) && /open-meteo/.test(pending.text), `list_capabilities, as text, asks for consent and names the site (${pending.ms}ms)`);
  const id = /approve with id ([\w-]+)/.exec(pending.text)?.[1];
  check(!!id, `the approval id is in the text itself (${id})`);

  const approved = await call("approve_capability", { id, approve: true });
  check(approved.ms < 500 && /install/i.test(approved.text), `approve_capability answers in ${approved.ms}ms: "${approved.text.slice(0, 90)}"`);

  const used = await call("use_skill", { name: "get_current_weather", input: { city: "Delhi" } });
  check(/degrees in Delhi/.test(used.text) && /Source: /.test(used.text), `use_skill answer is plain text with its source (${used.ms}ms, includes the live weather API): "${used.text}"`);

  const unknown = await rpc("tools/call", { name: "use_skill", arguments: { name: "no_such_skill", input: {} } });
  check(unknown.msg?.result?.isError === true, "unknown skill comes back as a tool error, not a crash");
} catch (e) {
  console.log("FAIL threw:", e);
  failed = true;
} finally {
  process.kill(-server.pid!);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
