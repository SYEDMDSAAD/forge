import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { relayFetch, type RelayRequest } from "./relay.js";

const RUNNER = readFileSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)), "utf8");
const MARKER = "__FORGE_RESULT__";
const FETCH_MARKER = "__FORGE_FETCH__";
// Per job; a skill making more requests than this is broken or hostile.
const MAX_FETCHES = 50;

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
 * Locked-down container: no network, no host mounts, read-only root, no
 * capabilities, non-root user, capped memory/CPU/PIDs. The only way out is the
 * runner's fetch, which the host relays (relay.ts) under the skill's allowlist.
 */
function dockerCommand(): [string, string[]] {
  return [
    "docker",
    [
      "run", "--rm", "-i",
      "--network", "none",
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

/** Dev fallback when Docker is unavailable: separate process, empty env, Node permission model. Not a network boundary. */
function processCommand(): [string, string[]] {
  return [process.execPath, ["--experimental-permission", "--input-type=module", "-e", RUNNER]];
}

interface Runner {
  child: ChildProcessWithoutNullStreams;
  out: { stdout: string; stderr: string };
  closed: Promise<number | null>;
  /** Set when the runner is given a job: handles its fetch requests. */
  onFetch?: (req: RelayRequest) => void;
}

function spawnRunner(): Runner {
  const [cmd, args] = config.sandbox === "docker" ? dockerCommand() : processCommand();
  const child = spawn(cmd, args, {
    cwd: os.tmpdir(),
    env: config.sandbox === "docker" ? process.env : { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  const runner: Runner = { child, out, closed: new Promise((resolve) => child.on("close", resolve)) };
  let partial = "";
  child.stdout.on("data", (d) => {
    out.stdout += d;
    partial += d;
    const lines = partial.split("\n");
    partial = lines.pop()!;
    for (const line of lines) {
      const at = line.indexOf(FETCH_MARKER);
      if (at === -1) continue;
      try {
        runner.onFetch?.(JSON.parse(line.slice(at + FETCH_MARKER.length)) as RelayRequest);
      } catch {
        // malformed request line: ignore
      }
    }
  });
  child.stderr.on("data", (d) => (out.stderr += d));
  child.stdin.on("error", () => {}); // runner may exit before a relayed reply arrives
  return runner;
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

  const runner = takeRunner();
  const { child, out, closed } = runner;
  const fetched: string[] = [];
  let fetches = 0;
  runner.onFetch = (req) => {
    const reply = (msg: object) => child.stdin.writable && child.stdin.write(JSON.stringify(msg) + "\n");
    if (++fetches > MAX_FETCHES) return void reply({ id: req.id, ok: false, code: "ELIMIT", error: `More than ${MAX_FETCHES} requests in one run` });
    void relayFetch(req, job.allowedDomains, fetched, Number(job.fetchTimeoutMs ?? 10000)).then(reply);
  };
  child.stdin.write(JSON.stringify({ ...job, timeoutMs }) + "\n");

  const timer = setTimeout(() => child.kill("SIGKILL"), hardLimit);
  const code = await closed;
  clearTimeout(timer);
  child.stdin.end();

  const idx = out.stdout.lastIndexOf(MARKER);
  if (idx === -1) {
    return {
      ok: false,
      error: `Sandbox exited (code ${code}) without a result. ${out.stderr.slice(-1500)}`.trim(),
      logs: "",
      fetched,
    };
  }
  // The host's record of what was fetched, not the runner's.
  return { ...(JSON.parse(out.stdout.slice(idx + MARKER.length).trim()) as SandboxOutput), fetched };
}
