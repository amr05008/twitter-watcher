import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function fakeFetch(opts: { anthropicPicks: any[]; lead?: string }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
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
              input: { lead: opts.lead, picks: opts.anthropicPicks },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected: " + url, { status: 500 });
  });
}

const discordCallsIn = (f: ReturnType<typeof fakeFetch>) =>
  f.mock.calls.filter((c) =>
    typeof c[0] === "string" ? c[0].includes("discord.com") : false,
  );
const anthropicCallsIn = (f: ReturnType<typeof fakeFetch>) =>
  f.mock.calls.filter((c) =>
    typeof c[0] === "string" ? c[0].includes("anthropic.com") : false,
  );

describe("briefing.runBriefing", () => {
  let db: FakeD1;

  beforeEach(async () => {
    db = createFakeD1();
    await upsertWatchTarget(db as any, {
      source: "twitter",
      kind: "handle",
      handle: "karpathy",
    });
    // Seed three recent posts so both the windowed cron path and the
    // full-backlog manual path see them. posted_at DESC → sourceId 1,2,3.
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000).toISOString();
    for (const [sourceId, h] of [["1", 1], ["2", 2], ["3", 3]] as const) {
      await upsertPost(db as any, "twitter:handle:karpathy", {
        source: "twitter",
        sourceId,
        author: "karpathy",
        timestamp: hoursAgo(h),
        text: `post ${sourceId}`,
        url: `https://twitter.com/karpathy/status/${sourceId}`,
        raw: {},
      });
    }
  });

  it("picks signals, posts to Discord, marks summarized, and writes a briefing row", async () => {
    const fetchImpl = fakeFetch({
      lead: "Three things today.",
      anthropicPicks: [
        { rank: 1, postIndex: 1, rationale: "best" },
        { rank: 2, postIndex: 2, rationale: "good" },
        { rank: 3, postIndex: 3, rationale: "ok" },
      ],
    });

    const result = await runBriefing(makeEnv(db), "manual", "system", fetchImpl as any);

    expect("postCount" in result && result.postCount).toBe(3);
    expect(discordCallsIn(fetchImpl).length).toBe(1);

    // All picked posts are marked summarized.
    expect((await getUnsummarized(db as any)).length).toBe(0);

    const row = await db
      .prepare("SELECT COUNT(*) as n FROM briefings")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("skips silently when there are no unsummarized posts (no Discord post)", async () => {
    await db.prepare("UPDATE posts SET summarized_in = 'pre'").run();

    const fetchImpl = fakeFetch({ anthropicPicks: [] });
    const result = await runBriefing(makeEnv(db), "manual", "system", fetchImpl as any);

    expect("skipped" in result && result.skipped).toBe(true);
    expect(anthropicCallsIn(fetchImpl).length).toBe(0); // no candidates → no Claude call
    expect(discordCallsIn(fetchImpl).length).toBe(0); // silent — nothing posted
  });

  it("skips silently when Claude returns no picks (quality gate)", async () => {
    const fetchImpl = fakeFetch({ anthropicPicks: [] });
    const result = await runBriefing(makeEnv(db), "manual", "system", fetchImpl as any);

    expect("skipped" in result && result.skipped).toBe(true);
    expect(anthropicCallsIn(fetchImpl).length).toBe(1); // candidates existed → Claude ran
    expect(discordCallsIn(fetchImpl).length).toBe(0); // but nothing cleared the bar → no post

    // Nothing marked, no row — the posts get another look next run.
    expect((await getUnsummarized(db as any)).length).toBe(3);
    const row = await db
      .prepare("SELECT COUNT(*) as n FROM briefings")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("uses YYYY-MM-DD as briefingId for cron trigger", async () => {
    const fetchImpl = fakeFetch({
      anthropicPicks: [{ rank: 1, postIndex: 1, rationale: "r" }],
    });
    const result = await runBriefing(makeEnv(db), "cron", "system", fetchImpl as any);
    expect("briefingId" in result && result.briefingId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("cron scopes candidates to a recent window; manual flushes the backlog", async () => {
    // Drain the recent seed; leave one post well outside the ≤7d window.
    await db.prepare("UPDATE posts SET summarized_in = 'pre'").run();
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    await upsertPost(db as any, "twitter:handle:karpathy", {
      source: "twitter",
      sourceId: "old",
      author: "karpathy",
      timestamp: old,
      text: "old post",
      url: "https://twitter.com/karpathy/status/old",
      raw: {},
    });

    // Cron: 10-day-old post is outside the window → nothing to consider → skip.
    const cronFetch = fakeFetch({
      anthropicPicks: [{ rank: 1, postIndex: 1, rationale: "r" }],
    });
    const cronResult = await runBriefing(makeEnv(db), "cron", "system", cronFetch as any);
    expect("skipped" in cronResult && cronResult.skipped).toBe(true);
    expect(anthropicCallsIn(cronFetch).length).toBe(0);

    // Manual: no window → the old post is considered and briefed.
    const manualFetch = fakeFetch({
      anthropicPicks: [{ rank: 1, postIndex: 1, rationale: "r" }],
    });
    const manualResult = await runBriefing(makeEnv(db), "manual", "system", manualFetch as any);
    expect("postCount" in manualResult && manualResult.postCount).toBe(1);
  });

  describe("Monday liveness ping", () => {
    afterEach(() => vi.useRealTimers());

    // Seed a single in-window candidate at the (faked) current time so Claude
    // runs and returns no picks → the quiet path is exercised.
    async function seedOneRecent() {
      await db.prepare("DELETE FROM posts").run();
      await upsertPost(db as any, "twitter:handle:karpathy", {
        source: "twitter",
        sourceId: "q1",
        author: "karpathy",
        timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
        text: "nothing special",
        url: "https://twitter.com/karpathy/status/q1",
        raw: {},
      });
    }

    it("posts a liveness ping on a quiet Monday cron", async () => {
      vi.setSystemTime(new Date("2026-06-01T11:00:00.000Z")); // Monday
      await seedOneRecent();
      const fetchImpl = fakeFetch({ anthropicPicks: [] });
      const result = await runBriefing(makeEnv(db), "cron", "system", fetchImpl as any);

      expect("healthPing" in result && result.healthPing).toBe(true);
      expect(discordCallsIn(fetchImpl).length).toBe(1);
      // The ping is not a briefing — no row, candidate left unmarked.
      const row = await db.prepare("SELECT COUNT(*) as n FROM briefings").first<{ n: number }>();
      expect(row?.n).toBe(0);
      expect((await getUnsummarized(db as any)).length).toBe(1);
    });

    it("stays silent on a quiet non-Monday cron", async () => {
      vi.setSystemTime(new Date("2026-06-02T11:00:00.000Z")); // Tuesday
      await seedOneRecent();
      const fetchImpl = fakeFetch({ anthropicPicks: [] });
      const result = await runBriefing(makeEnv(db), "cron", "system", fetchImpl as any);

      expect("skipped" in result && result.skipped).toBe(true);
      expect(discordCallsIn(fetchImpl).length).toBe(0);
    });

    it("manual trigger never health-pings, even on Monday", async () => {
      vi.setSystemTime(new Date("2026-06-01T11:00:00.000Z")); // Monday
      await seedOneRecent();
      const fetchImpl = fakeFetch({ anthropicPicks: [] });
      const result = await runBriefing(makeEnv(db), "manual", "system", fetchImpl as any);

      expect("skipped" in result && result.skipped).toBe(true);
      expect(discordCallsIn(fetchImpl).length).toBe(0);
    });
  });
});
