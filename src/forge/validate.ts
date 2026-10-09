import type { ToolSpec } from "./types.js";

const NAME = /^[a-z][a-z0-9_]{2,47}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const RESERVED = new Set(["forge_capability", "approve_capability", "list_capabilities", "inspect_capability", "remove_capability"]);

// Tool code gets `fetch` and the JS standard library, nothing else.
const FORBIDDEN: [RegExp, string][] = [
  [/^\s*import\s/m, "static imports are not allowed; use only fetch and built-in globals"],
  [/\bimport\s*\(/, "dynamic import() is not allowed"],
  [/\brequire\s*\(/, "require() is not allowed"],
  [/\bprocess\s*\./, "access to `process` is not allowed"],
  [/\beval\s*\(/, "eval() is not allowed"],
  [/\bnew\s+Function\b/, "new Function() is not allowed"],
  [/\bchild_process\b|\bnode:/, "Node built-in modules are not allowed"],
];

/** Static checks before anything runs. Returns a list of problems (empty when valid). */
export function validateSpec(spec: ToolSpec): string[] {
  const problems: string[] = [];
  if (!NAME.test(spec.name)) problems.push(`name "${spec.name}" must match ${NAME}`);
  if (RESERVED.has(spec.name)) problems.push(`name "${spec.name}" is reserved`);
  if (!spec.description || spec.description.length < 20) problems.push("description must explain when to use the tool (20+ chars)");

  const schema = spec.inputSchema as { type?: unknown; properties?: unknown };
  if (schema?.type !== "object" || typeof schema.properties !== "object") {
    problems.push('input schema must be a JSON Schema with type "object" and properties');
  }

  if (!/export\s+default\s+(async\s+)?function/.test(spec.code)) {
    problems.push("code must `export default async function run(input)`");
  }
  for (const [pattern, why] of FORBIDDEN) if (pattern.test(spec.code)) problems.push(why);
  if (spec.code.length > 20000) problems.push("code is too long (20k char limit)");

  if (spec.allowedDomains.length === 0) problems.push("allowed_domains must list every host the tool fetches");
  for (const d of spec.allowedDomains) if (!HOST.test(d)) problems.push(`"${d}" is not a plain public hostname`);

  if (spec.tests.length < 1 || spec.tests.length > 5) problems.push("provide 1-5 tests");
  return problems;
}
