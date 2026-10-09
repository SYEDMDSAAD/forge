// Shows the cross-check catching a skill whose sentence looks right but whose number is wrong.
//   npx tsx scripts/crosscheck-demo.ts
// Both skills read the same live rate; the broken one applies the amount twice (a bug a model really made).
import { CATALOG } from "../src/forge/catalog.js";
import { runInSandbox, shutdownSandbox } from "../src/sandbox/sandbox.js";

const currency = CATALOG.find((s) => s.id === "currency")!;
const skill = (factor: string) => `export default async function run({ amount, from_currency, to_currency }) {
  const r = await (await fetch(\`https://api.frankfurter.dev/v1/latest?base=\${from_currency}&symbols=\${to_currency}\`)).json();
  const converted = Math.round(amount * r.rates[to_currency]${factor});
  return { speech: \`\${amount} \${from_currency} is about \${converted.toLocaleString("en-IN")} \${to_currency}.\` };
}`;

for (const [label, code] of [
  ["correct skill", skill("")],
  ["buggy skill (amount applied twice)", skill(" * amount")],
] as const) {
  const out = await runInSandbox({
    mode: "test",
    code,
    allowedDomains: currency.domains,
    tests: [{ name: label, input: { amount: 100, from_currency: "USD", to_currency: "INR" }, assert: "true", reference: currency.reference }],
  });
  const r = (out.results as { passed: boolean; error?: string; result?: { speech?: string } }[] | undefined)?.[0];
  console.log(`\n${label}\n  says:    "${r?.result?.speech ?? out.error}"\n  verdict: ${r?.passed ? "PASS" : `REJECTED — ${r?.error}`}`);
}
shutdownSandbox();
