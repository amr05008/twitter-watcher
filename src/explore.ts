import type { Env } from "./env";
import type { WatchTarget } from "./adapters/types";
import { twitterAdapter } from "./adapters/twitter";
import {
  TWITTERAPI_BASE,
  extractAccounts,
  extractTweets,
  fetchPaginated,
} from "./twitterapi";

// Interactive, read-only exploration primitives. Unlike `discover` (which has
// Claude distill search results server-side into ~3 accounts), these return the
// RAW tweets/accounts so a Claude Code session can read and theme them directly.
// Nothing here touches D1 — zero risk to the briefing pipeline.

/** A tweet enriched with engagement + author signal NormalizedPost drops. */
export interface ExploreTweet {
  id: string;
  author: string; // handle
  authorName: string | null;
  authorFollowers: number | null;
  text: string;
  url: string;
  createdAt: string; // ISO 8601
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  isReply: boolean;
  isRetweet: boolean;
}

/** An account from a followings/followers list, with the bio + reach signal. */
export interface ExploreAccount {
  userName: string;
  name: string | null;
  followers: number | null;
  following: number | null;
  description: string | null;
  location: string | null;
  statusesCount: number | null;
}

export interface SearchTweetsRequest {
  query: string;
  queryType?: "Latest" | "Top";
  maxTweets?: number;
}
export interface SearchTweetsResponse {
  query: string;
  queryType: "Latest" | "Top";
  fetched: number;
  hasMore: boolean;
  tweets: ExploreTweet[];
}

export interface AccountTweetsRequest {
  handle: string;
  maxTweets?: number;
}
export interface AccountTweetsResponse {
  handle: string;
  fetched: number;
  hasMore: boolean;
  tweets: ExploreTweet[];
}

export interface AccountFollowingRequest {
  handle: string;
  maxAccounts?: number;
}
export interface AccountFollowingResponse {
  handle: string;
  fetched: number;
  hasMore: boolean;
  accounts: ExploreAccount[];
}

const MAX_TWEETS = 1000;
const DEFAULT_TWEETS = 150;
const MAX_ACCOUNTS = 1000;
const DEFAULT_ACCOUNTS = 200;
const FOLLOWINGS_PAGE_SIZE = 200;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

// A dummy target — twitterAdapter.normalize requires one but ignores it for the
// fields we use. Exploration tweets aren't tied to a watch target.
const EXPLORE_TARGET: WatchTarget = {
  id: "twitter:explore",
  source: "twitter",
  kind: "search",
  handle: "explore",
  weight: 1.0,
  addedAt: "1970-01-01T00:00:00.000Z",
};

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toExploreTweet(raw: unknown): ExploreTweet {
  // Reuse the adapter for the base fields (author/text/url/timestamp/id + its
  // HTML-entity decode); it throws on malformed items so the caller can skip.
  const base = twitterAdapter.normalize(raw as never, EXPLORE_TARGET);
  const r = raw as {
    author?: { name?: string; followers?: number };
    likeCount?: number;
    retweetCount?: number;
    replyCount?: number;
    viewCount?: number;
    isReply?: boolean;
    retweeted_tweet?: unknown;
    text?: string;
    fullText?: string;
  };
  return {
    id: base.sourceId,
    author: base.author,
    authorName: r.author?.name ?? null,
    authorFollowers: toNumber(r.author?.followers),
    text: base.text,
    url: base.url,
    createdAt: base.timestamp,
    likeCount: toNumber(r.likeCount),
    retweetCount: toNumber(r.retweetCount),
    replyCount: toNumber(r.replyCount),
    viewCount: toNumber(r.viewCount),
    isReply: r.isReply === true,
    isRetweet: r.retweeted_tweet != null || /^RT @/.test(r.fullText ?? r.text ?? ""),
  };
}

function toExploreAccount(raw: unknown): ExploreAccount {
  // twitterapi.io's user objects are mostly camelCase (the captured timeline
  // fixture uses author.followers), but the docs schema is ambiguous on a few
  // count fields — accept the snake_case spelling too so a naming mismatch
  // degrades to null silently on at most one field rather than wiping the
  // bio/reach signal that "similar accounts" relies on.
  const r = (raw ?? {}) as {
    userName?: string;
    screen_name?: string;
    name?: string;
    followers?: number;
    followers_count?: number;
    following?: number;
    following_count?: number;
    description?: string;
    location?: string;
    statusesCount?: number;
    statuses_count?: number;
  };
  const userName = r.userName ?? r.screen_name;
  if (typeof userName !== "string" || userName.length === 0) {
    throw new Error("explore: account missing userName");
  }
  return {
    userName,
    name: r.name ?? null,
    followers: toNumber(r.followers ?? r.followers_count),
    following: toNumber(r.following ?? r.following_count),
    description: r.description ?? null,
    location: r.location ?? null,
    statusesCount: toNumber(r.statusesCount ?? r.statuses_count),
  };
}

/** Drop a leading '@' so pasted handles like "@karpathy" still resolve. */
function normalizeHandle(handle: string): string {
  return handle.replace(/^@+/, "");
}

/** Map raw items, skipping ones that fail to normalize (non-tweet/junk rows). */
function mapSafe<T>(items: unknown[], fn: (raw: unknown) => T): T[] {
  const out: T[] = [];
  for (const item of items) {
    try {
      out.push(fn(item));
    } catch {
      // Skip malformed entries; the API occasionally returns non-tweet items.
    }
  }
  return out;
}

/**
 * Paginated advanced search. `query` accepts full Twitter advanced-search
 * syntax (from:, OR, -filter:replies, min_faves:, since_time:/until_time:).
 */
export async function searchTweets(
  env: Env,
  body: SearchTweetsRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchTweetsResponse> {
  const queryType = body.queryType === "Top" ? "Top" : "Latest";
  const cap = clamp(body.maxTweets, DEFAULT_TWEETS, MAX_TWEETS);

  const { items, hasMore } = await fetchPaginated(
    env,
    (cursor) =>
      `${TWITTERAPI_BASE}/twitter/tweet/advanced_search?query=${encodeURIComponent(
        body.query,
      )}&queryType=${queryType}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    extractTweets,
    cap,
    fetchImpl,
  );

  const tweets = mapSafe(items, toExploreTweet);
  return { query: body.query, queryType, fetched: tweets.length, hasMore, tweets };
}

/** Paginated raw timeline for ANY handle (not just watched accounts). */
export async function getAccountTweets(
  env: Env,
  body: AccountTweetsRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountTweetsResponse> {
  const cap = clamp(body.maxTweets, DEFAULT_TWEETS, MAX_TWEETS);
  const handle = normalizeHandle(body.handle);

  const { items, hasMore } = await fetchPaginated(
    env,
    (cursor) =>
      `${TWITTERAPI_BASE}/twitter/user/last_tweets?userName=${encodeURIComponent(
        handle,
      )}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    extractTweets,
    cap,
    fetchImpl,
  );

  const tweets = mapSafe(items, toExploreTweet);
  return { handle, fetched: tweets.length, hasMore, tweets };
}

/** Paginated followings (curated-peer signal) with bios + follower counts. */
export async function getAccountFollowing(
  env: Env,
  body: AccountFollowingRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountFollowingResponse> {
  const cap = clamp(body.maxAccounts, DEFAULT_ACCOUNTS, MAX_ACCOUNTS);
  const handle = normalizeHandle(body.handle);

  const { items, hasMore } = await fetchPaginated(
    env,
    (cursor) =>
      `${TWITTERAPI_BASE}/twitter/user/followings?userName=${encodeURIComponent(
        handle,
      )}&pageSize=${FOLLOWINGS_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    extractAccounts,
    cap,
    fetchImpl,
  );

  const accounts = mapSafe(items, toExploreAccount);
  return { handle, fetched: accounts.length, hasMore, accounts };
}
