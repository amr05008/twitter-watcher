import { describe, it, expect } from "vitest";
import { twitterAdapter } from "../src/adapters/twitter";
import type { WatchTarget } from "../src/adapters/types";
import apifyTweet from "./fixtures/apify-tweet.json";
import apifySearch from "./fixtures/apify-search.json";

const handleTarget: WatchTarget = {
  id: "twitter:handle:karpathy",
  source: "twitter",
  kind: "handle",
  handle: "karpathy",
  weight: 1.0,
  addedAt: "2026-05-27T00:00:00.000Z",
};

const searchTarget: WatchTarget = {
  id: "twitter:search:manychat",
  source: "twitter",
  kind: "search",
  handle: "manychat",
  weight: 1.0,
  addedAt: "2026-05-27T00:00:00.000Z",
};

describe("twitterAdapter.normalize", () => {
  it("normalizes a handle-ingest tweet payload", () => {
    const post = twitterAdapter.normalize(apifyTweet, handleTarget);
    expect(post.source).toBe("twitter");
    expect(post.sourceId).toBe("1797823412345678901");
    expect(post.author).toBe("karpathy");
    expect(post.url).toBe("https://twitter.com/karpathy/status/1797823412345678901");
    expect(post.text).toContain("optimizer");
    expect(post.timestamp).toBe("2026-05-27T14:23:45.000Z");
    expect(post.raw).toBe(apifyTweet);
  });

  it("normalizes a search-result tweet payload from the same actor", () => {
    const post = twitterAdapter.normalize(apifySearch, searchTarget);
    expect(post.source).toBe("twitter");
    expect(post.sourceId).toBe("1798111122223334445");
    expect(post.author).toBe("somefounder");
    expect(post.url).toBe("https://twitter.com/somefounder/status/1798111122223334445");
    expect(post.text).toContain("Manychat");
    expect(post.timestamp).toBe("2026-05-25T09:15:30.000Z");
  });

  it("parses the Apify createdAt format (RFC-822-ish) into a valid ISO-8601 timestamp", () => {
    const post = twitterAdapter.normalize(apifyTweet, handleTarget);
    expect(post.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(post.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("falls back to text when fullText is missing", () => {
    const partial = { ...apifyTweet, fullText: undefined } as any;
    const post = twitterAdapter.normalize(partial, handleTarget);
    expect(post.text).toBe(apifyTweet.text);
  });

  it("decodes HTML entities in tweet text (Twitter API HTML-encodes &, <, >, etc.)", () => {
    const withEntities = {
      ...apifyTweet,
      text: "R&amp;D update: AT&amp;T 5&lt;6 &quot;hello&quot; it&#39;s &#8217; &amp;amp;",
      fullText: "R&amp;D update: AT&amp;T 5&lt;6 &quot;hello&quot; it&#39;s &#8217; &amp;amp;",
    } as any;
    const post = twitterAdapter.normalize(withEntities, handleTarget);
    expect(post.text).toContain("R&D update");
    expect(post.text).toContain("AT&T");
    expect(post.text).toContain("5<6");
    expect(post.text).toContain('"hello"');
    expect(post.text).toContain("it's");
    expect(post.text).toContain("’"); // &#8217; — right single quote
    expect(post.text).toContain("&amp;"); // &amp;amp; → &amp; (one decode pass)
  });

  it("throws on a payload missing required fields (id, author, text)", () => {
    const broken = { ...apifyTweet, id: undefined } as any;
    expect(() => twitterAdapter.normalize(broken, handleTarget)).toThrow();
  });
});
