// Seeds a pending capability (as if the smith had built it), then drives the MCP
// server as a client: approve -> expect tools/list_changed -> call the new tool.
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const code = `export default async function run({ city = "Pune" }) {
  const geo = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
  if (!geo.results?.length) return { speech: \`I couldn't find a place called \${city}.\` };
  const p = geo.results[0];
  const w = await (await fetch(\`https://api.open-meteo.com/v1/forecast?latitude=\${p.latitude}&longitude=\${p.longitude}&current=temperature_2m\`)).json();
  return { speech: \`It's \${Math.round(w.current.temperature_2m)} degrees in \${p.name} right now.\`, data: w.current };
}`;
const id = "seed0001";
mkdirSync("data/capabilities", { recursive: true });
writeFileSync(`data/capabilities/${id}.json`, JSON.stringify({
  id, status: "pending", request: "what's the temperature in pune", createdAt: new Date().toISOString(), attempts: 1, uses: 0,
  testReport: { passed: true, results: [{ name: "pune", passed: true, durationMs: 1 }], fetched: [], logs: "" },
  spec: { name: "get_current_temperature", title: "Current Temperature", description: "Gets the current temperature for a city by name.",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
    code, allowedDomains: ["open-meteo.com"], tests: [] },
}));

const { spawn } = await import("node:child_process");
const server = spawn("npx", ["tsx", "src/index.ts"], { env: { ...process.env, PORT: "8799" }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise((r) => server.stdout!.on("data", (d) => String(d).includes("Forge MCP") && r(null)));

const client = new Client({ name: "e2e", version: "1" });
let listChanged = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8799/mcp")));
console.log("protocol:", (client as any)._transport?.protocolVersion ?? "(negotiated)", "server:", client.getServerVersion()?.name);
console.log("tools before:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log((await client.callTool({ name: "approve_capability", arguments: { id, approve: true } })).content);
await new Promise((r) => setTimeout(r, 300));
const tools = (await client.listTools()).tools;
console.log("list_changed notifications:", listChanged);
console.log("tools after:", tools.map((t) => t.name).join(", "));
console.log("schema:", JSON.stringify(tools.find((t) => t.name === "get_current_temperature")?.inputSchema));
const res = await client.callTool({ name: "get_current_temperature", arguments: { city: "Mumbai" } });
console.log("call:", JSON.stringify(res.structuredContent ?? res));
console.log("resource:", (await client.listResources()).resources.map((r) => r.uri));
await client.callTool({ name: "remove_capability", arguments: { name: "get_current_temperature" } });
await new Promise((r) => setTimeout(r, 300));
console.log("after remove:", (await client.listTools()).tools.map((t) => t.name).join(", "), "| list_changed:", listChanged);
process.kill(-server.pid!); process.exit(0);
