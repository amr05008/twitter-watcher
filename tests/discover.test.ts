import { describe, it, expect, vi } from "vitest";
import { runDiscover } from "../src/discover";
import type { Env } from "../src/env";
import apifyTweet from "./fixtures/apify-tweet.json";
import apifySearch from "./fixtures/apify-search.json";

function makeEnv(): Env {
  return {
    DB: {} as any,
    ANTHROPIC_API_KEY: "sk-test",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    TRIGGER_TOKEN: "t",
    APIFY_WEBHOOK_SECRET: "s",
    APIFY_TOKEN: "apify-tok",
    APIFY_ACTOR_ID: "apidojo~tweet-scraper",
  };
}

function fakeFetch(routes: { apifyResults: unknown[]; anthropicAccounts: any[] }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === "string" && url.includes("apify.com")) {
      return new Response(JSON.stringify(routes.apifyResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof url === "string" && url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "suggest_accounts",
              input: { accounts: routes.anthropicAccounts },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected url: " + url, { status: 500 });
  });
}

describe("discover.runDiscover", () => {
  it("calls Apify with searchTerms and returns top-3 accounts", async () => {
    const fetchImpl = fakeFetch({
      apifyResults: [apifyTweet, apifySearch],
      anthropicAccounts: [
        { handle: "karpathy", rationale: "high signal", signalScore: 0.9 },
        { handle: "somefounder", rationale: "decent", signalScore: 0.6 },
        { handle: "karpathy", rationale: "filler", signalScore: 0.3 },
      ],
    });
    const res = await runDiscover(
      makeEnv(),
      { topic: "manychat", lookbackDays: 7 },
      "system",
      fetchImpl as any,
    );
    expect(res.topic).toBe("manychat");
    expect(res.accounts.length).toBe(3);
    expect(res.accounts[0]?.handle).toBe("karpathy");

    const apifyCall = (fetchImpl.mock.calls.find((c) =>
      typeof c[0] === "string" ? c[0].includes("apify.com") : false,
    )!)[1] as any;
    const apifyBody = JSON.parse(apifyCall.body);
    expect(apifyBody.searchTerms).toEqual(["manychat"]);
  });

  it("aggregates posts by author with sample text", async () => {
    const fetchImpl = fakeFetch({
      apifyResults: [apifyTweet, { ...apifyTweet, id: "999" }, apifySearch],
      anthropicAccounts: [
        { handle: "karpathy", rationale: "two posts", signalScore: 0.9 },
        { handle: "somefounder", rationale: "one post", signalScore: 0.5 },
        { handle: "karpathy", rationale: "filler", signalScore: 0.2 },
      ],
    });
    const res = await runDiscover(
      makeEnv(),
      { topic: "manychat" },
      "system",
      fetchImpl as any,
    );
    const karpathy = res.accounts.find((a) => a.handle === "karpathy");
    expect(karpathy?.postCount).toBe(2);
    const somefounder = res.accounts.find((a) => a.handle === "somefounder");
    expect(somefounder?.postCount).toBe(1);
  });

  it("returns empty accounts when Apify returns no usable tweets", async () => {
    const fetchImpl = fakeFetch({
      apifyResults: [],
      anthropicAccounts: [],
    });
    const res = await runDiscover(
      makeEnv(),
      { topic: "nonsense_topic_xyz" },
      "system",
      fetchImpl as any,
    );
    expect(res.accounts).toEqual([]);
    // Anthropic should NOT have been called if there are no authors
    const anthropicCalls = fetchImpl.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("anthropic.com") : false,
    );
    expect(anthropicCalls.length).toBe(0);
  });

  it("returns sample tweet text alongside each account", async () => {
    const fetchImpl = fakeFetch({
      apifyResults: [apifyTweet, apifySearch],
      anthropicAccounts: [
        { handle: "karpathy", rationale: "high signal", signalScore: 0.9 },
        { handle: "somefounder", rationale: "decent", signalScore: 0.6 },
        { handle: "karpathy", rationale: "filler", signalScore: 0.3 },
      ],
    });
    const res = await runDiscover(
      makeEnv(),
      { topic: "manychat" },
      "system",
      fetchImpl as any,
    );
    const karpathy = res.accounts.find((a) => a.handle === "karpathy");
    expect(karpathy?.samples).toEqual([
      "Just shipped a new optimizer that beats AdamW on a few internal benchmarks. Writeup soon.",
    ]);
    const somefounder = res.accounts.find((a) => a.handle === "somefounder");
    expect(somefounder?.samples).toEqual([
      "Manychat just released their new API. Looks promising for chat automation use cases.",
    ]);
  });

  it("throws on Apify error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    await expect(
      runDiscover(makeEnv(), { topic: "manychat" }, "system", fetchImpl as any),
    ).rejects.toThrow(/Apify/);
  });
});
