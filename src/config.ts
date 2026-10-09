import path from "node:path";

export type Provider = "anthropic" | "bedrock" | "ollama";
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
    process.env.FORGE_MODEL ??
    { anthropic: "claude-opus-5-5", bedrock: "anthropic.claude-opus-5-5", ollama: "qwen2.5:3b" }[provider],
  // Ollama serves an Anthropic-compatible Messages API; used as a free local stand-in during development.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  sandbox: (process.env.FORGE_SANDBOX ?? "docker") as SandboxKind,
  sandboxImage: process.env.FORGE_SANDBOX_IMAGE ?? "node:20-alpine",
  dataDir: path.resolve(process.env.FORGE_DATA_DIR ?? "data"),
  // How many times the smith may resubmit a tool after failing tests.
  maxSubmissions: Number(process.env.FORGE_MAX_SUBMISSIONS ?? 4),
  // Hard cap on agent turns (probes + submissions) per forge.
  maxTurns: Number(process.env.FORGE_MAX_TURNS ?? 16),
  // Print raw model turns and tool results to stderr.
  debug: process.env.FORGE_DEBUG === "1",
  toolTimeoutMs: Number(process.env.FORGE_TOOL_TIMEOUT_MS ?? 15000),
};
