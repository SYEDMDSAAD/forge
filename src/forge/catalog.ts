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
  useFor: string;
  domains: string[];
  endpoints: Endpoint[];
  notes?: string;
}

export const CATALOG: Source[] = [
  {
    id: "weather",
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
    notes: "US AQI bands: 0-50 good, 51-100 moderate, 101-150 unhealthy for sensitive groups, 151-200 unhealthy, 201-300 very unhealthy, 301+ hazardous.",
  },
  {
    id: "iss",
    useFor: "where the International Space Station is right now, its speed and altitude, which country it is over",
    domains: ["api.wheretheiss.at", "nominatim.openstreetmap.org"],
    endpoints: [
      {
        url: "https://api.wheretheiss.at/v1/satellites/25544",
        returns: "{ latitude, longitude, altitude (km), velocity (km/h), visibility }",
        example: "https://api.wheretheiss.at/v1/satellites/25544",
      },
      {
        url: "https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&zoom=3",
        returns: "{ address?: { country } } or { error: 'Unable to geocode' } when over the ocean",
        example: "https://nominatim.openstreetmap.org/reverse?lat=18.5&lon=73.8&format=json&zoom=3",
      },
    ],
    notes: "No input needed. Over the ocean there is no country: say it's over the ocean.",
  },
  {
    id: "currency",
    useFor: "convert money between currencies, exchange rates (USD, INR, EUR, GBP, JPY...)",
    domains: ["api.frankfurter.dev"],
    endpoints: [
      {
        url: "https://api.frankfurter.dev/v1/latest?base={FROM}&symbols={TO}&amount={amount}",
        returns: "{ amount, base, date, rates: { [TO]: convertedAmount } }",
        example: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR&amount=100",
      },
    ],
    notes: "Currency codes are 3 uppercase letters (USD, INR, EUR). rates[TO] is already multiplied by amount.",
  },
  {
    id: "crypto",
    useFor: "cryptocurrency prices (bitcoin, ethereum, solana, dogecoin) and 24h change",
    domains: ["api.coingecko.com"],
    endpoints: [
      {
        url: "https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies={currency}&include_24hr_change=true",
        returns: "{ [coin]: { [currency]: price, [currency + '_24h_change']: percent } } (empty object for unknown coins)",
        example: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_24hr_change=true",
      },
    ],
    notes: "coin ids are lowercase full names: bitcoin, ethereum, solana, dogecoin. currency is lowercase: inr, usd.",
  },
  {
    id: "wikipedia",
    useFor: "who/what is something, short facts or a summary about a person, place, thing or topic",
    domains: ["en.wikipedia.org"],
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
    notes: "Search first to get the page key, then fetch the summary. Speak only the first one or two sentences of extract.",
  },
  {
    id: "hacker_news",
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
    useFor: "upcoming rocket launches, next space launch",
    domains: ["ll.thespacedevs.com"],
    endpoints: [
      {
        url: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=3&mode=list",
        returns: "{ results: [{ name, net (ISO launch time, UTC), status: { name }, lsp_name, location }] }",
        example: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=1&mode=list",
      },
    ],
    notes: "Rate limited to 15 calls/hour. Say the launch time in words, e.g. with toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).",
  },
  {
    id: "earthquakes",
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
