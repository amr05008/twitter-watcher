import { describe, it, expect, vi } from "vitest";
import { runDiscover } from "../src/discover";
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

function tweet(handle: string, id: string, text: string) {
  return {
    id,
    text,
    twitterUrl: `https://twitter.com/${handle}/status/${id}`,
    createdAt: "Tue Jun 02 21:56:45 +0000 2026",
    author: { userName: handle },
  };
}

function fakeFetch(routes: { searchResults: unknown[]; anthropicAccounts: any[] }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === "string" && url.includes("twitterapi.io")) {
      return new Response(JSON.stringify({ tweets: routes.searchResults }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof url === "string" && url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          content: [
            { type: "tool_use", name: "suggest_accounts", input: { accounts: routes.anthropicAccounts } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected url: " + url, { status: 500 });
  });
}

describe("discover.runDiscover", () => {
  it("calls twitterapi.io search (with the API key) and returns top-3 accounts", async () => {
    const fetchImpl = fakeFetch({
      searchResults: [tweet("karpathy", "1", "a"), tweet("somefounder", "2", "b")],
      anthropicAccounts: [
        { handle: "karpathy", rationale: "high signal", signalScore: 0.9 },
        { handle: "somefounder", rationale: "decent", signalScore: 0.6 },
        { handle: "karpathy", rationale: "filler", signalScore: 0.3 },
      ],
    });
    const res = await runDiscover(makeEnv(), { topic: "AI agents", lookbackDays: 7 }, "system", fetchImpl as any);
    expect(res.topic).toBe("AI agents");
    expect(res.accounts.length).toBe(3);
    expect(res.accounts[0]?.handle).toBe("karpathy");

    const searchCall = fetchImpl.mock.calls.find((c) =>
      typeof c[0] === "string" ? c[0].includes("twitterapi.io") : false,
    )!;
    expect(searchCall[0]).toContain("/twitter/tweet/advanced_search");
    expect(searchCall[0]).toContain("query=AI%20agents");
    expect((searchCall[1] as any).headers["X-API-Key"]).toBe("twapi-key");
  });

  it("aggregates posts by author with sample text", async () => {
    const fetchImpl = fakeFetch({
      searchResults: [
        tweet("karpathy", "1", "first karpathy take"),
        tweet("karpathy", "2", "second karpathy take"),
        tweet("somefounder", "3", "founder take"),
      ],
      anthropicAccounts: [
        { handle: "karpathy", rationale: "two posts", signalScore: 0.9 },
        { handle: "somefounder", rationale: "one post", signalScore: 0.5 },
        { handle: "karpathy", rationale: "filler", signalScore: 0.2 },
      ],
    });
    const res = await runDiscover(makeEnv(), { topic: "x" }, "system", fetchImpl as any);
    expect(res.accounts.find((a) => a.handle === "karpathy")?.postCount).toBe(2);
    expect(res.accounts.find((a) => a.handle === "somefounder")?.postCount).toBe(1);
    expect(res.accounts.find((a) => a.handle === "karpathy")?.samples).toEqual([
      "first karpathy take",
      "second karpathy take",
    ]);
  });

  it("returns empty accounts and skips Anthropic when search yields no tweets", async () => {
    const fetchImpl = fakeFetch({ searchResults: [], anthropicAccounts: [] });
    const res = await runDiscover(makeEnv(), { topic: "nonsense_xyz" }, "system", fetchImpl as any);
    expect(res.accounts).toEqual([]);
    const anthropicCalls = fetchImpl.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("anthropic.com") : false,
    );
    expect(anthropicCalls.length).toBe(0);
  });

  it("throws on a twitterapi.io search error", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(
      runDiscover(makeEnv(), { topic: "x" }, "system", fetchImpl as any),
    ).rejects.toThrow(/twitterapi\.io/);
  });
});
