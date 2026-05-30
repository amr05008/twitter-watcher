import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshHandleIngest } from "../src/ingest";
import { upsertWatchTarget } from "../src/db";
import type { Env } from "../src/env";
import { createFakeD1, type FakeD1 } from "./helpers/fake-d1";
import apifyTweet from "./fixtures/apify-tweet.json";
import apifySearch from "./fixtures/apify-search.json";

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as any,
    ANTHROPIC_API_KEY: "sk-test",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    TRIGGER_TOKEN: "t",
    APIFY_WEBHOOK_SECRET: "s",
    APIFY_TOKEN: "apify-tok",
    APIFY_ACTOR_ID: "apidojo~tweet-scraper",
  };
}

function fakeApify(items: unknown[], status = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("apify.com")) {
      return new Response(JSON.stringify(items), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected: " + url, { status: 599 });
  });
}

describe("ingest.refreshHandleIngest", () => {
  let db: FakeD1;

  beforeEach(async () => {
    db = createFakeD1();
    await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "karpathy" });
    await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "somefounder" });
  });

  it("returns zero ingest when there are no watched handles", async () => {
    const emptyDb = createFakeD1();
    const fetchImpl = fakeApify([apifyTweet]);
    const result = await refreshHandleIngest(makeEnv(emptyDb), fetchImpl as any);
    expect(result.handlesQueried).toBe(0);
    expect(result.ingested).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends watched handles to Apify and upserts returned tweets", async () => {
    const fetchImpl = fakeApify([apifyTweet, apifySearch]);
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);

    expect(result.handlesQueried).toBe(2);
    expect(result.ingested).toBe(2);
    expect(result.skippedNoTarget).toBe(0);
    expect(result.skippedMalformed).toBe(0);

    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toContain("apify.com");
    expect(url).toContain("apidojo~tweet-scraper");
    expect(url).toContain("run-sync-get-dataset-items");
    const body = JSON.parse(init.body);
    expect(body.twitterHandles).toEqual(["karpathy", "somefounder"]);
    expect(body.sort).toBe("Latest");
  });

  it("dedupes via INSERT OR IGNORE on (source, source_id)", async () => {
    const fetchImpl1 = fakeApify([apifyTweet]);
    await refreshHandleIngest(makeEnv(db), fetchImpl1 as any);

    const fetchImpl2 = fakeApify([apifyTweet]);
    const result2 = await refreshHandleIngest(makeEnv(db), fetchImpl2 as any);
    expect(result2.ingested).toBe(1); // counted as "attempted ingest", but DB dedupes

    const count = await db
      .prepare("SELECT COUNT(*) as n FROM posts")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("skips tweets from authors not in the watch list (defensive)", async () => {
    const otherAuthorTweet = {
      ...apifyTweet,
      id: "9999",
      author: { ...apifyTweet.author, userName: "randomperson" },
    };
    const fetchImpl = fakeApify([otherAuthorTweet, apifyTweet]);
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);
    expect(result.ingested).toBe(1);
    expect(result.skippedNoTarget).toBe(1);
  });

  it("matches author against watched handles case-insensitively", async () => {
    const mixedCaseTweet = {
      ...apifyTweet,
      id: "8888",
      author: { ...apifyTweet.author, userName: "KARPATHY" },
    };
    const fetchImpl = fakeApify([mixedCaseTweet]);
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);
    expect(result.ingested).toBe(1);
    expect(result.skippedNoTarget).toBe(0);
  });

  it("throws on Apify non-2xx so the caller can decide to continue or fail", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    await expect(
      refreshHandleIngest(makeEnv(db), fetchImpl as any),
    ).rejects.toThrow(/Apify/);
  });

  it("counts malformed items separately and does not throw", async () => {
    const fetchImpl = fakeApify([
      { not: "a tweet" },
      apifyTweet,
    ]);
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);
    expect(result.ingested).toBe(1);
    expect(result.skippedMalformed).toBe(1);
  });
});
