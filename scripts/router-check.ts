// Checks the demo page's assistant brain (src/assistant.ts): given 11 learned
// skills, does it pick the right one (or none) and fill in the right inputs?
// Needs a real provider.   npx tsx scripts/router-check.ts
import { route, type RouteSkill } from "../src/assistant.js";

const str = (description: string) => ({ type: "string", description });
const skill = (name: string, description: string, props: Record<string, { type: string; description: string }> = {}): RouteSkill => ({
  name,
  title: name,
  description,
  inputSchema: { properties: props, required: Object.keys(props) },
});

// Shaped like the skills the guided smith writes from the verified catalog.
const SKILLS = [
  skill("get_current_weather", "Current temperature, rain and wind for a city.", { city: str("City name, e.g. Pune") }),
  skill("get_air_quality", "Air quality index (AQI) and pollution level for a city.", { city: str("City name, e.g. Delhi") }),
  skill("get_iss_location", "Where the International Space Station is right now."),
  skill("convert_currency", "Converts an amount of money from one currency to another at today's rate.", {
    amount: { type: "number", description: "Amount to convert" },
    from: str("ISO currency code to convert from, e.g. USD"),
    to: str("ISO currency code to convert to, e.g. INR"),
  }),
  skill("get_crypto_price", "Current price of a cryptocurrency.", { coin: str("CoinGecko coin id, e.g. bitcoin") }),
  skill("get_wikipedia_summary", "A short summary of a person, place or topic from Wikipedia.", { topic: str("What to look up") }),
  skill("get_top_hacker_news", "Today's top stories on Hacker News."),
  skill("define_word", "The meaning of an English word.", { word: str("The word to define") }),
  skill("get_next_launch", "The next upcoming rocket launch."),
  skill("get_recent_earthquakes", "The strongest recent earthquakes around the world."),
  skill("get_public_holidays", "Upcoming public holidays in a country.", { country: str("ISO 3166 two-letter country code, e.g. DE") }),
];

// [request, expected skill or null, expected inputs (case-insensitive), inputs that should be reported missing]
const CASES: [string, string | null, Record<string, unknown>, string[]?][] = [
  ["How hot is it in Tokyo right now?", "get_current_weather", { city: "Tokyo" }],
  ["Do I need an umbrella in Mumbai?", "get_current_weather", { city: "Mumbai" }],
  ["Is the air safe to go running in Delhi?", "get_air_quality", { city: "Delhi" }],
  ["Where's the space station?", "get_iss_location", {}],
  ["How many rupees is 250 dollars?", "convert_currency", { amount: 250, from: "USD", to: "INR" }],
  ["Convert 40 pounds to euros", "convert_currency", { amount: 40, from: "GBP", to: "EUR" }],
  ["What's ethereum trading at?", "get_crypto_price", { coin: "ethereum" }],
  ["Who was Ada Lovelace?", "get_wikipedia_summary", { topic: "Ada Lovelace" }],
  ["What's trending in tech today?", "get_top_hacker_news", {}],
  ["What does ephemeral mean?", "define_word", { word: "ephemeral" }],
  ["When's the next rocket going up?", "get_next_launch", {}],
  ["Any big earthquakes lately?", "get_recent_earthquakes", {}],
  ["Any public holidays coming up in Germany?", "get_public_holidays", { country: "DE" }],
  ["What's the weather like?", "get_current_weather", {}, ["city"]],
  ["What's the tide in Goa today?", null, {}],
  ["Book me a cab to the airport", null, {}],
  ["How many calories are in a banana?", null, {}],
  ["What's the UV index in Chennai?", null, {}],
];

const norm = (v: unknown) => String(v).toLowerCase().trim();
let passed = 0;
let total = 0;
for (const [utterance, want, inputs, missing = []] of CASES) {
  const r = await route(utterance, SKILLS);
  if (!r) throw new Error("No router model: set FORGE_PROVIDER to ollama, anthropic or bedrock");
  total += r.ms;
  const got = r.skill === null ? null : r.skill;
  const problems: string[] = [];
  if (got !== want) problems.push(`picked ${got ?? "none"}`);
  if (r.skill !== null && got === want) {
    for (const [k, v] of Object.entries(inputs)) if (norm(r.input[k]) !== norm(v)) problems.push(`${k}=${JSON.stringify(r.input[k])}`);
    if (norm(r.missing.sort()) !== norm(missing.sort())) problems.push(`missing=${JSON.stringify(r.missing)}`);
  }
  if (!problems.length) passed++;
  const shown = r.skill === null ? "none" : `${r.skill} ${JSON.stringify(r.input)}`;
  console.log(`${problems.length ? "FAIL" : "PASS"} ${utterance} -> ${shown} (${r.ms} ms)${problems.length ? `  [want ${want ?? "none"}: ${problems.join(", ")}]` : ""}`);
}
console.log(`\n${passed}/${CASES.length} routed correctly, ${Math.round(total / CASES.length)} ms on average`);
process.exit(passed === CASES.length ? 0 : 1);
