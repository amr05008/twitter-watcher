import type { NormalizedPost, SourceAdapter } from "./types";

// Shape of a tweet object from twitterapi.io (the fields we read). The full
// payload has many more fields; we keep the whole thing in `raw`.
interface TwitterApiTweet {
  id?: string;
  url?: string;
  twitterUrl?: string;
  text?: string;
  fullText?: string; // twitterapi.io uses `text`; kept as a defensive fallback
  createdAt?: string; // e.g. "Tue Jun 02 21:56:45 +0000 2026"
  author?: { userName?: string; name?: string; id?: string };
  isReply?: boolean;
  retweeted_tweet?: unknown; // present (non-null) when the tweet is a retweet
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`twitter.normalize: missing required field "${field}"`);
  }
  return value;
}

// Twitter HTML-encodes ampersands and a few other chars in tweet text
// (e.g. "R&amp;D" rather than "R&D"). Discord renders these literally, so
// decode at the boundary before they hit D1.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function parseCreatedAt(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`twitter.normalize: unparseable createdAt "${raw}"`);
  }
  return d.toISOString();
}

export const twitterAdapter: SourceAdapter<TwitterApiTweet> = {
  name: "twitter",

  normalize(raw, _target): NormalizedPost {
    const id = requireString(raw.id, "id");
    const author = requireString(raw.author?.userName, "author.userName");
    const text = decodeHtmlEntities(requireString(raw.fullText ?? raw.text, "text"));
    const createdAt = requireString(raw.createdAt, "createdAt");
    const url =
      raw.twitterUrl ??
      raw.url ??
      `https://twitter.com/${author}/status/${id}`;

    return {
      source: "twitter",
      sourceId: id,
      author,
      timestamp: parseCreatedAt(createdAt),
      text,
      url,
      raw,
    };
  },
};
