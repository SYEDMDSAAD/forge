import { runInSandbox } from "../src/sandbox/sandbox.js";
const code = `export default async function run({ city }) {
  const geo = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
  const p = geo.results[0];
  const w = await (await fetch(\`https://api.open-meteo.com/v1/forecast?latitude=\${p.latitude}&longitude=\${p.longitude}&current=temperature_2m\`)).json();
  return { speech: \`It's \${w.current.temperature_2m} degrees in \${p.name}.\`, data: w.current };
}`;
const t0 = Date.now();
console.log(JSON.stringify(await runInSandbox({ mode: "test", code, allowedDomains: ["open-meteo.com"], tests: [{ name: "pune", input: { city: "Pune" }, assert: "typeof result.data.temperature_2m === 'number'" }] }), null, 1).slice(0, 900));
console.log("ms", Date.now() - t0);
console.log(JSON.stringify(await runInSandbox({ mode: "run", code: `export default async () => { await fetch("https://example.com"); return {speech:"x"} }`, allowedDomains: ["open-meteo.com"] })));
