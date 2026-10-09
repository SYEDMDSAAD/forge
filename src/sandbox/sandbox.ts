import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const RUNNER = readFileSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)), "utf8");
const MARKER = "__FORGE_RESULT__";

export interface SandboxJob {
  mode: "run" | "test" | "probe";
  allowedDomains: string[];
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface SandboxOutput {
  ok: boolean;
  error?: string;
  logs: string;
  fetched: string[];
  [key: string]: unknown;
}

/**
 * Locked-down container: no host mounts, read-only root, no capabilities,
 * non-root user, capped memory/CPU/PIDs. Network egress is open at the
 * container level; the runner enforces the per-tool domain allowlist.
 */
function dockerCommand(): [string, string[]] {
  return [
    "docker",
    [
      "run", "--rm", "-i",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=16m",
      "--memory", "256m",
      "--cpus", "1",
      "--pids-limit", "64",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "node",
      config.sandboxImage,
      "node", "--input-type=module", "-e", RUNNER,
    ],
  ];
}

/** Dev fallback when Docker is unavailable: separate process, empty env, Node permission model. */
function processCommand(): [string, string[]] {
  return [process.execPath, ["--experimental-permission", "--input-type=module", "-e", RUNNER]];
}

export async function runInSandbox(job: SandboxJob): Promise<SandboxOutput> {
  const timeoutMs = job.timeoutMs ?? config.toolTimeoutMs;
  const tests = Array.isArray(job.tests) ? job.tests.length : 1;
  // Container start-up plus every test's own budget.
  const hardLimit = timeoutMs * tests + 20000;

  const [cmd, args] = config.sandbox === "docker" ? dockerCommand() : processCommand();
  const child = spawn(cmd, args, {
    cwd: os.tmpdir(),
    env: config.sandbox === "docker" ? process.env : { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(JSON.stringify({ ...job, timeoutMs }));

  const timer = setTimeout(() => child.kill("SIGKILL"), hardLimit);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);

  const idx = stdout.lastIndexOf(MARKER);
  if (idx === -1) {
    return {
      ok: false,
      error: `Sandbox exited (code ${code}) without a result. ${stderr.slice(-1500)}`.trim(),
      logs: "",
      fetched: [],
    };
  }
  return JSON.parse(stdout.slice(idx + MARKER.length).trim()) as SandboxOutput;
}
