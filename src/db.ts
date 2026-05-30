import type { D1Database } from "@cloudflare/workers-types";
import type { NormalizedPost } from "./adapters/types";

export interface WatchTargetRow {
  id: string;
  source: string;
  kind: string;
  handle: string;
  weight: number;
  added_at: string;
}

export interface PostRow {
  id: string;
  source: string;
  source_id: string;
  target_id: string;
  author: string;
  posted_at: string;
  text: string;
  url: string;
  raw: string;
  summarized_in: string | null;
}

export interface BriefingRow {
  id: string;
  generated_at: string;
  post_count: number;
  output: string;
  trigger: string;
}

export interface UpsertWatchTargetInput {
  source: string;
  kind: "handle" | "search";
  handle: string;
  weight?: number;
}

export interface UpsertWatchTargetResult {
  id: string;
  alreadyExisted: boolean;
}

export async function upsertWatchTarget(
  db: D1Database,
  input: UpsertWatchTargetInput,
): Promise<UpsertWatchTargetResult> {
  const id = `${input.source}:${input.kind}:${input.handle}`;
  const existing = await db
    .prepare("SELECT id FROM watch_targets WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (existing) return { id, alreadyExisted: true };

  await db
    .prepare(
      "INSERT INTO watch_targets (id, source, kind, handle, weight, added_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      input.source,
      input.kind,
      input.handle,
      input.weight ?? 1.0,
      new Date().toISOString(),
    )
    .run();

  return { id, alreadyExisted: false };
}

export interface WatchTargetView {
  id: string;
  source: string;
  kind: string;
  handle: string;
  weight: number;
  addedAt: string;
}

export async function listWatchTargets(
  db: D1Database,
  filter: { kind?: "handle" | "search" } = {},
): Promise<WatchTargetView[]> {
  const sql = filter.kind
    ? "SELECT id, source, kind, handle, weight, added_at FROM watch_targets WHERE kind = ? ORDER BY handle"
    : "SELECT id, source, kind, handle, weight, added_at FROM watch_targets ORDER BY handle";
  const stmt = filter.kind ? db.prepare(sql).bind(filter.kind) : db.prepare(sql);
  const result = await stmt.all<WatchTargetRow>();
  return result.results.map((r) => ({
    id: r.id,
    source: r.source,
    kind: r.kind,
    handle: r.handle,
    weight: r.weight,
    addedAt: r.added_at,
  }));
}

export interface DeleteWatchTargetInput {
  source: string;
  handle: string;
}

export interface DeleteWatchTargetResult {
  id: string;
  removed: boolean;
}

export async function deleteWatchTarget(
  db: D1Database,
  input: DeleteWatchTargetInput,
): Promise<DeleteWatchTargetResult> {
  const id = `${input.source}:handle:${input.handle}`;
  const existing = await db
    .prepare("SELECT id FROM watch_targets WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return { id, removed: false };
  await db.prepare("DELETE FROM watch_targets WHERE id = ?").bind(id).run();
  return { id, removed: true };
}

export async function upsertPost(
  db: D1Database,
  targetId: string,
  post: NormalizedPost,
): Promise<void> {
  const id = `${post.source}:${post.sourceId}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO posts
         (id, source, source_id, target_id, author, posted_at, text, url, raw, summarized_in)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      post.source,
      post.sourceId,
      targetId,
      post.author,
      post.timestamp,
      post.text,
      post.url,
      JSON.stringify(post.raw),
    )
    .run();
}

export async function getUnsummarized(db: D1Database): Promise<PostRow[]> {
  const result = await db
    .prepare(
      `SELECT id, source, source_id, target_id, author, posted_at, text, url, raw, summarized_in
         FROM posts
        WHERE summarized_in IS NULL
        ORDER BY posted_at DESC`,
    )
    .all<PostRow>();
  return result.results;
}

export async function markSummarized(
  db: D1Database,
  postIds: string[],
  briefingId: string,
): Promise<void> {
  if (postIds.length === 0) return;
  const placeholders = postIds.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE posts SET summarized_in = ? WHERE id IN (${placeholders})`,
    )
    .bind(briefingId, ...postIds)
    .run();
}

export interface InsertBriefingInput {
  id: string;
  generatedAt: string;
  postCount: number;
  output: string;
  trigger: "cron" | "manual";
}

export async function insertBriefing(
  db: D1Database,
  input: InsertBriefingInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO briefings (id, generated_at, post_count, output, trigger) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.generatedAt, input.postCount, input.output, input.trigger)
    .run();
}

/**
 * Delete already-summarized posts older than `olderThanDays`. Keeps the posts
 * table lean for a long-running, set-and-forget tool. Unsummarized posts are
 * never pruned (they may still be briefed). Briefings are retained as history.
 *
 * Returns the number of rows removed.
 */
export async function prunePosts(
  db: D1Database,
  olderThanDays = 30,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM posts
        WHERE summarized_in IS NOT NULL
          AND posted_at < datetime('now', ?)`,
    )
    .bind(`-${olderThanDays} days`)
    .run();
  return result.meta?.changes ?? 0;
}
