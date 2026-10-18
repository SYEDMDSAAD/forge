// Headlines are read aloud, possibly with children in the room, so explicit and
// clickbait-spam stories are dropped from news feeds before any skill (or its
// cross-check) sees them. Real news stays, war, crime and disasters included:
// this removes sexual and spam content, not topics.
// Applied by the relay (src/sandbox/relay.ts) to every feed response, so it holds
// for every news skill, including ones learned before it existed.

export const EXPLICIT = new RegExp(
  [
    "\\bx{3}\\b",
    "\\bporn\\w*",
    "\\bnudes?\\b",
    "\\bnaked\\b",
    "\\bnsfw\\b",
    "\\bonlyfans\\b",
    "\\bescorts?\\b",
    "\\bmms\\b",
    "\\bbhabhi\\b",
    "\\bviral\\s+(mms|video|clip)s?\\b",
    "\\bleaked\\s+(video|clip|pics?|photos?|tape)s?\\b",
    "\\bhot\\s+(pics?|photos?|videos?|clips?|scenes?)\\b",
    "\\bsexy\\b",
    "\\bsex\\s+(video|tape|clip|scandal video)s?\\b",
    "\\badult\\s+(video|content|film)s?\\b",
    "\\b18\\s*\\+",
  ].join("|"),
  "i",
);

/** True when a headline is explicit or spam and must not be read aloud. */
export function unsuitable(title: string): boolean {
  return EXPLICIT.test(title.replace(/&amp;/g, "&"));
}

/** An RSS/Atom feed without its unsuitable stories. Anything that isn't a feed is returned unchanged. */
export function filterFeed(body: string): string {
  if (!/<(item|entry)[\s>]/.test(body)) return body;
  return body.replace(/<(item|entry)[\s>][^]*?<\/\1>/g, (story) => {
    const title = /<title[^>]*>([^]*?)<\/title>/.exec(story)?.[1] ?? "";
    return unsuitable(title) ? "" : story;
  });
}

/** The relay's hook: filters feeds by content type or shape; JSON and HTML pass through. */
export function filterContent(body: Buffer, contentType: string | undefined): Buffer {
  if (!/xml|rss|atom/i.test(contentType ?? "") && !/^\s*<\?xml|^\s*<rss/i.test(body.subarray(0, 200).toString("utf8"))) return body;
  const text = body.toString("utf8");
  const filtered = filterFeed(text);
  return filtered === text ? body : Buffer.from(filtered);
}
