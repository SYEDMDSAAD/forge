import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface Runner {
  child: ChildProcessWithoutNullStreams;
  out: { stdout: string; stderr: string };
  closed: Promise<number | null>;
}

function spawnRunner(): Runner {
  const [cmd, args] = config.sandbox === "docker" ? dockerCommand() : processCommand();
  const child = spawn(cmd, args, {
    cwd: os.tmpdir(),
    env: config.sandbox === "docker" ? process.env : { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, out, closed };
}

// Pre-started runners blocked on stdin, so a call doesn't pay container start-up
// (~250ms). Each runner still executes exactly one job and exits: no state is
// shared between calls.
const pool: Runner[] = [];

function setIdle(r: Runner, idle: boolean) {
  for (const h of [r.child, r.child.stdin, r.child.stdout, r.child.stderr] as unknown as { ref(): void; unref(): void }[]) {
    if (idle) h.unref();
    else h.ref();
  }
}

function refill() {
  while (pool.length < config.warmPool) {
    const r = spawnRunner();
    setIdle(r, true); // an idle pool never keeps the process alive
    void r.closed.then(() => {
      const i = pool.indexOf(r);
      if (i !== -1) pool.splice(i, 1);
    });
    pool.push(r);
  }
}

function takeRunner(): Runner {
  let r = pool.shift();
  while (r && r.child.exitCode !== null) r = pool.shift();
  if (r) setIdle(r, false);
  else r = spawnRunner();
  refill();
  return r;
}

/** Start the warm pool ahead of the first call. */
export function warmSandbox() {
  refill();
}

/** Let pooled runners exit (empty stdin makes the runner quit). */
export function shutdownSandbox() {
  for (const r of pool.splice(0)) r.child.stdin.end();
}

export async function runInSandbox(job: SandboxJob): Promise<SandboxOutput> {
  const timeoutMs = job.timeoutMs ?? config.toolTimeoutMs;
  const tests = Array.isArray(job.tests) ? job.tests.length : 1;
  // Container start-up plus every test's own budget.
  const hardLimit = timeoutMs * tests + 20000;

  const { child, out, closed } = takeRunner();
  child.stdin.end(JSON.stringify({ ...job, timeoutMs }));

  const timer = setTimeout(() => child.kill("SIGKILL"), hardLimit);
  const code = await closed;
  clearTimeout(timer);

  const idx = out.stdout.lastIndexOf(MARKER);
  if (idx === -1) {
    return {
      ok: false,
      error: `Sandbox exited (code ${code}) without a result. ${out.stderr.slice(-1500)}`.trim(),
      logs: "",
      fetched: [],
    };
  }
  return JSON.parse(out.stdout.slice(idx + MARKER.length).trim()) as SandboxOutput;
}
