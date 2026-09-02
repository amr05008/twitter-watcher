import { describe, it, expect, vi } from "vitest";
import { TwitterWatcherClient } from "../src/client";

function makeFetch(routes: Array<{ match: (url: string) => boolean; respond: Response }>) {
  return vi.fn(async (url: string) => {
    for (const route of routes) {
      if (route.match(url)) return route.respond.clone();
    }
    return new Response(`no fake handler for ${url}`, { status: 599 });
  });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch): TwitterWatcherClient {
  return new TwitterWatcherClient({
    baseUrl: "https://twitter-watcher.example.dev",
    triggerToken: "test-token",
    fetchImpl,
  });
}

describe("TwitterWatcherClient.runBriefing", () => {
  it("POSTs /trigger with the X-Trigger-Token header", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/trigger"),
        respond: ok({ briefingId: "manual-x", postCount: 3 }),
      },
    ]);
    const result = await client(fakeFetch as any).runBriefing();
    expect(result.briefingId).toBe("manual-x");
    expect(result.postCount).toBe(3);

    const [url, init] = fakeFetch.mock.calls[0] as any;
    expect(url).toBe("https://twitter-watcher.example.dev/trigger");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Trigger-Token"]).toBe("test-token");
  });

  it("propagates skipped=true when nothing clears the bar", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/trigger"),
        respond: ok({ briefingId: "manual-h", skipped: true }),
      },
    ]);
    const result = await client(fakeFetch as any).runBriefing();
    expect(result.skipped).toBe(true);
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = makeFetch([
      {
        match: () => true,
        respond: new Response("unauthorized", { status: 404 }),
      },
    ]);
    await expect(client(fakeFetch as any).runBriefing()).rejects.toThrow(/404/);
  });
});

describe("TwitterWatcherClient.discoverAccounts", () => {
  it("POSTs /api/discover with the topic body", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/api/discover"),
        respond: ok({
          topic: "manychat",
          generatedAt: "2026-05-27T...",
          runId: "r1",
          accounts: [
            { handle: "x", rationale: "y", signalScore: 0.9, postCount: 2 },
          ],
        }),
      },
    ]);
    await client(fakeFetch as any).discoverAccounts({
      topic: "manychat",
      lookbackDays: 5,
    });
    const [url, init] = fakeFetch.mock.calls[0] as any;
    expect(url).toBe("https://twitter-watcher.example.dev/api/discover");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ topic: "manychat", lookbackDays: 5 });
  });
});

describe("TwitterWatcherClient.listWatchedAccounts", () => {
  it("GETs /api/watch-targets with the token header", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/api/watch-targets"),
        respond: ok({ targets: [] }),
      },
    ]);
    await client(fakeFetch as any).listWatchedAccounts();
    const [url, init] = fakeFetch.mock.calls[0] as any;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers["X-Trigger-Token"]).toBe("test-token");
    expect(url).toBe("https://twitter-watcher.example.dev/api/watch-targets");
  });
});

describe("TwitterWatcherClient.addWatchedAccount", () => {
  it("POSTs /api/promote with default source=twitter", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/api/promote"),
        respond: ok({ id: "twitter:handle:karpathy", alreadyExisted: false }),
      },
    ]);
    await client(fakeFetch as any).addWatchedAccount({ handle: "karpathy" });
    const [, init] = fakeFetch.mock.calls[0] as any;
    expect(JSON.parse(init.body)).toEqual({
      handle: "karpathy",
      source: "twitter",
    });
  });

  it("respects explicit source override", async () => {
    const fakeFetch = makeFetch([
      {
        match: () => true,
        respond: ok({ id: "reddit:handle:foo", alreadyExisted: false }),
      },
    ]);
    await client(fakeFetch as any).addWatchedAccount({
      handle: "foo",
      source: "reddit",
    });
    const [, init] = fakeFetch.mock.calls[0] as any;
    expect(JSON.parse(init.body).source).toBe("reddit");
  });
});

describe("TwitterWatcherClient.removeWatchedAccount", () => {
  it("DELETEs /api/watch-targets with handle + default source", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/api/watch-targets"),
        respond: ok({ id: "twitter:handle:karpathy", removed: true }),
      },
    ]);
    await client(fakeFetch as any).removeWatchedAccount({ handle: "karpathy" });
    const [, init] = fakeFetch.mock.calls[0] as any;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({
      handle: "karpathy",
      source: "twitter",
    });
  });
});

describe("TwitterWatcherClient.refreshTweets", () => {
  it("POSTs /api/refresh with the token header", async () => {
    const fakeFetch = makeFetch([
      {
        match: (url) => url.endsWith("/api/refresh"),
        respond: ok({
          handlesQueried: 5,
          ingested: 42,
          failedHandles: 1,
          skippedMalformed: 0,
        }),
      },
    ]);
    const result = await client(fakeFetch as any).refreshTweets();
    expect(result.handlesQueried).toBe(5);
    expect(result.ingested).toBe(42);

    const [url, init] = fakeFetch.mock.calls[0] as any;
    expect(url).toBe("https://twitter-watcher.example.dev/api/refresh");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Trigger-Token"]).toBe("test-token");
  });
});

describe("TwitterWatcherClient retries", () => {
  it("retries side-effect-free operations on transient HTTP failures", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(ok({ query: "ai", queryType: "Top", fetched: 0, hasMore: false, tweets: [] }));
    const sleepImpl = vi.fn(async () => undefined);
    const c = new TwitterWatcherClient({
      baseUrl: "https://twitter-watcher.example.dev",
      triggerToken: "t",
      fetchImpl: fakeFetch as any,
      retryBaseDelayMs: 25,
      sleepImpl,
    });

    await c.searchTweets({ query: "ai", queryType: "Top" });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(25);
  });

  it("retries side-effect-free operations on network failures", async () => {
    const fakeFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(ok({ targets: [] }));
    const c = new TwitterWatcherClient({
      baseUrl: "https://twitter-watcher.example.dev",
      triggerToken: "t",
      fetchImpl: fakeFetch as any,
      retryBaseDelayMs: 0,
      sleepImpl: async () => undefined,
    });

    await c.listWatchedAccounts();
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("never retries briefing, refresh, add, or remove writes", async () => {
    const fakeFetch = vi.fn(async () => new Response("busy", { status: 503 }));
    const makeClient = () => new TwitterWatcherClient({
      baseUrl: "https://twitter-watcher.example.dev",
      triggerToken: "t",
      fetchImpl: fakeFetch as any,
      retryBaseDelayMs: 0,
      sleepImpl: async () => undefined,
    });

    await expect(makeClient().runBriefing()).rejects.toThrow(/503/);
    await expect(makeClient().refreshTweets()).rejects.toThrow(/503/);
    await expect(makeClient().addWatchedAccount({ handle: "x" })).rejects.toThrow(/503/);
    await expect(makeClient().removeWatchedAccount({ handle: "x" })).rejects.toThrow(/503/);
    expect(fakeFetch).toHaveBeenCalledTimes(4);
  });
});

describe("TwitterWatcherClient baseUrl handling", () => {
  it("strips trailing slash from baseUrl so paths don't double up", async () => {
    const fakeFetch = makeFetch([
      { match: () => true, respond: ok({ briefingId: "x" }) },
    ]);
    const c = new TwitterWatcherClient({
      baseUrl: "https://twitter-watcher.example.dev/",
      triggerToken: "t",
      fetchImpl: fakeFetch as any,
    });
    await c.runBriefing();
    const [url] = fakeFetch.mock.calls[0] as any;
    expect(url).toBe("https://twitter-watcher.example.dev/trigger");
  });
});
