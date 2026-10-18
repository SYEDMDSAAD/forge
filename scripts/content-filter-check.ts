// Headlines are read aloud: explicit and spam stories are dropped from feeds,
// real news stays, and "today's hot news" means top headlines, not a search for "hot".
//   npx tsx scripts/content-filter-check.ts
import { isGeneric } from "../src/forge/catalog.js";
import { filterFeed, unsuitable } from "../src/sandbox/content-filter.js";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const spam = [
  "Mms Viral Video News Treanding HOT Pics and Videos NEW XXX Viral - Universidad de Córdoba (UCO)",
  "Desi bhabhi leaked video goes viral - SomeSite",
  "Actress hot photos set the internet on fire - Gossip",
];
const news = [
  "Fighting in Yemen intensifies: What's the latest on the battlefield? - Al Jazeera",
  "First Light News: Hot US CPI Revives Fed Hike Bets as Stocks and Gold Slip - FXEmpire",
  "Delhi sizzles as hot weather continues; IMD issues alert - The Hindu",
  "Court hears sexual harassment case against former official - Indian Express",
];
for (const t of spam) check(unsuitable(t), `dropped: ${t.slice(0, 60)}`);
for (const t of news) check(!unsuitable(t), `kept: ${t.slice(0, 60)}`);

const feed = `<?xml version="1.0"?><rss><channel><title>Top stories</title>${[spam[0], news[0], news[1]].map((t) => `<item><title>${t.replace(/&/g, "&amp;")}</title><link>x</link></item>`).join("")}</channel></rss>`;
const out = filterFeed(feed);
check(!/XXX/.test(out) && out.includes("Yemen") && out.includes("CPI") && out.split("<item>").length === 3, "a feed loses only its spam story");

for (const v of ["hot news", "today's hot news", "latest headlines", "top stories today", "what's happening"]) check(isGeneric(v), `"${v}" means top headlines`);
for (const v of ["ISRO", "India cricket", "Elon Musk car", "hot weather Delhi"]) check(!isGeneric(v), `"${v}" is a real topic`);
process.exit(failed ? 1 : 0);
