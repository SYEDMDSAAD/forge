import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { createServer, markTaskCall, registry } from "./server.js";

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

app.get("/health", (_req, res) => {
  res.json({ ok: true, provider: config.provider, model: config.model, sandbox: config.sandbox, skills: registry.active().length, sessions: transports.size });
});

app.listen(config.port, () => {
  console.log(`Forge MCP server on http://localhost:${config.port}/mcp (${config.provider}/${config.model}, sandbox=${config.sandbox})`);
});
