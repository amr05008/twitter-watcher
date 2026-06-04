import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshHandleIngest } from "../src/ingest";
import { upsertWatchTarget } from "../src/db";
import type { Env } from "../src/env";
import { createFakeD1, type FakeD1 } from "./helpers/fake-d1";

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as any,
    ANTHROPIC_API_KEY: "sk-test",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    TRIGGER_TOKEN: "t",
    TWITTERAPI_IO_KEY: "twapi-key",
  };
}

function tweet(handle: string, id: string) {
  return {
    id,
    text: `post ${id} from ${handle}`,
    twitterUrl: `https://twitter.com/${handle}/status/${id}`,
    createdAt: "Tue Jun 02 21:56:45 +0000 2026",
    author: { userName: handle },
  };
}

// Mock the twitterapi.io last_tweets endpoint: parse the userName from the URL,
// return that handle's tweets (or fail it). Envelope matches the real API.
function fakeTwitterApi(opts: {
  tweetsByHandle?: Record<string, unknown[]>;
  failHandles?: string[];
}) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const handle = new URL(url).searchParams.get("userName") ?? "";
    if (opts.failHandles?.includes(handle)) {
      return new Response("upstream error", { status: 500 });
    }
    const tweets = opts.tweetsByHandle?.[handle] ?? [];
    return new Response(JSON.stringify({ status: "success", data: { tweets } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("ingest.refreshHandleIngest", () => {
  let db: FakeD1;

  beforeEach(async () => {
    db = createFakeD1();
    await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "karpathy" });
    await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "somefounder" });
  });

  it("returns zero ingest and makes no calls when there are no watched handles", async () => {
    const emptyDb = createFakeD1();
    const fetchImpl = fakeTwitterApi({});
    const result = await refreshHandleIngest(makeEnv(emptyDb), fetchImpl as any);
    expect(result.handlesQueried).toBe(0);
    expect(result.ingested).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches one request per handle (with the API key) and upserts the tweets", async () => {
    const fetchImpl = fakeTwitterApi({
      tweetsByHandle: {
        karpathy: [tweet("karpathy", "1"), tweet("karpathy", "2")],
        somefounder: [tweet("somefounder", "3")],
      },
    });
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);

    expect(result.handlesQueried).toBe(2);
    expect(result.ingested).toBe(3);
    expect(result.failedHandles).toBe(0);
    expect(result.skippedMalformed).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toContain("api.twitterapi.io/twitter/user/last_tweets");
    expect(url).toContain("userName=karpathy");
    expect(init.headers["X-API-Key"]).toBe("twapi-key");

    const count = await db.prepare("SELECT COUNT(*) as n FROM posts").first<{ n: number }>();
    expect(count?.n).toBe(3);
  });

  it("dedupes via INSERT OR IGNORE on (source, source_id)", async () => {
    const payload = { tweetsByHandle: { karpathy: [tweet("karpathy", "1")], somefounder: [] } };
    await refreshHandleIngest(makeEnv(db), fakeTwitterApi(payload) as any);
    const result2 = await refreshHandleIngest(makeEnv(db), fakeTwitterApi(payload) as any);
    expect(result2.ingested).toBe(1); // attempted again, but DB dedupes

    const count = await db.prepare("SELECT COUNT(*) as n FROM posts").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("counts malformed items separately and does not throw", async () => {
    const fetchImpl = fakeTwitterApi({
      tweetsByHandle: { karpathy: [tweet("karpathy", "1"), { not: "a tweet" }], somefounder: [] },
    });
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);
    expect(result.ingested).toBe(1);
    expect(result.skippedMalformed).toBe(1);
  });

  it("isolates a per-handle failure — other handles still ingest", async () => {
    const fetchImpl = fakeTwitterApi({
      tweetsByHandle: { somefounder: [tweet("somefounder", "9")] },
      failHandles: ["karpathy"],
    });
    const result = await refreshHandleIngest(makeEnv(db), fetchImpl as any);
    expect(result.handlesQueried).toBe(2);
    expect(result.failedHandles).toBe(1);
    expect(result.ingested).toBe(1); // somefounder still ingested
  });
});
