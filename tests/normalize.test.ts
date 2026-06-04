import { describe, it, expect } from "vitest";
import { twitterAdapter } from "../src/adapters/twitter";
import type { WatchTarget } from "../src/adapters/types";
import timeline from "./fixtures/twitterapi-timeline.json";
import search from "./fixtures/twitterapi-search.json";

const handleTarget: WatchTarget = {
  id: "twitter:handle:karpathy",
  source: "twitter",
  kind: "handle",
  handle: "karpathy",
  weight: 1.0,
  addedAt: "2026-05-27T00:00:00.000Z",
};

const searchTarget: WatchTarget = {
  id: "twitter:search:ai-agents",
  source: "twitter",
  kind: "search",
  handle: "ai agents",
  weight: 1.0,
  addedAt: "2026-05-27T00:00:00.000Z",
};

const timelineTweets = (timeline as any).data.tweets as any[];
const searchTweets = (search as any).tweets as any[];

describe("twitterAdapter.normalize", () => {
  it("normalizes a twitterapi.io timeline tweet", () => {
    const raw = timelineTweets[0];
    const post = twitterAdapter.normalize(raw, handleTarget);
    expect(post.source).toBe("twitter");
    expect(post.sourceId).toBe(raw.id);
    expect(post.author).toBe(raw.author.userName);
    // twitterUrl is preferred over url
    expect(post.url).toBe(raw.twitterUrl);
    expect(post.text.length).toBeGreaterThan(0);
    expect(post.raw).toBe(raw);
  });

  it("normalizes a search-result tweet", () => {
    const raw = searchTweets[0];
    const post = twitterAdapter.normalize(raw, searchTarget);
    expect(post.source).toBe("twitter");
    expect(post.sourceId).toBe(raw.id);
    expect(post.author).toBe(raw.author.userName);
  });

  it("parses twitterapi.io's createdAt ('Tue Jun 02 …') into ISO-8601", () => {
    const post = twitterAdapter.normalize(timelineTweets[0], handleTarget);
    expect(post.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(post.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("uses `text` (twitterapi.io has no fullText)", () => {
    const raw = { id: "1", text: "hello world", createdAt: "Tue Jun 02 21:56:45 +0000 2026", author: { userName: "karpathy" } } as any;
    const post = twitterAdapter.normalize(raw, handleTarget);
    expect(post.text).toBe("hello world");
  });

  it("decodes HTML entities in tweet text", () => {
    const raw = {
      id: "2",
      text: "R&amp;D update: AT&amp;T 5&lt;6 &quot;hi&quot; it&#39;s &#8217; &amp;amp;",
      createdAt: "Tue Jun 02 21:56:45 +0000 2026",
      author: { userName: "karpathy" },
    } as any;
    const post = twitterAdapter.normalize(raw, handleTarget);
    expect(post.text).toContain("R&D update");
    expect(post.text).toContain("AT&T");
    expect(post.text).toContain("5<6");
    expect(post.text).toContain('"hi"');
    expect(post.text).toContain("it's");
    expect(post.text).toContain("’"); // &#8217;
    expect(post.text).toContain("&amp;"); // &amp;amp; → &amp; (one pass)
  });

  it("throws on a payload missing required fields", () => {
    const broken = { ...timelineTweets[0], id: undefined } as any;
    expect(() => twitterAdapter.normalize(broken, handleTarget)).toThrow();
  });
});
