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

export interface Source {
  id: string;
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
    inputs: { name: string; type?: "number"; description: string; optional?: boolean; fromRequest?: boolean; generic?: boolean; another: string[] }[];
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
  const topics = Object.values(input).filter((v) => typeof v === "string" && v.trim());
  let urls = [];
  for (const t of topics) {
    const s = await (await fetch("https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=" + encodeURIComponent(t))).json();
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
    useFor: "convert money between currencies, exchange rates (USD, INR, EUR, GBP, JPY...)",
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
    reference: WIKIPEDIA_REFERENCE,
    name: "Wikipedia",
    useFor: "who or what something is, or the difference between two things: a summary of a person, place, event, idea or concept (science, history, technology, algorithms)",
    domains: ["en.wikipedia.org"],
    tool: {
      name: "explain_topic",
      title: "Explain from Wikipedia",
      description: "Explains a person, place, event, idea or concept from its Wikipedia summary, or two of them at once, to compare them or answer a two-part question (merge sort and quicksort, OOP and API).",
      inputs: [
        { name: "topic", fromRequest: true, description: "what to explain, as a Wikipedia article name, e.g. Quicksort or Ada Lovelace", another: ["Binary search", "Taj Mahal"] },
        { name: "compare_with", fromRequest: true, description: "a second topic, when the user asks to compare two things or asks about two things at once; leave out otherwise", optional: true, another: ["Bubble sort", "Red Fort"] },
      ],
    },
    endpoints: [
      {
        url: "https://en.wikipedia.org/w/rest.php/v1/search/title?q={query}&limit=1",
        returns: "{ pages: [{ key, title, description }] } (empty pages when nothing matches)",
        example: "https://en.wikipedia.org/w/rest.php/v1/search/title?q=taj%20mahal&limit=1",
      },
      {
        url: "https://en.wikipedia.org/api/rest_v1/page/summary/{key}",
        returns: "{ title, description, extract } (extract is a few sentences of plain text)",
        example: "https://en.wikipedia.org/api/rest_v1/page/summary/Taj_Mahal",
      },
    ],
    notes: `Answer with Wikipedia's own words, never your own. Use this shape, which handles one topic or two:
const first = (text) => text.split(". ").slice(0, 2).join(". ").replace(/\\.?$/, ".");
async function summary(t) {
  const s = await (await fetch("https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=" + encodeURIComponent(t))).json();
  if (!s.pages || !s.pages.length) return t + " wasn't found on Wikipedia.";
  const p = await (await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(s.pages[0].key))).json();
  return first(p.extract);
}
const parts = [];
for (const t of [topic, compare_with].filter(Boolean)) parts.push(await summary(t));
Speech: parts.join(" "). data: { topic, compare_with }.`,
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
  ? "https://news.google.com/rss/search?q=" + topic.trim().split(/\\s+/).map(encodeURIComponent).join("+") + "+when:7d&hl=en-IN&gl=IN&ceid=IN:en"
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
];

export const catalogById = new Map(CATALOG.map((s) => [s.id, s]));

// "today's hot news", "latest headlines": no topic, so the source's default (top stories).
const GENERIC = new Set(["hot", "latest", "today", "todays", "top", "news", "headline", "headlines", "breaking", "current", "trending", "big", "main", "recent", "new", "happening", "stories", "story", "updates", "update", "the", "s", "what", "whats", "is", "are", "of", "in", "now", "right", "any", "some"]);
export const isGeneric = (v: string) => v.toLowerCase().split(/[^a-z]+/).filter(Boolean).every((w) => GENERIC.has(w));

/** Inputs of the sources' general skills where generic words mean "leave it out", by skill name. */
export const genericInputs = new Map(CATALOG.flatMap((s) => (s.tool ? [[s.tool.name, s.tool.inputs.filter((i) => i.generic).map((i) => i.name)] as const] : [])));
