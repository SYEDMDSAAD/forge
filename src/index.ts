import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { route } from "./assistant.js";
import { config } from "./config.js";
import { warmSandbox } from "./sandbox/sandbox.js";
import { createServer, markTaskCall, registry } from "./server.js";
import { loadVoice, synthesize, VOICE_IDS, voiceState } from "./voice.js";

const app = createMcpExpressApp();
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session" }, id: null });
      return;
    }
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void transports.set(id, created),
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    await createServer().connect(created);
    transport = created;
  }
  for (const msg of [req.body].flat()) {
    if (sessionId && msg?.method === "tools/call" && msg.params?.task && msg.id !== undefined) markTaskCall(sessionId, msg.id);
  }
  await transport.handleRequest(req, res, req.body);
});

// GET opens the server-to-client SSE stream (list_changed, logs); DELETE ends the session.
const bySession = async (req: Request, res: Response) => {
  const transport = transports.get(req.headers["mcp-session-id"] as string);
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);

// Demo client (web/app.ts, built with `npm run build:web`).
// The demo page's assistant brain: picks which learned skill answers a request (src/assistant.ts).
app.post("/assistant/route", async (req: Request, res: Response) => {
  const { utterance, skills, only } = req.body ?? {};
  if (typeof utterance !== "string" || !Array.isArray(skills)) {
    res.status(400).json({ error: "utterance and skills are required" });
    return;
  }
  try {
    res.json((await route(utterance.slice(0, 500), skills.slice(0, 100), typeof only === "string" ? only : undefined)) ?? { fallback: true });
  } catch (e) {
    console.error("route failed:", e);
    res.json({ fallback: true });
  }
});

// The demo page's natural voice (src/voice.ts): one sentence in, a WAV out.
app.get("/voice/status", (_req, res) => {
  res.json(config.voice ? voiceState : { ready: false, failed: true });
});
app.post("/voice", async (req: Request, res: Response) => {
  const { text, voice } = req.body ?? {};
  if (!config.voice || !voiceState.ready) {
    res.status(503).end();
    return;
  }
  if (typeof text !== "string" || !text.trim() || text.length > 600 || !VOICE_IDS.includes(voice)) {
    res.status(400).end();
    return;
  }
  let gone = false;
  res.on("close", () => (gone = !res.writableFinished));
  try {
    const wav = await synthesize(text, voice, () => !gone);
    if (wav) res.type("audio/wav").send(Buffer.from(wav));
    else res.status(204).end();
  } catch (e) {
    console.error("voice failed:", e);
    res.status(500).end();
  }
});

app.use(express.static(fileURLToPath(new URL("../web/public", import.meta.url))));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: config.provider,
    model: config.model,
    smith: config.smith,
    sandbox: config.sandbox,
    attempts: config.maxSubmissions,
    voice: config.voice && voiceState.ready,
    skills: registry.active().length,
    sessions: transports.size,
  });
});

warmSandbox();
if (config.voice) void loadVoice().catch(() => {});
app.listen(config.port, () => {
  console.log(`Forge MCP server on http://localhost:${config.port}/mcp, demo client on http://localhost:${config.port}/ (${config.provider}/${config.model}, sandbox=${config.sandbox})`);
});
