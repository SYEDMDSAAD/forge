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
    inputs: { name: string; type?: "number"; description: string; optional?: boolean; another: string[] }[];
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
  let urls = fetched.filter((u) => u.includes("/page/summary/"));
  if (!urls.length) {
    const topics = Object.values(input).filter((v) => typeof v === "string" && v.trim());
    if (!topics.length) throw new Error("Cross-check failed: the skill never read a Wikipedia summary, so its answer can't come from Wikipedia.");
    for (const t of topics) {
      const s = await (await fetch("https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=" + encodeURIComponent(t))).json();
      if (s.pages?.[0]) urls.push("https://en.wikipedia.org/api/rest_v1/page/summary/" + s.pages[0].key);
    }
  }
  const out = [];
  for (const u of urls) out.push((await (await fetch(u)).json()).extract ?? "");
  return out.filter((t) => t.length >= 12);
}`,
};

export const CATALOG: Source[] = [
  {
    id: "weather",
    reference: WEATHER_REFERENCE,
    name: "Open-Meteo",
    useFor: "current weather, temperature, rain chance, wind, multi-day forecast, sunrise/sunset for a city",
    domains: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
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
    notes: "First geocode the city name, then call forecast with its latitude/longitude. weather_code: 0 clear, 1-3 partly cloudy, 45-48 fog, 51-57 drizzle, 61-67 rain, 71-77 snow, 80-82 showers, 95-99 thunderstorm.",
  },
  {
    id: "air_quality",
    reference: AIR_QUALITY_REFERENCE,
    name: "Open-Meteo",
    useFor: "air quality index (AQI), pollution, PM2.5, PM10 for a city",
    domains: ["geocoding-api.open-meteo.com", "air-quality-api.open-meteo.com"],
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
    notes: "US AQI bands: 0-50 good, 51-100 moderate, 101-150 unhealthy for sensitive groups, 151-200 unhealthy, 201-300 very unhealthy, 301+ hazardous. Phrase it like `The air quality in Delhi is unhealthy, with an AQI of 165.`",
  },
  {
    id: "iss",
    reference: ISS_REFERENCE,
    name: "Where the ISS at and OpenStreetMap",
    useFor: "where the International Space Station is right now, its speed and altitude, which country it is over",
    domains: ["api.wheretheiss.at", "nominatim.openstreetmap.org"],
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
    notes: "No input needed. Over the ocean there is no country: say it's over the ocean.",
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
        { name: "to_currency", description: "3-letter code of the currency converted to, e.g. INR", another: ["JPY", "AED"] },
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
        { name: "coin", description: "the coin's full name in lowercase, e.g. bitcoin, ethereum, solana, dogecoin", another: ["ethereum", "solana"] },
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
    notes: 'coin ids are lowercase full names: bitcoin, ethereum, solana, dogecoin. currency is lowercase: inr, usd; use const cur = (currency || "usd").toLowerCase(). If json[coin] is missing, say that coin was not found. Speech: "One " + coin + " is " + price.toLocaleString("en-IN") + " " + cur.toUpperCase() + ", " + change + " percent in the last 24 hours." (never write a currency name like dollars in the code).',
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
      description: "Explains a person, place, event, idea or concept from its Wikipedia summary, or compares two of them (merge sort and quicksort, Delhi and Mumbai).",
      inputs: [
        { name: "topic", description: "what to explain, as a Wikipedia article name, e.g. Quicksort or Ada Lovelace", another: ["Binary search", "Taj Mahal"] },
        { name: "compare_with", description: "a second topic, only when the user asks to compare or for a difference; leave out otherwise", optional: true, another: ["Bubble sort", "Red Fort"] },
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
    notes: `Search first to get the page key, then fetch the summary. Do this for topic, and for compare_with when it is given. The answer must be Wikipedia's own words, never your own:
const first = (text) => text.split(". ").slice(0, 2).join(". ").replace(/\\.?$/, ".");
Speech: first(extract) for topic, then first(extract) for compare_with if given, joined with a space. If a search finds no page, say that topic wasn't found on Wikipedia.`,
  },
  {
    id: "news",
    reference: NEWS_REFERENCE,
    name: "Google News",
    useFor: "latest news headlines about any person, company, product, event or topic (what happened, what was launched or announced, recent news); the topic is the tool's input",
    domains: ["news.google.com"],
    tool: {
      name: "get_news",
      title: "Latest News",
      description: "Latest news headlines on any topic: a person, company, product, launch, event or place. Use for what happened recently or the latest news about something.",
      inputs: [{ name: "topic", description: "the news topic in a few keywords, e.g. rocket launch or India cricket", another: ["India cricket", "Mars rover"] }],
    },
    endpoints: [
      {
        url: "https://news.google.com/rss/search?q={query}+when:7d&hl=en-IN&gl=IN&ceid=IN:en",
        returns: "RSS XML, newest stories first: <item><title>Headline - Publisher</title><link>…</link><pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate>…</item>",
        example: "https://news.google.com/rss/search?q=elon+musk+car+when:7d&hl=en-IN&gl=IN&ceid=IN:en",
      },
    ],
    notes: `The response is XML (RSS), not JSON. Read it exactly like this (no regular expressions needed):
const xml = await res.text();
const titles = xml.split("<item>").slice(1, 4).map((it) => it.split("<title>")[1].split("</title>")[0].split("&amp;").join("and"));
If titles is empty, say no recent news was found. Each title already ends with " - Publisher". query: the topic's keywords, each passed through encodeURIComponent, joined with "+". Speech: "Latest news on <topic>: " + titles.join("; ") + "."`,
  },
  {
    id: "hacker_news",
    name: "Hacker News",
    useFor: "top tech news stories, what's trending on Hacker News",
    domains: ["hacker-news.firebaseio.com"],
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
    notes: "Fetch only the first 3 ids' items, in parallel with Promise.all.",
  },
  {
    id: "dictionary",
    name: "the Free Dictionary",
    useFor: "meaning or definition of an English word",
    domains: ["api.dictionaryapi.dev"],
    endpoints: [
      {
        url: "https://api.dictionaryapi.dev/api/v2/entries/en/{word}",
        returns: "[{ word, meanings: [{ partOfSpeech, definitions: [{ definition, example? }] }] }]; HTTP 404 when the word is unknown",
        example: "https://api.dictionaryapi.dev/api/v2/entries/en/serendipity",
      },
    ],
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
      inputs: [{ name: "agency", description: "the agency, company, rocket or mission asked about, e.g. NASA or ISRO; leave out for any launch", optional: true, another: ["ISRO", "Rocket Lab"] }],
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
    name: "the US Geological Survey",
    useFor: "recent earthquakes around the world",
    domains: ["earthquake.usgs.gov"],
    endpoints: [
      {
        url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
        returns: "{ features: [{ properties: { mag, place, time (ms since epoch) } }] } (magnitude 4.5+ in the last day, newest first)",
        example: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      },
    ],
  },
  {
    id: "holidays",
    name: "Nager.Date",
    useFor: "upcoming public holidays in a country (not available for India)",
    domains: ["date.nager.at"],
    endpoints: [
      {
        url: "https://date.nager.at/api/v3/NextPublicHolidays/{countryCode}",
        returns: "[{ date (YYYY-MM-DD), localName, name }] (empty response for unsupported countries)",
        example: "https://date.nager.at/api/v3/NextPublicHolidays/US",
      },
    ],
    notes: "countryCode is a 2-letter ISO code: US, GB, DE, FR, JP. Check res.status === 200 and the body is non-empty before res.json().",
  },
];

export const catalogById = new Map(CATALOG.map((s) => [s.id, s]));
