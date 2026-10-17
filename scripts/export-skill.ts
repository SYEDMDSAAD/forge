// Exports a learned skill as a standalone MCP server folder, ready for review.
//   npx tsx scripts/export-skill.ts                  # list learned skills
//   npx tsx scripts/export-skill.ts <name> [folder]  # default folder: exports/<name>
import { exportCapability } from "../src/forge/export.js";
import { Registry } from "../src/forge/registry.js";

const [name, folder] = process.argv.slice(2);
const registry = new Registry();
const skills = registry.active();
if (!name) {
  console.log(skills.length ? `Learned skills:\n${skills.map((c) => `  ${c.spec.name}  (${c.spec.title})`).join("\n")}` : "No learned skills yet.");
  process.exit(0);
}
const cap = registry.byName(name);
if (!cap) {
  console.error(`No learned skill called "${name}". Learned: ${skills.map((c) => c.spec.name).join(", ") || "none"}`);
  process.exit(1);
}
const dir = exportCapability(cap, folder ?? `exports/${name}`);
console.log(`Exported "${cap.spec.title}" to ${dir}\n  cd ${dir} && npm install && npm test && npm start`);
