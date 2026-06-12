import type { Env } from "./env";
import { twitterAdapter } from "./adapters/twitter";
import { listWatchTargets, upsertPost } from "./db";
import type { WatchTarget } from "./adapters/types";

export interface IngestResult {
  handlesQueried: number;
  ingested: number;
  /** Handles whose fetch failed (network/4xx/5xx) — isolated, run continues. */
  failedHandles: number;
  /** Individual tweets that couldn't be normalized. */
  skippedMalformed: number;
}

const TWITTERAPI_BASE = "https://api.twitterapi.io";

interface TimelineResponse {
  data?: { tweets?: unknown[] };
  tweets?: unknown[];
}

/**
 * Pull fresh tweets for every kind='handle' watch target from twitterapi.io and
 * upsert them into D1. One request per handle (twitterapi.io is per-user, not
 * batch); a single handle failing is isolated so the rest of the run proceeds.
 *
 * Used by the daily cron (worker.scheduled) and by POST /api/refresh.
 */
export async function refreshHandleIngest(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestResult> {
  const targets = await listWatchTargets(env.DB, { kind: "handle" });

  if (targets.length === 0) {
    return { handlesQueried: 0, ingested: 0, failedHandles: 0, skippedMalformed: 0 };
  }

  let ingested = 0;
  let failedHandles = 0;
  let skippedMalformed = 0;
  let lastError: unknown;

  for (const t of targets) {
    const target: WatchTarget = {
      id: t.id,
      source: t.source,
      kind: t.kind as "handle" | "search",
      handle: t.handle,
      weight: t.weight,
      addedAt: t.addedAt,
    };

    try {
      const url = `${TWITTERAPI_BASE}/twitter/user/last_tweets?userName=${encodeURIComponent(t.handle)}`;
      const res = await fetchImpl(url, {
        headers: { "X-API-Key": env.TWITTERAPI_IO_KEY },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable>");
        throw new Error(`twitterapi.io ${res.status}: ${body}`);
      }

      const json = (await res.json()) as TimelineResponse;
      const tweets = json.data?.tweets ?? json.tweets ?? [];

      for (const raw of tweets) {
        try {
          const post = twitterAdapter.normalize(raw as never, target);
          await upsertPost(env.DB, target.id, post);
          ingested++;
        } catch {
          // Non-tweet item or missing fields — skip, keep going.
          skippedMalformed++;
        }
      }
    } catch (err) {
      // Per-handle isolation: one handle's failure (network, rate limit, bad
      // handle) must not sink the whole run. Log and continue.
      failedHandles++;
      lastError = err;
      console.error(
        `refresh: handle @${t.handle} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Total failure (every handle errored) means the source itself is down — a
  // dead API key, an outage, twitterapi.io changing its shape. Throw so the
  // scheduled handler can post a loud failure alert instead of going quiet.
  // (A partial failure is left isolated — the run still surfaces what it got.)
  if (failedHandles === targets.length) {
    throw new Error(
      `all ${targets.length} watched handle(s) failed to fetch from twitterapi.io (last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }

  return {
    handlesQueried: targets.length,
    ingested,
    failedHandles,
    skippedMalformed,
  };
}
