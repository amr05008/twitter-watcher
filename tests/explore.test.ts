import { describe, it, expect, vi } from "vitest";
import {
  getAccountFollowing,
  getAccountTweets,
  searchTweets,
} from "../src/explore";
import type { Env } from "../src/env";

function makeEnv(): Env {
  return {
    DB: {} as any,
    ANTHROPIC_API_KEY: "sk-test",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    TRIGGER_TOKEN: "t",
    TWITTERAPI_IO_KEY: "twapi-key",
  };
}

function tweet(handle: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    text,
    twitterUrl: `https://twitter.com/${handle}/status/${id}`,
    createdAt: "Tue Jun 02 21:56:45 +0000 2026",
    author: { userName: handle, name: `${handle} display`, followers: 1234 },
    likeCount: 10,
    retweetCount: 2,
    replyCount: 1,
    viewCount: 999,
    isReply: false,
    ...extra,
  };
}

/** A fetch stub that returns queued pages in order for a matching URL substring. */
function pagedFetch(match: string, pages: unknown[]) {
  let call = 0;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === "string" && url.includes(match)) {
      const body = pages[Math.min(call, pages.length - 1)];
      call++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected url: " + url, { status: 500 });
  });
}

describe("explore.searchTweets", () => {
  it("hits advanced_search with the API key + queryType and maps engagement fields", async () => {
    const fetchImpl = pagedFetch("/twitter/tweet/advanced_search", [
      { tweets: [tweet("karpathy", "1", "a sample tweet")], has_next_page: false },
    ]);
    const res = await searchTweets(
      makeEnv(),
      { query: "(LLM OR AI) (eval OR agent)", queryType: "Top" },
      fetchImpl as any,
    );

    expect(res.queryType).toBe("Top");
    expect(res.fetched).toBe(1);
    expect(res.hasMore).toBe(false);
    const t = res.tweets[0]!;
    expect(t.author).toBe("karpathy");
    expect(t.authorName).toBe("karpathy display");
    expect(t.authorFollowers).toBe(1234);
    expect(t.likeCount).toBe(10);
    expect(t.viewCount).toBe(999);

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toContain("/twitter/tweet/advanced_search");
    expect(call[0]).toContain("queryType=Top");
    expect((call[1] as any).headers["X-API-Key"]).toBe("twapi-key");
  });

  it("follows next_cursor across pages and stops at the cap", async () => {
    const fetchImpl = pagedFetch("/twitter/tweet/advanced_search", [
      { tweets: [tweet("a", "1", "p1"), tweet("b", "2", "p2")], has_next_page: true, next_cursor: "C1" },
      { tweets: [tweet("c", "3", "p3"), tweet("d", "4", "p4")], has_next_page: true, next_cursor: "C2" },
    ]);
    const res = await searchTweets(makeEnv(), { query: "x", maxTweets: 3 }, fetchImpl as any);

    expect(res.fetched).toBe(3);
    expect(res.hasMore).toBe(true);
    // Two pages fetched (2 + 2 = 4 ≥ cap 3), no third request.
    expect(fetchImpl.mock.calls.length).toBe(2);
    expect(fetchImpl.mock.calls[1]![0]).toContain("cursor=C1");
  });

  it("skips malformed (non-tweet) items", async () => {
    const fetchImpl = pagedFetch("/twitter/tweet/advanced_search", [
      { tweets: [tweet("a", "1", "ok"), { not: "a tweet" }], has_next_page: false },
    ]);
    const res = await searchTweets(makeEnv(), { query: "x" }, fetchImpl as any);
    expect(res.fetched).toBe(1);
  });

  it("throws on a twitterapi.io error (loud failure)", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(
      searchTweets(makeEnv(), { query: "x" }, fetchImpl as any),
    ).rejects.toThrow(/twitterapi\.io/);
  });
});

describe("explore.getAccountTweets", () => {
  it("hits last_tweets and reads tweets nested under data.tweets", async () => {
    const fetchImpl = pagedFetch("/twitter/user/last_tweets", [
      { data: { tweets: [tweet("karpathy", "1", "a sample tweet")], has_next_page: false } },
    ]);
    const res = await getAccountTweets(makeEnv(), { handle: "karpathy" }, fetchImpl as any);

    expect(res.handle).toBe("karpathy");
    expect(res.fetched).toBe(1);
    expect(res.tweets[0]!.text).toBe("a sample tweet");
    expect(fetchImpl.mock.calls[0]![0]).toContain("userName=karpathy");
  });

  it("asks last_tweets for replies too (the endpoint omits them by default)", async () => {
    const fetchImpl = pagedFetch("/twitter/user/last_tweets", [
      { data: { tweets: [tweet("a", "1", "hi", { isReply: true })], has_next_page: false } },
    ]);
    const res = await getAccountTweets(makeEnv(), { handle: "a" }, fetchImpl as any);
    expect(fetchImpl.mock.calls[0]![0]).toContain("includeReplies=true");
    expect(res.tweets[0]!.isReply).toBe(true);
  });

  it("flags retweets via retweeted_tweet", async () => {
    const fetchImpl = pagedFetch("/twitter/user/last_tweets", [
      { tweets: [tweet("a", "1", "RT something", { retweeted_tweet: { id: "x" } })], has_next_page: false },
    ]);
    const res = await getAccountTweets(makeEnv(), { handle: "a" }, fetchImpl as any);
    expect(res.tweets[0]!.isRetweet).toBe(true);
  });
});

describe("explore.getAccountFollowing", () => {
  it("returns accounts with bios + follower counts and paginates", async () => {
    const fetchImpl = pagedFetch("/twitter/user/followings", [
      {
        followings: [
          { userName: "peer1", name: "Peer One", followers: 5000, description: "indie hacker" },
        ],
        has_next_page: true,
        next_cursor: "F1",
      },
      {
        followings: [
          { userName: "peer2", name: "Peer Two", followers: 8000, description: "HVAC + AI" },
        ],
        has_next_page: false,
      },
    ]);
    const res = await getAccountFollowing(
      makeEnv(),
      { handle: "karpathy", maxAccounts: 50 },
      fetchImpl as any,
    );

    expect(res.fetched).toBe(2);
    expect(res.hasMore).toBe(false);
    expect(res.accounts[0]).toMatchObject({ userName: "peer1", followers: 5000, description: "indie hacker" });
    expect(fetchImpl.mock.calls[0]![0]).toContain("pageSize=200");
    expect(fetchImpl.mock.calls[1]![0]).toContain("cursor=F1");
  });

  it("strips a leading '@' from the handle and reads snake_case count fields", async () => {
    const fetchImpl = pagedFetch("/twitter/user/followings", [
      {
        followings: [
          { userName: "peer1", name: "Peer One", followers_count: 5000, statuses_count: 42 },
        ],
        has_next_page: false,
      },
    ]);
    const res = await getAccountFollowing(
      makeEnv(),
      { handle: "@karpathy" },
      fetchImpl as any,
    );
    expect(res.handle).toBe("karpathy");
    expect(fetchImpl.mock.calls[0]![0]).toContain("userName=karpathy");
    expect(fetchImpl.mock.calls[0]![0]).not.toContain("%40");
    expect(res.accounts[0]!.followers).toBe(5000);
    expect(res.accounts[0]!.statusesCount).toBe(42);
  });

  it("skips accounts missing a userName", async () => {
    const fetchImpl = pagedFetch("/twitter/user/followings", [
      { followings: [{ name: "no handle" }, { userName: "ok" }], has_next_page: false },
    ]);
    const res = await getAccountFollowing(makeEnv(), { handle: "x" }, fetchImpl as any);
    expect(res.fetched).toBe(1);
    expect(res.accounts[0]!.userName).toBe("ok");
  });
});
