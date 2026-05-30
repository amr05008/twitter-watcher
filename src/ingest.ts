import type { Env } from "./env";
import { twitterAdapter } from "./adapters/twitter";
import { listWatchTargets, upsertPost } from "./db";
import type { WatchTarget } from "./adapters/types";

export interface IngestResult {
  handlesQueried: number;
  ingested: number;
  skippedNoTarget: number;
  skippedMalformed: number;
}

/**
 * Pull fresh tweets for every kind='handle' watch target via Apify run-sync.
 * Normalize, upsert into D1. Does not run any scoring or briefing — just ingest.
 *
 * Used by the daily cron (worker.scheduled) and by POST /api/refresh.
 *
 * Removes the dependency on Apify's webhook delivery, which is unreliable in
 * practice (see reference-apify-gotchas).
 */
export async function refreshHandleIngest(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestResult> {
  const targets = await listWatchTargets(env.DB, { kind: "handle" });

  if (targets.length === 0) {
    return { handlesQueried: 0, ingested: 0, skippedNoTarget: 0, skippedMalformed: 0 };
  }

  const handles = targets.map((t) => t.handle);

  const targetByHandle = new Map<string, WatchTarget>();
  for (const t of targets) {
    targetByHandle.set(t.handle.toLowerCase(), {
      id: t.id,
      source: t.source,
      kind: t.kind as "handle" | "search",
      handle: t.handle,
      weight: t.weight,
      addedAt: t.addedAt,
    });
  }

  const apifyUrl = `https://api.apify.com/v2/acts/${env.APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}`;
  const apifyRes = await fetchImpl(apifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      twitterHandles: handles,
      // Weekly window: ~40 tweets/handle to capture a full week (vs ~15 for daily).
      // Tune after observing real per-handle volume.
      maxItems: Math.max(50, handles.length * 40),
      sort: "Latest",
      tweetLanguage: "en",
    }),
  });

  if (!apifyRes.ok) {
    const text = await apifyRes.text().catch(() => "<unreadable>");
    throw new Error(`Apify ingest failed: ${apifyRes.status} ${text}`);
  }

  const rawTweets = (await apifyRes.json()) as unknown[];

  let ingested = 0;
  let skippedNoTarget = 0;
  let skippedMalformed = 0;

  for (const raw of rawTweets) {
    try {
      const r = raw as { author?: { userName?: string } };
      const author = r.author?.userName;
      if (typeof author !== "string" || author.length === 0) {
        skippedMalformed++;
        continue;
      }
      const target = targetByHandle.get(author.toLowerCase());
      if (!target) {
        skippedNoTarget++;
        continue;
      }
      const post = twitterAdapter.normalize(raw as any, target);
      await upsertPost(env.DB, target.id, post);
      ingested++;
    } catch {
      skippedMalformed++;
    }
  }

  return {
    handlesQueried: handles.length,
    ingested,
    skippedNoTarget,
    skippedMalformed,
  };
}
