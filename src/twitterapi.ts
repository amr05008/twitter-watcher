import type { Env } from "./env";

export const TWITTERAPI_BASE = "https://api.twitterapi.io";

/** What one page of a twitterapi.io list endpoint yields. */
export interface PageExtract<T> {
  items: T[];
  hasNextPage: boolean;
  nextCursor: string | null;
}

/**
 * Drive a cursor-paginated twitterapi.io endpoint until `cap` items are collected
 * or there are no more pages. The `X-API-Key` header lives here so every caller
 * authenticates the same way. Throws on a non-ok response (loud failure) — the
 * same contract `runDiscover` / `refreshHandleIngest` rely on.
 *
 * `buildUrl(cursor)` is called with "" for the first page. `extract` pulls the
 * items + pagination fields out of the (endpoint-specific) JSON envelope.
 */
export async function fetchPaginated<T>(
  env: Env,
  buildUrl: (cursor: string) => string,
  extract: (json: unknown) => PageExtract<T>,
  cap: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: T[]; hasMore: boolean }> {
  const acc: T[] = [];
  let cursor = "";

  // Hard page guard: a runaway cursor (vendor bug) must not loop forever. At
  // pageSize 200 / cap 1000 a real run is ≤5 pages; 50 is comfortably generous.
  for (let page = 0; page < 50; page++) {
    const res = await fetchImpl(buildUrl(cursor), {
      headers: { "X-API-Key": env.TWITTERAPI_IO_KEY },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(`twitterapi.io ${res.status}: ${body}`);
    }

    const { items, hasNextPage, nextCursor } = extract(await res.json());
    acc.push(...items);

    if (acc.length >= cap) {
      return { items: acc.slice(0, cap), hasMore: hasNextPage || acc.length > cap };
    }
    if (!hasNextPage || !nextCursor) {
      return { items: acc, hasMore: false };
    }
    cursor = nextCursor;
  }

  return { items: acc.slice(0, cap), hasMore: true };
}

/**
 * Tweets come back top-level under `tweets` (advanced_search) or nested under
 * `data.tweets` (user/last_tweets); pagination fields sit alongside them in
 * whichever envelope is used.
 */
export function extractTweets(json: unknown): PageExtract<unknown> {
  const j = (json ?? {}) as {
    tweets?: unknown[];
    has_next_page?: boolean;
    next_cursor?: string;
    data?: { tweets?: unknown[]; has_next_page?: boolean; next_cursor?: string };
  };
  return {
    items: j.tweets ?? j.data?.tweets ?? [],
    hasNextPage: j.has_next_page ?? j.data?.has_next_page ?? false,
    nextCursor: j.next_cursor ?? j.data?.next_cursor ?? null,
  };
}

/** Followings/followers come back under `followings` (or `users` defensively). */
export function extractAccounts(json: unknown): PageExtract<unknown> {
  const j = (json ?? {}) as {
    followings?: unknown[];
    users?: unknown[];
    has_next_page?: boolean;
    next_cursor?: string;
    data?: { followings?: unknown[]; users?: unknown[] };
  };
  return {
    items: j.followings ?? j.users ?? j.data?.followings ?? j.data?.users ?? [],
    hasNextPage: j.has_next_page ?? false,
    nextCursor: j.next_cursor ?? null,
  };
}
