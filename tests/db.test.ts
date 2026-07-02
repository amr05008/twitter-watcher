import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertPost,
  getUnsummarized,
  getLastBriefing,
  markSummarized,
  upsertWatchTarget,
  insertBriefing,
  listWatchTargets,
  deleteWatchTarget,
  prunePosts,
} from "../src/db";
import type { NormalizedPost } from "../src/adapters/types";
import { createFakeD1, type FakeD1 } from "./helpers/fake-d1";

describe("db", () => {
  let db: FakeD1;

  beforeEach(() => {
    db = createFakeD1();
  });

  async function seedHandle(handle: string) {
    await upsertWatchTarget(db as any, {
      source: "twitter",
      kind: "handle",
      handle,
    });
  }

  function makePost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
    return {
      source: "twitter",
      sourceId: "1234",
      author: "karpathy",
      timestamp: "2026-05-27T14:00:00.000Z",
      text: "hello",
      url: "https://twitter.com/karpathy/status/1234",
      raw: { hello: "world" },
      ...overrides,
    };
  }

  describe("upsertWatchTarget", () => {
    it("inserts a new target and returns alreadyExisted=false", async () => {
      const result = await upsertWatchTarget(db as any, {
        source: "twitter",
        kind: "handle",
        handle: "karpathy",
      });
      expect(result.alreadyExisted).toBe(false);
      expect(result.id).toBe("twitter:handle:karpathy");
    });

    it("is idempotent on (source, kind, handle) UNIQUE", async () => {
      const first = await upsertWatchTarget(db as any, {
        source: "twitter",
        kind: "handle",
        handle: "karpathy",
      });
      const second = await upsertWatchTarget(db as any, {
        source: "twitter",
        kind: "handle",
        handle: "karpathy",
      });
      expect(first.id).toBe(second.id);
      expect(second.alreadyExisted).toBe(true);

      const count = await db
        .prepare("SELECT COUNT(*) as n FROM watch_targets")
        .first<{ n: number }>();
      expect(count?.n).toBe(1);
    });
  });

  describe("upsertPost", () => {
    beforeEach(async () => {
      await seedHandle("karpathy");
    });

    it("inserts a new post under the right target_id", async () => {
      await upsertPost(db as any, "twitter:handle:karpathy", makePost());
      const row = await db
        .prepare("SELECT * FROM posts WHERE id = ?")
        .bind("twitter:1234")
        .first<{ id: string; target_id: string; author: string }>();
      expect(row?.id).toBe("twitter:1234");
      expect(row?.target_id).toBe("twitter:handle:karpathy");
      expect(row?.author).toBe("karpathy");
    });

    it("dedupes on (source, source_id) — INSERT OR IGNORE", async () => {
      await upsertPost(db as any, "twitter:handle:karpathy", makePost());
      await upsertPost(db as any, "twitter:handle:karpathy", makePost());
      const count = await db
        .prepare("SELECT COUNT(*) as n FROM posts")
        .first<{ n: number }>();
      expect(count?.n).toBe(1);
    });
  });

  describe("getUnsummarized + markSummarized", () => {
    beforeEach(async () => {
      await seedHandle("karpathy");
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "1" }));
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "2" }));
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "3" }));
    });

    it("returns all posts where summarized_in IS NULL", async () => {
      const posts = await getUnsummarized(db as any);
      expect(posts.length).toBe(3);
    });

    it("after markSummarized, returns only the unmarked posts", async () => {
      await markSummarized(db as any, ["twitter:1", "twitter:2"], "2026-05-27");
      const remaining = await getUnsummarized(db as any);
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.id).toBe("twitter:3");
    });

    it("is a no-op on an empty id list", async () => {
      await markSummarized(db as any, [], "2026-05-27");
      const remaining = await getUnsummarized(db as any);
      expect(remaining.length).toBe(3);
    });

    it("filters by posted_at when sincePostedAt is given", async () => {
      // Seed posts span the same timestamp; add an older and a newer one.
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "old", timestamp: "2026-05-20T00:00:00.000Z" }));
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "new", timestamp: "2026-05-30T00:00:00.000Z" }));

      const windowed = await getUnsummarized(db as any, {
        sincePostedAt: "2026-05-29T00:00:00.000Z",
      });
      // Only the "new" post (2026-05-30) is at/after the cutoff; the three
      // 2026-05-27 seeds and the 2026-05-20 "old" post are excluded.
      expect(windowed.map((p) => p.id)).toEqual(["twitter:new"]);

      // Without the option, all five are returned (back-compat).
      expect((await getUnsummarized(db as any)).length).toBe(5);
    });
  });

  describe("getLastBriefing", () => {
    it("returns null when there are no briefings", async () => {
      expect(await getLastBriefing(db as any)).toBeNull();
    });

    it("returns the most recent briefing by generated_at", async () => {
      await insertBriefing(db as any, {
        id: "2026-05-25",
        generatedAt: "2026-05-25T11:00:00.000Z",
        postCount: 2,
        output: "[]",
        trigger: "cron",
      });
      await insertBriefing(db as any, {
        id: "2026-05-27",
        generatedAt: "2026-05-27T11:00:00.000Z",
        postCount: 3,
        output: "[]",
        trigger: "cron",
      });
      const last = await getLastBriefing(db as any);
      expect(last?.id).toBe("2026-05-27");
      expect(last?.generated_at).toBe("2026-05-27T11:00:00.000Z");
    });
  });

  describe("listWatchTargets", () => {
    it("returns all targets sorted by handle", async () => {
      await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "zeta" });
      await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "alpha" });
      await upsertWatchTarget(db as any, { source: "twitter", kind: "search", handle: "betatopic" });

      const all = await listWatchTargets(db as any);
      expect(all.map((t) => t.handle)).toEqual(["alpha", "betatopic", "zeta"]);
    });

    it("filters by kind when specified", async () => {
      await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "zeta" });
      await upsertWatchTarget(db as any, { source: "twitter", kind: "search", handle: "betatopic" });

      const handles = await listWatchTargets(db as any, { kind: "handle" });
      expect(handles.length).toBe(1);
      expect(handles[0]?.kind).toBe("handle");
      expect(handles[0]?.handle).toBe("zeta");
    });
  });

  describe("deleteWatchTarget", () => {
    it("removes an existing target and returns removed=true", async () => {
      await upsertWatchTarget(db as any, { source: "twitter", kind: "handle", handle: "karpathy" });
      const res = await deleteWatchTarget(db as any, { source: "twitter", handle: "karpathy" });
      expect(res.removed).toBe(true);
      expect(res.id).toBe("twitter:handle:karpathy");

      const after = await listWatchTargets(db as any, { kind: "handle" });
      expect(after.length).toBe(0);
    });

    it("returns removed=false on a handle that does not exist", async () => {
      const res = await deleteWatchTarget(db as any, { source: "twitter", handle: "ghost" });
      expect(res.removed).toBe(false);
    });

    it("removes a target that still has ingested posts (FK cascade)", async () => {
      await seedHandle("karpathy");
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "a" }));
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "b" }));

      const res = await deleteWatchTarget(db as any, { source: "twitter", handle: "karpathy" });
      expect(res.removed).toBe(true);

      const targets = await listWatchTargets(db as any, { kind: "handle" });
      expect(targets.length).toBe(0);
      const posts = await db.prepare("SELECT COUNT(*) as n FROM posts").first<{ n: number }>();
      expect(posts?.n).toBe(0);
    });
  });

  describe("prunePosts", () => {
    beforeEach(async () => {
      await seedHandle("karpathy");
      const old = "2020-01-01T00:00:00.000Z";
      const recent = new Date().toISOString();

      // old + summarized → pruned
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "old-sum", timestamp: old }));
      // old + NOT summarized → pruned too (can never re-enter the cron window)
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "old-unsum", timestamp: old }));
      // recent + summarized → kept (inside the window)
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "recent-sum", timestamp: recent }));
      // recent + NOT summarized → kept (still a briefing candidate)
      await upsertPost(db as any, "twitter:handle:karpathy", makePost({ sourceId: "recent-unsum", timestamp: recent }));

      await markSummarized(db as any, ["twitter:old-sum", "twitter:recent-sum"], "2020-01-02");
    });

    it("deletes all posts older than the window and returns the count", async () => {
      const removed = await prunePosts(db as any, 30);
      expect(removed).toBe(2);

      const ids = (await db
        .prepare("SELECT id FROM posts ORDER BY id")
        .all<{ id: string }>()).results.map((r) => r.id);
      expect(ids).toEqual(["twitter:recent-sum", "twitter:recent-unsum"]);
    });

    it("prunes old unsummarized posts but keeps recent ones", async () => {
      await prunePosts(db as any, 30);
      const unsummarized = (await db
        .prepare("SELECT id FROM posts WHERE summarized_in IS NULL ORDER BY id")
        .all<{ id: string }>()).results.map((r) => r.id);
      expect(unsummarized).toEqual(["twitter:recent-unsum"]);
    });
  });

  describe("insertBriefing", () => {
    it("writes a briefing row with the expected shape", async () => {
      await insertBriefing(db as any, {
        id: "2026-05-27",
        generatedAt: "2026-05-27T11:00:00.000Z",
        postCount: 3,
        output: '{"some":"json"}',
        trigger: "cron",
      });
      const row = await db
        .prepare("SELECT * FROM briefings WHERE id = ?")
        .bind("2026-05-27")
        .first<{ id: string; trigger: string; post_count: number }>();
      expect(row?.id).toBe("2026-05-27");
      expect(row?.trigger).toBe("cron");
      expect(row?.post_count).toBe(3);
    });
  });
});
