import path from "node:path";

export type Provider = "anthropic" | "bedrock" | "ollama" | "mock";
export type SandboxKind = "docker" | "process";

try {
  process.loadEnvFile(); // optional .env in the working directory
} catch {}

const provider = (process.env.FORGE_PROVIDER ?? "anthropic") as Provider;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  provider,
  // Bedrock model IDs take an `anthropic.` prefix.
  model:
    provider === "mock"
      ? "replay"
      : (process.env.FORGE_MODEL ?? { anthropic: "claude-opus-5-5", bedrock: "anthropic.claude-opus-5-5", ollama: "qwen2.5:3b" }[provider]),
  // Ollama serves an Anthropic-compatible Messages API; used as a free local stand-in during development.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  // Ollama defaults to a 4k context, too small for Forge's prompts.
  ollamaContext: Number(process.env.OLLAMA_CONTEXT ?? 8192),
  // "agent": open-ended tool-use loop (Claude). "guided": short JSON-schema steps
  // over the verified source catalog, for small local models.
  smith: (process.env.FORGE_SMITH ?? (provider === "ollama" ? "guided" : "agent")) as "agent" | "guided",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  sandbox: (process.env.FORGE_SANDBOX ?? "docker") as SandboxKind,
  // Sandbox runners kept pre-started (each still runs one job only).
  warmPool: Number(process.env.FORGE_WARM_POOL ?? 2),
  sandboxImage: process.env.FORGE_SANDBOX_IMAGE ?? "node:20-alpine",
  dataDir: path.resolve(process.env.FORGE_DATA_DIR ?? "data"),
  // How many times the smith may resubmit a tool after failing tests.
  maxSubmissions: Number(process.env.FORGE_MAX_SUBMISSIONS ?? 4),
  // Hard cap on agent turns (probes + submissions) per forge.
  maxTurns: Number(process.env.FORGE_MAX_TURNS ?? 16),
  // How long a plain (non-task) forge_capability call waits before answering
  // "still learning" and continuing in the background. Alexa+ expects answers
  // in under 500ms; set FORGE_WAIT_MS=Infinity for clients that can wait.
  forgeWaitMs: Number(process.env.FORGE_WAIT_MS ?? 200),
  // Print raw model turns and tool results to stderr.
  debug: process.env.FORGE_DEBUG === "1",
  toolTimeoutMs: Number(process.env.FORGE_TOOL_TIMEOUT_MS ?? 15000),
};
