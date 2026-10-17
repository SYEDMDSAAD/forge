import type { SmithResult } from "./smith.js";
import { ForgeFailed, testSpec } from "./smith.js";
import type { ForgeEvent, ToolSpec } from "./types.js";

// FORGE_PROVIDER=mock: replays a known-good forge with realistic pacing, so the
// MCP task flow and the web client can be developed without a model. The tests
// still run for real in the sandbox.
const ONLINE_WEATHER: ToolSpec = {
  name: "get_current_weather",
  title: "Current Weather",
  description: "Gets the current temperature and conditions for a city by name. Use when the user asks about the weather right now somewhere.",
  inputSchema: { type: "object", properties: { city: { type: "string", description: "City name, e.g. Pune" } }, required: ["city"] },
  allowedDomains: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
  sources: ["Open-Meteo"],
  code: `export default async function run({ city }) {
  const geo = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
  if (!geo.results?.length) return { speech: \`I couldn't find a place called \${city}.\` };
  const p = geo.results[0];
  const w = await (await fetch(\`https://api.open-meteo.com/v1/forecast?latitude=\${p.latitude}&longitude=\${p.longitude}&current=temperature_2m,wind_speed_10m\`)).json();
  return { speech: \`It's \${Math.round(w.current.temperature_2m)} degrees in \${p.name} right now.\`, data: { place: p.name, ...w.current } };
}`,
  tests: [{ name: "pune", input: { city: "Pune" }, assert: "typeof result.data.temperature_2m === 'number' && result.speech.includes('Pune')" }],
};

// FORGE_MOCK_OFFLINE=1 (the test suites): same skill, but it makes up a temperature
// instead of calling Open-Meteo, so tests don't depend on a third-party server.
const OFFLINE_WEATHER: ToolSpec = {
  ...ONLINE_WEATHER,
  code: `export default async function run({ city }) {
  const temperature_2m = 20 + [...city].reduce((n, c) => n + c.charCodeAt(0), 0) % 15;
  return { speech: \`It's \${temperature_2m} degrees in \${city} right now.\`, data: { place: city, temperature_2m } };
}`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockForge(_request: string, onEvent: (e: ForgeEvent) => void): Promise<SmithResult> {
  const WEATHER = process.env.FORGE_MOCK_OFFLINE === "1" ? OFFLINE_WEATHER : ONLINE_WEATHER;
  const pace = Number(process.env.FORGE_MOCK_PACE_MS ?? 800);
  onEvent({ stage: "thinking", message: "Designing the capability" });
  await sleep(pace);
  onEvent({ stage: "probe", message: "Looking at api.open-meteo.com" });
  await sleep(pace);
  onEvent({ stage: "submit", message: `Wrote ${WEATHER.name} (attempt 1)` });
  onEvent({ stage: "test", message: "Running 1 live test in the sandbox" });
  const report = await testSpec(WEATHER);
  onEvent({ stage: report.passed ? "ready" : "repair", message: report.passed ? `All tests passed for ${WEATHER.name}` : "Mock test failed" });
  // The replay can't repair anything; a failed live test (e.g. the source is down) ends the build.
  if (!report.passed) throw new ForgeFailed("Its live test failed, so I didn't keep it. The weather source may be busy; try again in a minute.");
  return { spec: WEATHER, report, attempts: 1 };
}
