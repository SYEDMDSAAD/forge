// The headline cross-check: a news skill passes only if its answer quotes a
// headline from the feed it read, even when its topic is fixed in the code.
//   npx tsx scripts/news-check.ts
import { catalogById } from "../src/forge/catalog.js";
import { runInSandbox, shutdownSandbox } from "../src/sandbox/sandbox.js";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const reference = catalogById.get("news")!.reference!;
const feed = JSON.stringify("https://news.google.com/rss/search?q=india+when:7d&hl=en-IN&gl=IN&ceid=IN:en");

async function test(code: string, input: Record<string, unknown> = {}) {
  const out = await runInSandbox({ mode: "test", code, allowedDomains: ["news.google.com"], tests: [{ name: "t", input, assert: "true", reference }] });
  return (out as { results?: { passed: boolean; error?: string }[] }).results?.[0];
}

try {
  const honest = await test(`export default async function run() {
  const xml = await (await fetch(${feed})).text();
  const titles = xml.split("<item>").slice(1, 3).map((it) => it.split("<title>")[1].split("</title>")[0]);
  return { speech: "Latest news on India: " + titles.join("; ") + "." };
}`);
  check(honest?.passed === true, "a skill that says the feed's headlines passes");

  const madeUp = await test(`export default async function run() {
  await fetch(${feed});
  return { speech: "India has had a very busy week of news, with many important stories." };
}`);
  check(madeUp?.passed === false && /quotes none of the headlines/.test(madeUp.error ?? ""), "a skill that reads the feed but makes up its answer is rejected");

  const noFeed = await test(`export default async function run() {
  return { speech: "India has had a very busy week of news, with many important stories." };
}`);
  check(noFeed?.passed === false && /never read the news feed/.test(noFeed.error ?? ""), "a skill that never reads the feed is rejected");

  const fixedTopic = await test(`export default async function run({ topic }) {
  const xml = await (await fetch(${feed})).text();
  const titles = xml.split("<item>").slice(1, 3).map((it) => it.split("<title>")[1].split("</title>")[0]);
  return { speech: "Latest news on " + topic + ": " + titles.join("; ") + "." };
}`, { topic: "rocket launch" });
  check(fixedTopic?.passed === false && /instead of its topic/.test(fixedTopic.error ?? ""), "a skill that ignores its topic and reads a fixed feed is rejected");
} finally {
  shutdownSandbox();
}
process.exit(failed ? 1 : 0);
