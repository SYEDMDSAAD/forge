// Exports a skill and runs the result on its own: its tests, its MCP server
// (one fixed tool) and its site allowlist. The folder sits inside the repo so it
// borrows Forge's node_modules; a real export runs `npm install` instead.
//   npx tsx scripts/export-check.ts
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { exportCapability } from "../src/forge/export.js";
import type { Capability } from "../src/forge/types.js";

const dir = path.resolve("exports/.export-check");
rmSync(dir, { recursive: true, force: true });
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const cap: Capability = {
  id: "check",
  status: "active",
  request: "Convert 100 US dollars to rupees",
  createdAt: new Date().toISOString(),
  attempts: 1,
  uses: 0,
  testReport: { passed: true, results: [{ name: "example", passed: true, durationMs: 300 }] } as Capability["testReport"],
  spec: {
    name: "convert_currency",
    title: "Currency Converter",
    description: "Converts an amount of money between currencies at today's rate.",
    inputSchema: {
      type: "object",
      properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } },
      required: ["amount", "from", "to"],
    },
    allowedDomains: ["api.frankfurter.dev"],
    sources: ["Frankfurter"],
    code: `export default async function run({ amount, from, to }) {
  const r = await (await fetch("https://api.frankfurter.dev/v1/latest?base=" + from + "&symbols=" + to)).json();
  const value = Math.round(amount * r.rates[to]);
  return { speech: amount + " " + from + " is about " + value.toLocaleString("en-IN") + " " + to + ".", data: { rate: r.rates[to] } };
}`,
    tests: [
      {
        name: "example",
        input: { amount: 100, from: "USD", to: "INR" },
        assert: "result.speech.includes('INR')",
        reference: {
          code: `export default async ({ amount, from, to }) => { const r = await (await fetch("https://api.frankfurter.dev/v1/latest?base=" + from + "&symbols=" + to)).json(); return [amount * r.rates[to]]; }`,
        },
      },
    ],
  },
};

let server: ReturnType<typeof spawn> | undefined;
try {
  exportCapability(cap, dir);
  const files = ["skill.mjs", "lib.mjs", "server.mjs", "test.mjs", "forge-export.json", "package.json", "Dockerfile", "README.md"];
  check(files.every((f) => existsSync(path.join(dir, f))), `export folder has ${files.join(", ")}`);

  let out = "";
  try {
    out = execFileSync("node", ["test.mjs"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? e);
  }
  check(/1\/1 passed \(with source cross-check\)/.test(out), `its own tests pass, with the cross-check: ${out.split("\n")[1]?.trim()}`);

  const blocked = execFileSync("node", ["--input-type=module", "-e", `await import("./lib.mjs"); try { await fetch("https://example.com"); console.log("REACHED") } catch (e) { console.log(e.message) }`], {
    cwd: dir,
    encoding: "utf8",
  });
  check(/not one of this skill's declared sites/.test(blocked), "fetch to an undeclared site is refused");

  server = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: "8794" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => server!.stdout!.on("data", (d) => String(d).includes("MCP server") && r(null)));
  const rpc = async (method: string, params: object) => {
    const res = await fetch("http://localhost:8794/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : text).result;
  };
  const tools = (await rpc("tools/list", {})).tools;
  check(tools.length === 1 && tools[0].name === "convert_currency" && tools[0].annotations?.readOnlyHint, "its MCP server lists exactly one read-only tool");
  const answer = (await rpc("tools/call", { name: "convert_currency", arguments: { amount: 250, from: "GBP", to: "INR" } })).content[0].text;
  check(/^250 GBP is about [\d,]+ INR\. Source: Frankfurter\.$/.test(answer), `and answers with its source: "${answer}"`);
  const wrong = await rpc("tools/call", { name: "convert_currency", arguments: { amount: "lots", from: "GBP", to: "INR" } });
  check(wrong.isError && /amount must be a number/.test(wrong.content[0].text), "wrong input is rejected against the schema");
} catch (e) {
  console.log("FAIL threw:", e);
  failed = true;
} finally {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
