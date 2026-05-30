import type { Env } from "./env";
import type { DiscoverRequest, DiscoverResponse } from "./router";
import type { WatchTarget } from "./adapters/types";
import { twitterAdapter } from "./adapters/twitter";
import { suggestAccounts, type AnthropicAuthorAggregate } from "./anthropic";

interface AuthorBucket {
  handle: string;
  postCount: number;
  sample: string[];
}

export async function runDiscover(
  env: Env,
  body: DiscoverRequest,
  systemPrompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverResponse> {
  const lookbackDays = body.lookbackDays ?? 7;
  const maxResults = body.maxResults ?? 50;

  const apifyUrl = `https://api.apify.com/v2/acts/${env.APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}`;
  const apifyRes = await fetchImpl(apifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      searchTerms: [body.topic],
      maxItems: maxResults,
      sort: "Latest",
    }),
  });

  if (!apifyRes.ok) {
    const text = await apifyRes.text().catch(() => "<unreadable>");
    throw new Error(`Apify search failed: ${apifyRes.status} ${text}`);
  }

  const rawTweets = (await apifyRes.json()) as unknown[];

  const target: WatchTarget = {
    id: `twitter:search:${body.topic}`,
    source: "twitter",
    kind: "search",
    handle: body.topic,
    weight: 1.0,
    addedAt: new Date().toISOString(),
  };

  const buckets = new Map<string, AuthorBucket>();
  for (const raw of rawTweets) {
    try {
      const post = twitterAdapter.normalize(raw as any, target);
      let bucket = buckets.get(post.author);
      if (!bucket) {
        bucket = { handle: post.author, postCount: 0, sample: [] };
        buckets.set(post.author, bucket);
      }
      bucket.postCount += 1;
      // TODO: samples are first-3-encountered, not best-3. Consider ranking by topic-keyword match or length.
      if (bucket.sample.length < 3) bucket.sample.push(post.text);
    } catch {
      // Skip malformed entries; Apify occasionally emits non-tweet items
    }
  }

  const authors: AnthropicAuthorAggregate[] = [...buckets.values()]
    .sort((a, b) => b.postCount - a.postCount)
    .slice(0, 25);

  if (authors.length === 0) {
    return {
      topic: body.topic,
      generatedAt: new Date().toISOString(),
      runId: crypto.randomUUID(),
      accounts: [],
    };
  }

  const suggestions = await suggestAccounts(
    body.topic,
    authors,
    env,
    systemPrompt,
    fetchImpl,
    lookbackDays,
  );

  return {
    topic: body.topic,
    generatedAt: new Date().toISOString(),
    runId: crypto.randomUUID(),
    accounts: suggestions.map((s) => {
      const normalized = s.handle.replace(/^@/, "").toLowerCase();
      const bucket = [...buckets.values()].find(
        (b) => b.handle.toLowerCase() === normalized,
      );
      // TODO: samples are returned per-request only — not persisted to D1. If trend analysis becomes a need, add a discover_samples table.
      return {
        handle: bucket?.handle ?? s.handle.replace(/^@/, ""),
        rationale: s.rationale,
        signalScore: s.signalScore,
        postCount: bucket?.postCount ?? 0,
        samples: bucket?.sample ?? [],
      };
    }),
  };
}
