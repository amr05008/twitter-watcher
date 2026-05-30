import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBriefing } from "../src/briefing";
import { upsertPost, upsertWatchTarget, getUnsummarized } from "../src/db";
import type { Env } from "../src/env";
import { createFakeD1, type FakeD1 } from "./helpers/fake-d1";

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

function fakeFetch(opts: { anthropicPicks: any[] }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("discord.com")) {
      return new Response("ok", { status: 200 });
    }
    if (typeof url === "string" && url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "select_top_signal",
              input: { picks: opts.anthropicPicks },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected: " + url, { status: 500 });
  });
}

describe("briefing.runBriefing", () => {
  let db: FakeD1;

  beforeEach(async () => {
    db = createFakeD1();
    await upsertWatchTarget(db as any, {
      source: "twitter",
      kind: "handle",
      handle: "karpathy",
    });
    await upsertPost(db as any, "twitter:handle:karpathy", {
      source: "twitter",
      sourceId: "1",
      author: "karpathy",
      timestamp: "2026-05-27T14:00:00.000Z",
      text: "post one",
      url: "https://twitter.com/karpathy/status/1",
      raw: {},
    });
    await upsertPost(db as any, "twitter:handle:karpathy", {
      source: "twitter",
      sourceId: "2",
      author: "karpathy",
      timestamp: "2026-05-27T13:00:00.000Z",
      text: "post two",
      url: "https://twitter.com/karpathy/status/2",
      raw: {},
    });
    await upsertPost(db as any, "twitter:handle:karpathy", {
      source: "twitter",
      sourceId: "3",
      author: "karpathy",
      timestamp: "2026-05-27T12:00:00.000Z",
      text: "post three",
      url: "https://twitter.com/karpathy/status/3",
      raw: {},
    });
  });

  it("picks top-3, posts to Slack, marks summarized, and writes briefing row", async () => {
    const fetchImpl = fakeFetch({
      anthropicPicks: [
        { rank: 1, postIndex: 1, rationale: "best" },
        { rank: 2, postIndex: 2, rationale: "good" },
        { rank: 3, postIndex: 3, rationale: "ok" },
      ],
    });

    const env = makeEnv(db);
    const result = await runBriefing(env, "manual", "system", fetchImpl as any);

    expect("postCount" in result && result.postCount).toBe(3);

    // Slack was posted
    const discordCalls = fetchImpl.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("discord.com") : false,
    );
    expect(discordCalls.length).toBe(1);

    // No unsummarized posts left
    const remaining = await getUnsummarized(db as any);
    expect(remaining.length).toBe(0);

    // Briefing row exists
    const row = await db
      .prepare("SELECT COUNT(*) as n FROM briefings")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("returns heartbeat when no unsummarized posts", async () => {
    // Drain the seeded posts
    await db.prepare("UPDATE posts SET summarized_in = 'pre'").run();

    const fetchImpl = fakeFetch({ anthropicPicks: [] });
    const result = await runBriefing(makeEnv(db), "manual", "system", fetchImpl as any);

    expect("heartbeat" in result && result.heartbeat).toBe(true);

    // Anthropic should not have been called
    const anthropicCalls = fetchImpl.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("anthropic.com") : false,
    );
    expect(anthropicCalls.length).toBe(0);

    // Slack was posted (heartbeat)
    const discordCalls = fetchImpl.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("discord.com") : false,
    );
    expect(discordCalls.length).toBe(1);
  });

  it("uses YYYY-MM-DD as briefingId for cron trigger", async () => {
    const fetchImpl = fakeFetch({
      anthropicPicks: [
        { rank: 1, postIndex: 1, rationale: "r" },
        { rank: 2, postIndex: 2, rationale: "r" },
        { rank: 3, postIndex: 3, rationale: "r" },
      ],
    });
    const result = await runBriefing(makeEnv(db), "cron", "system", fetchImpl as any);
    expect("briefingId" in result && result.briefingId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
