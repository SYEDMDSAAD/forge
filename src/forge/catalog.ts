import type { Reference } from "./types.js";

// Keyless public APIs that Forge has checked by hand. The guided smith (for
// small local models) builds skills only from these; the Claude smith gets
// them as starting points and may go beyond them.

export interface Endpoint {
  /** URL template; {placeholders} are filled in by the skill's code. */
  url: string;
  /** What the response looks like and which fields matter. */
  returns: string;
  /** A concrete URL Forge fetches to show the model a real response. */
  example: string;
}

/**
 * What kind of answer a source gives, shown with every answer: live data, knowledge
 * written from an article, an exact fact, or a calculation that needs no website.
 */
export type SourceKind = "live" | "knowledge" | "fact" | "calculation";

export interface Source {
  id: string;
  /** Default "live". */
  kind?: SourceKind;
  /** Cited in every answer the skill gives. */
  name: string;
  /** Trusted cross-check used in the live test (see runner.mjs); only for numeric sources. */
  reference?: Reference;
  useFor: string;
  domains: string[];
  endpoints: Endpoint[];
  notes?: string;
  /**
   * For a source that answers any topic (news), the one general skill it makes,
   * so a skill learned for one question never answers a different one with a
   * fixed topic, and later questions reuse it.
   */
  tool?: {
    name: string;
    title: string;
    description: string;
    /** `another`: second test values (the first that differs from the user's), to catch a value fixed in the code. */
    /** fromRequest: the value is words the user said (a topic, a city), never one of the description's examples. */
    /** generic: words like "today's hot news" mean no topic at all (the source's default, e.g. top headlines). */
    /** wholeRequest: the user's question itself, word for word (to find the passage that answers it). */
    inputs: { name: string; type?: "number"; description: string; optional?: boolean; fromRequest?: boolean; generic?: boolean; wholeRequest?: boolean; another: string[] }[];
  };
}

// Reference checks. They can't know the input names a model chose, so they read
// inputs by shape: the first string is a place, a number is an amount, 3-letter
// strings are currency codes.
const firstString = `const firstString = (input) => Object.values(input).find((v) => typeof v === "string" && v.trim());`;
const geocode = `async function geocode(name) {
  const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(name))).json();
  return g.results?.[0];
}`;

const WEATHER_REFERENCE: Reference = {
  code: `${firstString}
${geocode}
export default async function (input) {
  const place = firstString(input) && (await geocode(firstString(input)));
  if (!place) return [];
  const w = await (await fetch(\`https://api.open-meteo.com/v1/forecast?latitude=\${place.latitude}&longitude=\${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3\`)).json();
  const c = w.current ?? {}, d = w.daily ?? {};
  return [c.temperature_2m, c.relative_humidity_2m, c.wind_speed_10m, c.precipitation, ...(d.temperature_2m_max ?? []), ...(d.temperature_2m_min ?? []), ...(d.precipitation_probability_max ?? [])];
}`,
  absTol: 1.5,
  relTol: 0.05,
};

const AIR_QUALITY_REFERENCE: Reference = {
  code: `${firstString}
${geocode}
export default async function (input) {
  const place = firstString(input) && (await geocode(firstString(input)));
  if (!place) return [];
  const a = await (await fetch(\`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=\${place.latitude}&longitude=\${place.longitude}&current=us_aqi,pm2_5,pm10\`)).json();
  return [a.current?.us_aqi, a.current?.pm2_5, a.current?.pm10];
}`,
  absTol: 3,
  relTol: 0.05,
};

const ISS_REFERENCE: Reference = {
  code: `export default async function () {
  const s = await (await fetch("https://api.wheretheiss.at/v1/satellites/25544")).json();
  return [s.altitude, s.velocity, s.velocity / 3.6, s.velocity * 0.621371, s.altitude * 0.621371];
}`,
  relTol: 0.03,
};

const CURRENCY_REFERENCE: Reference = {
  code: `export default async function (input) {
  const values = Object.values(input);
  const amount = Number(values.find((v) => typeof v === "number" || /^\\d+(\\.\\d+)?$/.test(String(v))) ?? 1);
  const codes = values.filter((v) => typeof v === "string" && /^[a-z]{3}$/i.test(v.trim())).map((v) => v.trim().toUpperCase());
  if (codes.length < 2) return [];
  const r = await (await fetch(\`https://api.frankfurter.dev/v1/latest?base=\${codes[0]}&symbols=\${codes[1]}\`)).json();
  const rate = r.rates?.[codes[1]];
  return rate ? [amount * rate, rate] : [];
}`,
  relTol: 0.02,
};

const CRYPTO_REFERENCE: Reference = {
  code: `export default async function (input) {
  const strings = Object.values(input).filter((v) => typeof v === "string").map((v) => v.trim().toLowerCase());
  const coin = strings.find((v) => !/^[a-z]{3}$/.test(v));
  // No currency in the input means the skill picks its own, so accept the common ones.
  const currency = strings.find((v) => /^[a-z]{3}$/.test(v)) ?? "usd,inr,eur";
  if (!coin) return [];
  const p = await (await fetch(\`https://api.coingecko.com/api/v3/simple/price?ids=\${encodeURIComponent(coin)}&vs_currencies=\${currency}&include_24hr_change=true\`)).json();
  return Object.values(p[coin] ?? {});
}`,
  relTol: 0.03,
};

// Headlines, not numbers: the answer must quote at least one of them (see runner.mjs).
const NEWS_REFERENCE: Reference = {
  code: `export default async function (input, { fetched = [] } = {}) {
  // The same feed the skill read, so even a skill with a fixed topic is checked.
  let url = fetched.find((u) => u.includes("news.google.com/rss"));
  if (!url) {
    const words = Object.values(input).filter((v) => typeof v === "string").join(" ").trim().split(/\\s+/).filter(Boolean);
    if (!words.length) throw new Error("Cross-check failed: the skill never read the news feed, so its answer can't come from it. Fetch the feed and say its titles.");
    url = "https://news.google.com/rss/search?q=" + words.map(encodeURIComponent).join("+") + "+when:7d&hl=en-IN&gl=IN&ceid=IN:en";
  }
  const topic = Object.values(input).filter((v) => typeof v === "string").join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const asked = decodeURIComponent(url.split("q=")[1]?.split("&")[0] ?? "").toLowerCase();
  if (topic.length && !topic.some((w) => asked.includes(w))) throw new Error("Cross-check failed: the skill searched for '" + asked + "' instead of its topic input. Build the query from the input.");
  const xml = await (await fetch(url)).text();
  return xml.split("<item>").slice(1, 30).map((it) => (it.split("<title>")[1] ?? "").split("</title>")[0]);
}`,
};

// Launch names, like the headlines: the answer must name one of the launches in
// the very list the skill read, and a skill asked about one agency must search for it.
const LAUNCH_REFERENCE: Reference = {
  code: `export default async function (input, { fetched = [] } = {}) {
  const asked = Object.values(input).filter((v) => typeof v === "string").join(" ").trim();
  let url = fetched.find((u) => u.includes("/launch/upcoming"));
  if (!url) {
    if (!asked) throw new Error("Cross-check failed: the skill never read the launch list, so its answer can't come from it.");
    url = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=3&mode=list&search=" + encodeURIComponent(asked);
  }
  const search = decodeURIComponent(url.split("search=")[1]?.split("&")[0] ?? "").toLowerCase();
  if (asked && !asked.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 1 && search.includes(w))) throw new Error("Cross-check failed: the user asked about '" + asked + "' but the skill didn't search for it. Add &search= with the input to the URL.");
  const json = await (await fetch(url)).json();
  return (json.results ?? []).slice(0, 3).map((r) => r.name);
}`,
};

// Wikipedia's own words: the answer must quote a summary the skill read, so a
// skill can't fetch the articles and then say something the model wrote itself.
const WIKIPEDIA_REFERENCE: Reference = {
  code: `export default async function (input, { fetched = [] } = {}) {
  // The topics, not the question or the search words that come with them.
  const named = [input.topic, input.compare_with].filter((v) => typeof v === "string" && v.trim());
  const topics = named.length ? named : Object.values(input).filter((v) => typeof v === "string" && v.trim());
  let urls = [];
  for (const t of topics) {
    const s = await (await fetch("https://en.wikipedia.org/w/rest.php/v1/search/page?limit=1&q=" + encodeURIComponent(t))).json();
    if (s.pages?.[0]) urls.push("https://en.wikipedia.org/api/rest_v1/page/summary/" + s.pages[0].key);
  }
  if (!urls.length) urls = fetched.filter((u) => u.includes("/page/summary/"));
  if (!urls.length) throw new Error("Cross-check failed: the skill never read a Wikipedia summary, so its answer can't come from Wikipedia.");
  const every = [];
  for (const u of urls) every.push((await (await fetch(u)).json()).extract ?? "");
  // Each topic asked about (both, in a comparison) must be answered from its own summary.
  return { every: every.filter((t) => t.length >= 12) };
}`,
};

// Earthquakes: the answer must name a place from the feed itself (not one the model made up).
const EARTHQUAKE_REFERENCE: Reference = {
  code: `export default async function () {
  const feed = await (await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson")).json();
  return feed.features.slice(0, 20).map((q) => q.properties.place).filter((p) => typeof p === "string" && p.length >= 12);
}`,
};

// Wikidata: the same entity and property, read by Forge itself. Names (a capital) must be said,
// numbers (a population) must match, dates are compared by their year and day.
const WIKIDATA_PROPS = `{ population: "P1082", capital: "P36", area: "P2046", elevation: "P2044", height: "P2048", length: "P2043", founded: "P571", born: "P569", died: "P570", currency: "P38", language: "P37", "head of state": "P35", "head of government": "P6", country: "P17", author: "P50", director: "P57", inventor: "P61", "highest point": "P610" }`;
const WIKIDATA_REFERENCE: Reference = {
  code: `const PROPS = ${WIKIDATA_PROPS};
export default async function (input) {
  const pid = PROPS[String(input.property ?? "").toLowerCase().trim()];
  const entity = input.entity;
  if (!pid || !entity) return [];
  const s = await (await fetch("https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&limit=1&search=" + encodeURIComponent(entity))).json();
  if (!s.search?.length) return [];
  const q = "SELECT ?v ?vLabel WHERE { wd:" + s.search[0].id + " wdt:" + pid + " ?v . SERVICE wikibase:label { bd:serviceParam wikibase:language 'en'. } }";
  const r = await (await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q))).json();
  const values = r.results.bindings.map((b) => b.vLabel.value);
  const out = [];
  for (const v of values) {
    const date = /^(\\d{4})-(\\d\\d)-(\\d\\d)T/.exec(v);
    if (date) out.push(Number(date[1]), Number(date[3]));
    else if (/^-?\\d+(\\.\\d+)?$/.test(v)) out.push(Number(v));
  }
  return out.length ? out : { anyOf: values };
}`,
  relTol: 0.001,
};

// Calculations are checked by a second, independent calculator: a shunting-yard
// evaluator here, where the skill is shown a recursive-descent one.
const CALCULATOR_REFERENCE: Reference = {
  code: `export default async function (input) {
  const expr = String(input.expression ?? Object.values(input).find((v) => typeof v === "string") ?? "").replace(/×/g, "*").replace(/÷/g, "/").replace(/\\s+/g, "");
  const out = [];
  const ops = [];
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, "~": 4 };
  const apply = () => {
    const o = ops.pop();
    if (o === "~") return out.push(-out.pop());
    if (o === "s") return out.push(Math.sqrt(out.pop()));
    const b = out.pop();
    const a = out.pop();
    out.push(o === "+" ? a + b : o === "-" ? a - b : o === "*" ? a * b : o === "/" ? a / b : Math.pow(a, b));
  };
  let afterValue = false;
  for (let i = 0; i < expr.length; ) {
    const num = /^\\d+(\\.\\d+)?/.exec(expr.slice(i));
    if (num) { out.push(parseFloat(num[0])); i += num[0].length; afterValue = true; continue; }
    if (expr.startsWith("sqrt(", i)) { ops.push("s", "("); i += 5; afterValue = false; continue; }
    const c = expr[i++];
    if (c === "%") { out.push(out.pop() / 100); continue; }
    if (c === "(") { ops.push("("); afterValue = false; continue; }
    if (c === ")") {
      while (ops.length && ops.at(-1) !== "(") apply();
      ops.pop();
      if (ops.at(-1) === "s") apply();
      afterValue = true;
      continue;
    }
    const o = c === "-" && !afterValue ? "~" : c;
    if (!(o in prec)) return [];
    while (ops.length && ops.at(-1) !== "(" && ops.at(-1) !== "s" && (prec[ops.at(-1)] > prec[o] || (prec[ops.at(-1)] === prec[o] && o !== "^" && o !== "~"))) apply();
    ops.push(o);
    afterValue = false;
  }
  while (ops.length) apply();
  return Number.isFinite(out[0]) ? [out[0]] : [];
}`,
  // Answers are spoken with at most two decimals.
  relTol: 0.0001,
  absTol: 0.005,
};

// Unit conversions, from Forge's own table of exact factors.
const UNITS_REFERENCE: Reference = {
  code: `const F = { m: [1, 1], km: [1, 1000], cm: [1, 0.01], mm: [1, 0.001], mi: [1, 1609.344], yd: [1, 0.9144], ft: [1, 0.3048], in: [1, 0.0254],
  kg: [2, 1], g: [2, 0.001], mg: [2, 1e-6], lb: [2, 0.45359237], oz: [2, 0.028349523125], t: [2, 1000],
  l: [3, 1], ml: [3, 0.001], gal: [3, 3.785411784], cup: [3, 0.2365882365],
  kmh: [4, 1], mph: [4, 1.609344], ms: [4, 3.6], kn: [4, 1.852],
  m2: [5, 1], km2: [5, 1e6], ha: [5, 1e4], acre: [5, 4046.8564224], ft2: [5, 0.09290304],
  b: [6, 1], kb: [6, 1e3], mb: [6, 1e6], gb: [6, 1e9], tb: [6, 1e12] };
const toK = { c: (v) => v + 273.15, f: (v) => (v - 32) * 5 / 9 + 273.15, k: (v) => v };
const fromK = { c: (v) => v - 273.15, f: (v) => (v - 273.15) * 9 / 5 + 32, k: (v) => v };
export default async function (input) {
  const v = Number(input.value);
  const from = String(input.from_unit ?? "").toLowerCase();
  const to = String(input.to_unit ?? "").toLowerCase();
  if (from in toK && to in fromK) return [fromK[to](toK[from](v))];
  // Codes it doesn't know mean the skill was given the wrong input: that fails, it isn't skipped.
  if (!F[from] || !F[to] || F[from][0] !== F[to][0]) throw new Error("Cross-check failed: " + from + " to " + to + " isn't a conversion between two known unit codes of the same kind.");
  return [(v * F[from][1]) / F[to][1]];
}`,
  // Answers are spoken with two decimals: 3.11 miles for 3.1069.
  relTol: 0.005,
  absTol: 0.005,
};

// Days until a date, counted from today in India.
const DATES_REFERENCE: Reference = {
  code: `export default async function (input) {
  const target = String(input.date ?? "");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const ms = Date.parse(target + "T00:00:00Z") - Date.parse(today + "T00:00:00Z");
  return Number.isFinite(ms) ? [Math.abs(Math.round(ms / 86400000))] : [];
}`,
};

// The time in a city, from its time zone.
const CLOCK_REFERENCE: Reference = {
  code: `export default async function (input) {
  const city = input.city ?? Object.values(input).find((v) => typeof v === "string");
  const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
  const zone = g.results?.[0]?.timezone;
  if (!zone) return [];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return [h, h % 12 || 12, m];
}`,
  absTol: 1,
};

export const CATALOG: Source[] = [
  {
    id: "weather",
    reference: WEATHER_REFERENCE,
    name: "Open-Meteo",
    useFor: "current weather, temperature, rain chance, wind, multi-day forecast, sunrise/sunset for a city",
    domains: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
    tool: {
      name: "get_weather",
      title: "Weather",
      description: "The weather in a city: right now (temperature, sky, humidity, wind) with today's high, rain chance, sunrise and sunset; or the forecast for tomorrow or the day after.",
      inputs: [
        { name: "city", fromRequest: true, description: "the city, e.g. Pune", another: ["Mumbai", "London"] },
        { name: "day", description: "today, tomorrow or day after tomorrow, only when the user asks about a later day; leave out for right now", optional: true, another: ["tomorrow", "today"] },
      ],
    },
    endpoints: [
      {
        url: "https://geocoding-api.open-meteo.com/v1/search?count=1&name={city}",
        returns: "{ results?: [{ name, latitude, longitude, country, timezone }] } (results is missing when the place isn't found)",
        example: "https://geocoding-api.open-meteo.com/v1/search?count=1&name=Pune",
      },
      {
        url: "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto&forecast_days=3",
        returns: "{ current: { temperature_2m (°C), relative_humidity_2m (%), weather_code, wind_speed_10m (km/h), precipitation (mm) }, daily: { time[], temperature_2m_max[], temperature_2m_min[], precipitation_probability_max[], sunrise[], sunset[] } } (daily arrays: index 0 = today, 1 = tomorrow)",
        example: "https://api.open-meteo.com/v1/forecast?latitude=18.52&longitude=73.86&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto&forecast_days=3",
      },
    ],
    notes: `Read it like this:
const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
If !g.results, say that city wasn't found. const place = g.results[0];
const w = await (await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + place.latitude + "&longitude=" + place.longitude + "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto&forecast_days=3")).json();
const sky = (c) => (c === 0 ? "clear" : c <= 3 ? "partly cloudy" : c <= 48 ? "foggy" : c <= 67 ? "rainy" : c <= 77 ? "snowy" : c <= 82 ? "showery" : "stormy");
const at = (iso) => iso.slice(11, 16);
const d = w.daily;
const i = /after/i.test(day || "") ? 2 : /tomorrow/i.test(day || "") ? 1 : 0;
const speech = i === 0
  ? "In " + place.name + " it's " + Math.round(w.current.temperature_2m) + "°C and " + sky(w.current.weather_code) + " right now, with humidity at " + w.current.relative_humidity_2m + "% and wind at " + Math.round(w.current.wind_speed_10m) + " km/h. Today: a high of " + Math.round(d.temperature_2m_max[0]) + "°C, a " + d.precipitation_probability_max[0] + "% chance of rain, sunrise at " + at(d.sunrise[0]) + " and sunset at " + at(d.sunset[0]) + "."
  : (i === 1 ? "Tomorrow" : "The day after tomorrow") + " in " + place.name + ": a high of " + Math.round(d.temperature_2m_max[i]) + "°C and a low of " + Math.round(d.temperature_2m_min[i]) + "°C, with a " + d.precipitation_probability_max[i] + "% chance of rain. Sunrise at " + at(d.sunrise[i]) + ", sunset at " + at(d.sunset[i]) + ".";
return { speech, data: { temperature: Math.round(w.current.temperature_2m), humidity: w.current.relative_humidity_2m, wind_speed: Math.round(w.current.wind_speed_10m), rain_chance: d.precipitation_probability_max[i] } };`
  },
  {
    id: "air_quality",
    reference: AIR_QUALITY_REFERENCE,
    name: "Open-Meteo",
    useFor: "air quality index (AQI), pollution, PM2.5, PM10 for a city",
    domains: ["geocoding-api.open-meteo.com", "air-quality-api.open-meteo.com"],
    tool: {
      name: "get_air_quality",
      title: "Air Quality",
      description: "The current air quality (US AQI, PM2.5, PM10) and what it means for health, for any city.",
      inputs: [{ name: "city", fromRequest: true, description: "the city, e.g. Delhi", another: ["Mumbai", "London"] }],
    },
    endpoints: [
      {
        url: "https://geocoding-api.open-meteo.com/v1/search?count=1&name={city}",
        returns: "{ results?: [{ name, latitude, longitude, country }] }",
        example: "https://geocoding-api.open-meteo.com/v1/search?count=1&name=Delhi",
      },
      {
        url: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=us_aqi,pm2_5,pm10",
        returns: "{ current: { us_aqi, pm2_5 (μg/m³), pm10 (μg/m³) } }",
        example: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=28.61&longitude=77.21&current=us_aqi,pm2_5,pm10",
      },
    ],
    notes: `Read it like this:
const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
If !g.results, say that city wasn't found. const place = g.results[0];
const a = await (await fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + place.latitude + "&longitude=" + place.longitude + "&current=us_aqi,pm2_5,pm10")).json();
const aqi = Math.round(a.current.us_aqi);
US AQI bands: 0-50 good, 51-100 moderate, 101-150 unhealthy for sensitive groups, 151-200 unhealthy, 201-300 very unhealthy, 301+ hazardous.
Speech: "The air quality in " + place.name + " is " + band + ", with an AQI of " + aqi + ". PM2.5 is " + Math.round(a.current.pm2_5) + " micrograms per cubic metre." data: { us_aqi: aqi, pm2_5: a.current.pm2_5, pm10: a.current.pm10 }.`,
  },
  {
    id: "iss",
    reference: ISS_REFERENCE,
    name: "Where the ISS at and OpenStreetMap",
    useFor: "where the International Space Station is right now, its speed and altitude, which country it is over",
    domains: ["api.wheretheiss.at", "nominatim.openstreetmap.org"],
    tool: { name: "get_iss_location", title: "Where Is the ISS", description: "Where the International Space Station is right now: the country or ocean below it, its altitude and speed.", inputs: [] },
    endpoints: [
      {
        url: "https://api.wheretheiss.at/v1/satellites/25544",
        returns: "{ latitude, longitude, altitude (km), velocity (km/h), visibility }",
        example: "https://api.wheretheiss.at/v1/satellites/25544",
      },
      {
        url: "https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&zoom=3&accept-language=en",
        returns: "{ address?: { country } } (country name in English) or { error: 'Unable to geocode' } when over the ocean",
        example: "https://nominatim.openstreetmap.org/reverse?lat=18.5&lon=73.8&format=json&zoom=3&accept-language=en",
      },
    ],
    notes: `No input needed. Read it like this:
const iss = await (await fetch("https://api.wheretheiss.at/v1/satellites/25544")).json();
const geo = await (await fetch("https://nominatim.openstreetmap.org/reverse?lat=" + iss.latitude + "&lon=" + iss.longitude + "&format=json&zoom=3&accept-language=en")).json();
const where = geo.address && geo.address.country ? "over " + geo.address.country : "over the ocean";
Speech: "The International Space Station is " + where + " right now, at an altitude of " + Math.round(iss.altitude) + " kilometres, moving at " + Math.round(iss.velocity).toLocaleString("en-IN") + " kilometres per hour." data: { altitude: Math.round(iss.altitude), velocity: Math.round(iss.velocity), over: where }.`,
  },
  {
    id: "currency",
    reference: CURRENCY_REFERENCE,
    name: "the European Central Bank via Frankfurter",
    useFor: "convert an amount of money between currencies, today's exchange rates (USD, INR, EUR, GBP, JPY...); not which currency a country uses (a Wikidata fact)",
    domains: ["api.frankfurter.dev"],
    tool: {
      name: "convert_currency",
      title: "Convert Currency",
      description: "Converts an amount of money from one currency to another at today's exchange rate (USD, INR, EUR, GBP, JPY…). Not for cryptocurrencies.",
      inputs: [
        { name: "amount", type: "number", description: "the amount of money to convert", another: [] },
        { name: "from_currency", description: "3-letter code of the currency converted from, e.g. USD", another: ["EUR", "GBP"] },
        { name: "to_currency", description: "3-letter code of the currency converted to, e.g. INR", another: ["JPY", "CHF"] },
      ],
    },
    endpoints: [
      {
        url: "https://api.frankfurter.dev/v1/latest?base={FROM}&symbols={TO}",
        returns: "{ base, date, rates: { [TO]: rate } } where rate is the value of ONE unit of FROM in TO",
        example: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR",
      },
    ],
    notes: "Currency codes are 3 uppercase letters (USD, INR, EUR). converted = amount * rates[TO], multiplied exactly once. Say the amount with its unit, e.g. `100 US dollars is about 9,678 rupees`.",
  },
  {
    id: "crypto",
    reference: CRYPTO_REFERENCE,
    name: "CoinGecko",
    useFor: "cryptocurrency prices (bitcoin, ethereum, solana, dogecoin) and 24h change",
    domains: ["api.coingecko.com"],
    tool: {
      name: "get_crypto_price",
      title: "Crypto Price",
      description: "The current price and 24-hour change of a cryptocurrency (bitcoin, ethereum, solana, dogecoin…), in US dollars or another currency.",
      inputs: [
        { name: "coin", fromRequest: true, description: "the coin's full name in lowercase, e.g. bitcoin, ethereum, solana, dogecoin", another: ["ethereum", "solana"] },
        { name: "currency", description: "lowercase currency code to price it in, e.g. usd or inr; leave out for US dollars", optional: true, another: ["inr", "eur"] },
      ],
    },
    endpoints: [
      {
        url: "https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies={currency}&include_24hr_change=true",
        returns: "{ [coin]: { [currency]: price, [currency + '_24h_change']: percent } } (empty object for unknown coins)",
        example: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_24hr_change=true",
      },
    ],
    notes: `Read it like this:
const cur = (currency || "usd").toLowerCase();
const json = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(coin.toLowerCase()) + "&vs_currencies=" + cur + "&include_24hr_change=true")).json();
const p = json[coin.toLowerCase()];
If p or p[cur] is missing, say that coin or currency was not found. const price = p[cur]; const change = p[cur + "_24h_change"];
Speech: "One " + coin + " is " + price.toLocaleString("en-IN") + " " + cur.toUpperCase() + (change === undefined ? "." : ", " + change.toFixed(1) + " percent in the last 24 hours."). Never write a currency name like dollars in the code.`,
  },
  {
    id: "wikipedia",
    kind: "knowledge",
    reference: WIKIPEDIA_REFERENCE,
    name: "Wikipedia",
    useFor: "explaining anything that doesn't change from day to day: who or what something is, how it works, why, the difference between two things (people, places, history, science, technology, programming, health, law, money)",
    domains: ["en.wikipedia.org"],
    tool: {
      name: "explain_topic",
      title: "Explain from Wikipedia",
      description: "Explains a person, place, event, idea or concept from its Wikipedia article: the summary, plus the passages that answer the user's exact question. Also two topics at once, to compare them or answer a two-part question (merge sort and quicksort, OOP and API).",
      inputs: [
        { name: "topic", fromRequest: true, description: "what to explain, as a Wikipedia article name, e.g. Quicksort or Ada Lovelace", another: ["Binary search", "Taj Mahal"] },
        { name: "compare_with", fromRequest: true, description: "a second topic, when the user asks to compare two things or asks about two things at once; leave out otherwise", optional: true, another: ["Bubble sort", "Red Fort"] },
        { name: "question", wholeRequest: true, description: "the user's whole question, word for word", optional: true, another: ["What is it used for?"] },
        {
          name: "keywords",
          description: "your best guess at 2 to 5 words that appear in the part of the article that answers the question, e.g. encapsulation inheritance polymorphism abstraction for the pillars of OOP; leave out when the question only asks what or who something is",
          optional: true,
          another: ["history"],
        },
      ],
    },
    endpoints: [
      {
        url: "https://en.wikipedia.org/w/rest.php/v1/search/page?q={query}&limit=1",
        returns: "{ pages: [{ key, title, description }] }, the most relevant article first (empty pages when nothing matches)",
        example: "https://en.wikipedia.org/w/rest.php/v1/search/page?q=taj%20mahal&limit=1",
      },
      {
        url: "https://en.wikipedia.org/api/rest_v1/page/summary/{key}",
        returns: "{ title, description, extract } (extract is a few sentences of plain text)",
        example: "https://en.wikipedia.org/api/rest_v1/page/summary/Taj_Mahal",
      },
      {
        url: "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles={title}",
        returns: "{ query: { pages: { [id]: { title, extract } } } } (extract is the whole article as plain text, paragraphs separated by newlines, headings like == History ==)",
        example: "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=Taj_Mahal",
      },
    ],
    notes: `Answer with Wikipedia's own words, never your own. Use exactly this shape, which handles one topic or two:
const first = (text) => { const t = text.split(". ").slice(0, 2).join(". "); return t.endsWith(".") ? t : t + "."; };
const STOP = new Set(["what", "which", "who", "why", "how", "does", "the", "and", "for", "are", "was", "were", "with", "about", "tell", "explain", "between", "difference", "main", "from", "that", "this", "its", "into", "than"]);
const terms = (text) => (text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
// The keywords first: they name the sections that answer the question.
const want = terms((keywords || "") + " " + (question || ""));
async function lookup(t) {
  const s = await (await fetch("https://en.wikipedia.org/w/rest.php/v1/search/page?limit=1&q=" + encodeURIComponent(t))).json();
  if (!s.pages || !s.pages.length) return null;
  const sum = await (await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(s.pages[0].key))).json();
  const full = await (await fetch("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=" + encodeURIComponent(sum.title))).json();
  const text = Object.values(full.query.pages)[0].extract || "";
  const parts = [];
  let heading = "";
  for (const line of text.split(String.fromCharCode(10))) {
    const l = line.trim();
    if (l.startsWith("=")) heading = l.split("=").join("").trim().toLowerCase();
    else if (l.length > 60) parts.push({ heading, text: l });
  }
  const best = [];
  for (const w of want) {
    const under = parts.filter((x) => x.heading.includes(w));
    const hit = under.find((x) => x.text.length > 150) || under[0] || parts.slice(1).find((x) => x.text.toLowerCase().includes(w));
    if (hit && !best.includes(hit.text)) best.push(hit.text);
  }
  return { title: sum.title, lead: first(sum.extract), passages: [sum.extract, ...best.slice(0, 4)].map((p) => p.slice(0, 900)) };
}
const said = [];
const passages = [];
for (const t of [topic, compare_with].filter(Boolean)) {
  const a = await lookup(t);
  if (!a) { said.push(t + " wasn't found on Wikipedia."); continue; }
  said.push(a.lead);
  for (const p of a.passages) passages.push({ topic: a.title, text: p });
}
return { speech: said.join(" "), data: { topic, compare_with, passages } };`,
  },
  {
    id: "news",
    reference: NEWS_REFERENCE,
    name: "Google News",
    useFor: "today's top headlines, or the latest news about any person, company, product, event or topic (what happened, what was launched or announced)",
    domains: ["news.google.com"],
    tool: {
      name: "get_news",
      title: "Latest News",
      description: "Today's top headlines, or the latest news on a topic: a person, company, product, launch, event or place. Use for what happened recently or the latest news about something.",
      inputs: [
        {
          name: "topic",
          fromRequest: true,
          generic: true,
          optional: true,
          description: "the news topic in a few keywords, e.g. rocket launch or India cricket; leave out for today's top headlines",
          another: ["India cricket", "Mars rover"],
        },
      ],
    },
    endpoints: [
      {
        url: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
        returns: "RSS XML of today's top stories: <item><title>Headline - Publisher</title><link>…</link><pubDate>…</pubDate>…</item>",
        example: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
      },
      {
        url: "https://news.google.com/rss/search?q={query}+when:7d&hl=en-IN&gl=IN&ceid=IN:en",
        returns: "the same RSS shape, newest stories on the topic first",
        example: "https://news.google.com/rss/search?q=elon+musk+car+when:7d&hl=en-IN&gl=IN&ceid=IN:en",
      },
    ],
    notes: `The response is XML (RSS), not JSON. Read it exactly like this (no regular expressions needed):
const url = topic
  ? "https://news.google.com/rss/search?q=" + topic.trim().split(" ").filter(Boolean).map(encodeURIComponent).join("+") + "+when:7d&hl=en-IN&gl=IN&ceid=IN:en"
  : "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en";
const xml = await (await fetch(url)).text();
const titles = xml.split("<item>").slice(1, 4).map((it) => it.split("<title>")[1].split("</title>")[0].split("&amp;").join("and"));
If titles is empty, say no suitable recent news was found. Each title already ends with " - Publisher".
Speech: (topic ? "Latest news on " + topic : "Today's top headlines") + ": " + titles.join("; ") + "." data: { topic: topic || "top headlines", titles }.`,
  },
  {
    id: "hacker_news",
    name: "Hacker News",
    useFor: "top tech news stories, what's trending on Hacker News",
    domains: ["hacker-news.firebaseio.com"],
    tool: { name: "get_top_tech_news", title: "Top Tech Stories", description: "The top stories on Hacker News right now: what's trending in tech.", inputs: [] },
    endpoints: [
      {
        url: "https://hacker-news.firebaseio.com/v0/topstories.json",
        returns: "array of story ids, best first",
        example: "https://hacker-news.firebaseio.com/v0/topstories.json",
      },
      {
        url: "https://hacker-news.firebaseio.com/v0/item/{id}.json",
        returns: "{ title, score, by, url }",
        example: "https://hacker-news.firebaseio.com/v0/item/8863.json",
      },
    ],
    notes: `No input needed. Read it like this:
const ids = (await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json()).slice(0, 3);
const items = await Promise.all(ids.map(async (id) => (await fetch("https://hacker-news.firebaseio.com/v0/item/" + id + ".json")).json()));
Speech: "The top stories on Hacker News right now: " + items.map((it) => it.title).join("; ") + "." data: { titles: items.map((it) => it.title) }.`,
  },
  {
    id: "dictionary",
    kind: "knowledge",
    name: "the Free Dictionary",
    useFor: "meaning or definition of an English word",
    domains: ["api.dictionaryapi.dev"],
    tool: {
      name: "define_word",
      title: "Define a Word",
      description: "The meaning of an English word, with its part of speech.",
      inputs: [{ name: "word", fromRequest: true, description: "the English word, e.g. serendipity", another: ["ephemeral", "resilient"] }],
    },
    endpoints: [
      {
        url: "https://api.dictionaryapi.dev/api/v2/entries/en/{word}",
        returns: "[{ word, meanings: [{ partOfSpeech, definitions: [{ definition, example? }] }] }]; HTTP 404 when the word is unknown",
        example: "https://api.dictionaryapi.dev/api/v2/entries/en/serendipity",
      },
    ],
    notes: `Read it like this:
const res = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word.toLowerCase()));
If res.status === 404, say that word wasn't found in the dictionary.
const m = (await res.json())[0].meanings[0];
Speech: word + " (" + m.partOfSpeech + ") means: " + m.definitions[0].definition. data: { word, part_of_speech: m.partOfSpeech }.`,
  },
  {
    id: "launches",
    reference: LAUNCH_REFERENCE,
    name: "The Space Devs",
    useFor: "upcoming rocket launches, next space launch, from any agency or a named one (NASA, ISRO, SpaceX)",
    domains: ["ll.thespacedevs.com"],
    tool: {
      name: "get_next_launch",
      title: "Next Rocket Launch",
      description: "When the next rocket launch is: any launch, or one by a named agency, company, rocket or mission (NASA, ISRO, SpaceX, Artemis).",
      inputs: [{ name: "agency", fromRequest: true, description: "the agency, company, rocket or mission asked about, e.g. NASA or ISRO; leave out for any launch", optional: true, another: ["ISRO", "Rocket Lab"] }],
    },
    endpoints: [
      {
        url: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=3&mode=list&search={agency}",
        returns: "{ results: [{ name, net (ISO launch time, UTC), status: { name }, lsp_name, location }] }",
        example: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=1&mode=list&search=NASA",
      },
    ],
    notes: `Rate limited to 15 calls/hour. Build the URL like this, so the search is added only when an agency was given:
const url = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=3&mode=list" + (agency ? "&search=" + encodeURIComponent(agency) : "");
If results is empty, say no upcoming launch was found. Speech: the first result's name, who launches it (lsp_name), and the time in words, e.g. new Date(r.net).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " India time". data: { launch: r.name, provider: r.lsp_name, time: r.net, status: r.status.name, location: r.location }.`,
  },
  {
    id: "earthquakes",
    reference: EARTHQUAKE_REFERENCE,
    name: "the US Geological Survey",
    useFor: "recent earthquakes around the world",
    domains: ["earthquake.usgs.gov"],
    tool: {
      name: "get_recent_earthquakes",
      title: "Recent Earthquakes",
      description: "The biggest earthquakes worldwide in the last day (magnitude 4.5 and up), with where they struck. It can't filter by country or city.",
      inputs: [],
    },
    endpoints: [
      {
        url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
        returns: "{ features: [{ properties: { mag, place, time (ms since epoch) } }] } (magnitude 4.5+ in the last day, newest first)",
        example: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      },
    ],
    notes: `No input needed. Read it like this:
const quakes = (await (await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson")).json()).features.slice(0, 3);
If quakes is empty, say there were no earthquakes of magnitude 4.5 or more in the last day.
Speech: "In the last day, the biggest recent earthquakes were: " + quakes.map((q) => "magnitude " + q.properties.mag.toFixed(1) + " " + q.properties.place).join("; ") + ". Never add a place that isn't in properties.place. data: { count: quakes.length }.`,
  },
  {
    id: "holidays",
    name: "Nager.Date",
    useFor: "upcoming public holidays in a country (not available for India)",
    domains: ["date.nager.at"],
    tool: {
      name: "get_public_holidays",
      title: "Public Holidays",
      description: "The next public holidays in a country (not India).",
      inputs: [{ name: "country_code", description: "2-letter ISO country code, e.g. US, GB, DE, JP", another: ["GB", "DE"] }],
    },
    endpoints: [
      {
        url: "https://date.nager.at/api/v3/NextPublicHolidays/{countryCode}",
        returns: "[{ date (YYYY-MM-DD), localName, name }] (empty response for unsupported countries)",
        example: "https://date.nager.at/api/v3/NextPublicHolidays/US",
      },
    ],
    notes: `countryCode is a 2-letter ISO code: US, GB, DE, FR, JP. Read it like this:
const res = await fetch("https://date.nager.at/api/v3/NextPublicHolidays/" + encodeURIComponent(country_code.toUpperCase()));
const text = res.status === 200 ? await res.text() : "";
const days = text ? JSON.parse(text).slice(0, 2) : [];
If days is empty, say public holidays for that country aren't available. Speech: "The next public holidays in " + country_code.toUpperCase() + " are " + days.map((d) => d.name + " on " + new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "long" })).join(" and ") + ".".`,
  },
  {
    id: "wikidata",
    kind: "fact",
    reference: WIKIDATA_REFERENCE,
    name: "Wikidata",
    useFor: "one exact fact about a place, person, organisation or thing: population, capital, area, height or elevation, length, founding date, birth or death date, currency, official language, head of state or government, author, director, inventor",
    domains: ["www.wikidata.org", "query.wikidata.org"],
    tool: {
      name: "get_fact",
      title: "Look Up a Fact",
      description: "One exact fact from Wikidata about a place, person, organisation or thing: population, capital, area, elevation, height, length, when it was founded, when someone was born or died, currency, language, head of state or government, author, director, inventor.",
      inputs: [
        { name: "entity", fromRequest: true, description: "the place, person, organisation or thing, by its name, e.g. Japan or ISRO", another: ["India", "France"] },
        {
          name: "property",
          description: "exactly one of: population, capital, area, elevation, height, length, founded, born, died, currency, language, head of state, head of government, country, author, director, inventor, highest point",
          another: ["capital", "population"],
        },
      ],
    },
    endpoints: [
      {
        url: "https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&limit=1&search={entity}",
        returns: "{ search: [{ id: 'Q17', label, description }] } (empty search when nothing matches)",
        example: "https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&limit=1&search=Japan",
      },
      {
        url: "https://query.wikidata.org/sparql?format=json&query={sparql}",
        returns: "{ results: { bindings: [{ v: { value }, vLabel: { value } }] } } (vLabel is the value in words: a name, a number, or a date like 1969-08-15T00:00:00Z)",
        example: "https://query.wikidata.org/sparql?format=json&query=SELECT%20%3Fv%20%3FvLabel%20WHERE%20%7B%20wd%3AQ17%20wdt%3AP36%20%3Fv%20.%20SERVICE%20wikibase%3Alabel%20%7B%20bd%3AserviceParam%20wikibase%3Alanguage%20%27en%27.%20%7D%20%7D",
      },
    ],
    notes: `Use exactly this shape:
const PROPS = ${WIKIDATA_PROPS};
const UNITS = { area: " square kilometres", elevation: " metres", height: " metres" };
const pid = PROPS[property.toLowerCase().trim()];
If !pid, say you can look up population, capital, area, height, founding, birth and death dates, currency, language and leaders.
const s = await (await fetch("https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&limit=1&search=" + encodeURIComponent(entity))).json();
If !s.search.length, say entity wasn't found on Wikidata. const name = s.search[0].label;
const q = "SELECT ?v ?vLabel WHERE { wd:" + s.search[0].id + " wdt:" + pid + " ?v . SERVICE wikibase:label { bd:serviceParam wikibase:language 'en'. } }";
const r = await (await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q))).json();
const values = r.results.bindings.map((b) => b.vLabel.value);
If values is empty, say Wikidata has no property for name.
const nice = (v) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(v) ? new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : /^-?[0-9]+([.][0-9]+)?$/.test(v) ? Number(v).toLocaleString("en-IN") + (UNITS[property] || "") : v;
const value = values.slice(0, 3).map(nice).join(", ");
const p = property.toLowerCase().trim();
const speech = p === "founded" ? name + " was founded on " + value + "." : p === "born" ? name + " was born on " + value + "." : p === "died" ? name + " died on " + value + "." : "The " + p + " of " + name + " is " + value + ".";
return { speech, data: { entity: name, property: p } };`,
  },
  {
    id: "calculator",
    kind: "calculation",
    reference: CALCULATOR_REFERENCE,
    name: "Forge's calculator",
    useFor: "arithmetic and percentages: sums, products, percent of a number, percent change, powers and square roots (no website needed)",
    domains: [],
    tool: {
      name: "calculate",
      title: "Calculator",
      description: "Works out arithmetic and percentages: sums, products, percent of a number, percent change, powers, square roots.",
      inputs: [
        {
          name: "expression",
          description: "the calculation as a plain expression using only numbers and + - * / ^ ( ) % and sqrt(), e.g. 18%*2500 for 18% of 2500, (1500-1200)/1200*100 for the percent change from 1200 to 1500, sqrt(144)",
          another: ["(3+4)*2", "2^10"],
        },
      ],
    },
    endpoints: [],
    notes: `No website: never call fetch. Use exactly this shape (a small parser; eval is not allowed):
const src = String(expression).split(" ").join("").split("×").join("*").split("÷").join("/");
let i = 0;
const peek = () => src[i];
const post = (v) => { if (peek() === "%") { i++; return v / 100; } return v; };
function factor() {
  if (peek() === "-") { i++; return -factor(); }
  if (peek() === "(") { i++; const v = expr(); i++; return post(v); }
  if (src.startsWith("sqrt(", i)) { i += 5; const v = expr(); i++; return post(Math.sqrt(v)); }
  let j = i;
  while (j < src.length && "0123456789.".includes(src[j])) j++;
  if (j === i) throw new Error("I couldn't read the calculation at: " + src.slice(i));
  const n = parseFloat(src.slice(i, j));
  i = j;
  return post(n);
}
function power() { const b = factor(); if (peek() === "^") { i++; return Math.pow(b, power()); } return b; }
function term() { let v = power(); while (peek() === "*" || peek() === "/") { const op = src[i++]; const r = power(); v = op === "*" ? v * r : v / r; } return v; }
function expr() { let v = term(); while (peek() === "+" || peek() === "-") { const op = src[i++]; const r = term(); v = op === "+" ? v + r : v - r; } return v; }
const value = expr();
If i < src.length or !Number.isFinite(value), say you couldn't work that out and to say it as a plain sum.
const shown = value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
return { speech: "The answer is " + shown + ".", data: { expression: src, result: value } };`,
  },
  {
    id: "units",
    kind: "calculation",
    reference: UNITS_REFERENCE,
    name: "Forge's unit converter",
    useFor: "converting units: length, weight, volume, speed, area, data size, temperature (no website needed)",
    domains: [],
    tool: {
      name: "convert_units",
      title: "Unit Converter",
      description: "Converts length, weight, volume, speed, area, data size and temperature between units (km and miles, kg and pounds, Celsius and Fahrenheit…). Not for money.",
      inputs: [
        { name: "value", type: "number", description: "the amount to convert", another: [] },
        {
          name: "from_unit",
          description: "unit code, exactly one of: m km cm mm mi yd ft in kg g mg lb oz t l ml gal cup kmh mph ms kn m2 km2 ha acre ft2 b kb mb gb tb c f k (c, f, k are Celsius, Fahrenheit, Kelvin)",
          another: ["kg", "c"],
        },
        { name: "to_unit", description: "unit code to convert to, from the same list", another: ["lb", "f"] },
      ],
    },
    endpoints: [],
    notes: `No website: never call fetch. Use exactly this shape:
const U = { m: [1, 1, "metres"], km: [1, 1000, "kilometres"], cm: [1, 0.01, "centimetres"], mm: [1, 0.001, "millimetres"], mi: [1, 1609.344, "miles"], yd: [1, 0.9144, "yards"], ft: [1, 0.3048, "feet"], in: [1, 0.0254, "inches"],
  kg: [2, 1, "kilograms"], g: [2, 0.001, "grams"], mg: [2, 0.000001, "milligrams"], lb: [2, 0.45359237, "pounds"], oz: [2, 0.028349523125, "ounces"], t: [2, 1000, "tonnes"],
  l: [3, 1, "litres"], ml: [3, 0.001, "millilitres"], gal: [3, 3.785411784, "US gallons"], cup: [3, 0.2365882365, "cups"],
  kmh: [4, 1, "kilometres per hour"], mph: [4, 1.609344, "miles per hour"], ms: [4, 3.6, "metres per second"], kn: [4, 1.852, "knots"],
  m2: [5, 1, "square metres"], km2: [5, 1000000, "square kilometres"], ha: [5, 10000, "hectares"], acre: [5, 4046.8564224, "acres"], ft2: [5, 0.09290304, "square feet"],
  b: [6, 1, "bytes"], kb: [6, 1000, "kilobytes"], mb: [6, 1000000, "megabytes"], gb: [6, 1000000000, "gigabytes"], tb: [6, 1000000000000, "terabytes"] };
const T = { c: "degrees Celsius", f: "degrees Fahrenheit", k: "kelvin" };
const from = from_unit.toLowerCase(); const to = to_unit.toLowerCase();
let result;
if (T[from] && T[to]) { const k = from === "c" ? value + 273.15 : from === "f" ? (value - 32) * 5 / 9 + 273.15 : value; result = to === "c" ? k - 273.15 : to === "f" ? (k - 273.15) * 9 / 5 + 32 : k; }
else if (U[from] && U[to] && U[from][0] === U[to][0]) result = value * U[from][1] / U[to][1];
else say those two units can't be converted into each other.
const name = (u) => (T[u] || U[u][2]);
return { speech: value.toLocaleString("en-IN") + " " + name(from) + " is " + result.toLocaleString("en-IN", { maximumFractionDigits: 2 }) + " " + name(to) + ".", data: { result } };`,
  },
  {
    id: "dates",
    kind: "calculation",
    reference: DATES_REFERENCE,
    name: "Forge's calendar",
    useFor: "how many days until or since a date the user names (no website needed)",
    domains: [],
    tool: {
      name: "days_until",
      title: "Days Until a Date",
      description: "How many days there are until a date, or how many days ago it was. The date must be given as a calendar date.",
      inputs: [
        { name: "date", description: "the date as YYYY-MM-DD; for a date without a year, the next time it comes", another: ["2027-01-01", "2026-12-25"] },
      ],
    },
    endpoints: [],
    notes: `No website: never call fetch. Count from today's date in India. Use exactly this shape:
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const days = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
If days is not a number, say you need the date as a day, month and year.
const when = new Date(date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const speech = days > 0 ? "There are " + days + " days until " + when + "." : days === 0 ? when + " is today." : when + " was " + -days + " days ago.";
return { speech, data: { days } };`,
  },
  {
    id: "world_clock",
    kind: "calculation",
    reference: CLOCK_REFERENCE,
    name: "Forge's world clock",
    useFor: "what time it is right now in a city or country",
    domains: ["geocoding-api.open-meteo.com"],
    tool: {
      name: "time_in",
      title: "World Clock",
      description: "What time and day it is right now in any city.",
      inputs: [{ name: "city", fromRequest: true, description: "the city, e.g. New York", another: ["Tokyo", "London"] }],
    },
    endpoints: [
      {
        url: "https://geocoding-api.open-meteo.com/v1/search?count=1&name={city}",
        returns: "{ results?: [{ name, country, timezone }] } (timezone like America/New_York)",
        example: "https://geocoding-api.open-meteo.com/v1/search?count=1&name=New%20York",
      },
    ],
    notes: `Use exactly this shape:
const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city))).json();
If !g.results, say that city wasn't found. const place = g.results[0];
const now = new Date();
const time = now.toLocaleTimeString("en-IN", { timeZone: place.timezone, hour: "numeric", minute: "2-digit" });
const day = now.toLocaleDateString("en-IN", { timeZone: place.timezone, weekday: "long", day: "numeric", month: "long" });
return { speech: "It's " + time + " on " + day + " in " + place.name + ".", data: { timezone: place.timezone } };`,
  },
];

export const catalogById = new Map(CATALOG.map((s) => [s.id, s]));

// "today's hot news", "latest headlines": no topic, so the source's default (top stories).
const GENERIC = new Set(["hot", "latest", "today", "todays", "top", "news", "headline", "headlines", "breaking", "current", "trending", "big", "main", "recent", "new", "happening", "stories", "story", "updates", "update", "the", "s", "what", "whats", "is", "are", "of", "in", "now", "right", "any", "some"]);
export const isGeneric = (v: string) => v.toLowerCase().split(/[^a-z]+/).filter(Boolean).every((w) => GENERIC.has(w));

/** Inputs of the sources' general skills where generic words mean "leave it out", by skill name. */
export const genericInputs = new Map(CATALOG.flatMap((s) => (s.tool ? [[s.tool.name, s.tool.inputs.filter((i) => i.generic).map((i) => i.name)] as const] : [])));
