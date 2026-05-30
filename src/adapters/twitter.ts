import type { NormalizedPost, SourceAdapter, WatchTarget } from "./types";
import type { Env } from "../env";
import { upsertPost } from "../db";

interface ApifyTweetAuthor {
  userName?: string;
  name?: string;
  id?: string;
}

interface ApifyTweet {
  type?: string;
  id?: string;
  url?: string;
  twitterUrl?: string;
  text?: string;
  fullText?: string;
  createdAt?: string;
  author?: ApifyTweetAuthor;
  isRetweet?: boolean;
  isReply?: boolean;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`twitter.normalize: missing required field "${field}"`);
  }
  return value;
}

// Twitter's API HTML-encodes ampersands and a few other chars in tweet text
// (e.g. "R&amp;D" rather than "R&D"). Discord renders these literally, so
// decode at the boundary before they hit D1.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function parseCreatedAt(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`twitter.normalize: unparseable createdAt "${raw}"`);
  }
  return d.toISOString();
}

export const twitterAdapter: SourceAdapter<ApifyTweet> = {
  name: "twitter",

  normalize(raw, _target): NormalizedPost {
    const id = requireString(raw.id, "id");
    const author = requireString(raw.author?.userName, "author.userName");
    const text = decodeHtmlEntities(requireString(raw.fullText ?? raw.text, "text"));
    const createdAt = requireString(raw.createdAt, "createdAt");
    const url =
      raw.twitterUrl ??
      raw.url ??
      `https://twitter.com/${author}/status/${id}`;

    return {
      source: "twitter",
      sourceId: id,
      author,
      timestamp: parseCreatedAt(createdAt),
      text,
      url,
      raw,
    };
  },

  async webhookHandler(req: Request, env: Env): Promise<Response> {
    return handleApifyWebhook(req, env);
  },
};

interface ApifyWebhookBody {
  resource?: { defaultDatasetId?: string; id?: string };
}

async function handleApifyWebhook(req: Request, env: Env): Promise<Response> {
  let body: ApifyWebhookBody;
  try {
    body = await req.json<ApifyWebhookBody>();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const datasetId = body.resource?.defaultDatasetId;
  if (!datasetId) {
    return new Response(JSON.stringify({ error: "missing resource.defaultDatasetId" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${env.APIFY_TOKEN}`;
  const dsRes = await fetch(datasetUrl);
  if (!dsRes.ok) {
    const text = await dsRes.text().catch(() => "<unreadable>");
    return new Response(JSON.stringify({ error: `apify dataset fetch ${dsRes.status}`, detail: text }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  const items = (await dsRes.json()) as ApifyTweet[];

  let ingested = 0;
  let skippedNoTarget = 0;
  let skippedMalformed = 0;

  for (const raw of items) {
    const author = raw.author?.userName;
    if (typeof author !== "string" || author.length === 0) {
      skippedMalformed++;
      continue;
    }

    const target = await env.DB
      .prepare(
        "SELECT id, source, kind, handle, weight, added_at FROM watch_targets WHERE source = ? AND kind = ? AND LOWER(handle) = LOWER(?)",
      )
      .bind("twitter", "handle", author)
      .first<{
        id: string;
        source: string;
        kind: string;
        handle: string;
        weight: number;
        added_at: string;
      }>();

    if (!target) {
      skippedNoTarget++;
      continue;
    }

    const targetForNormalize: WatchTarget = {
      id: target.id,
      source: target.source,
      kind: target.kind as "handle" | "search",
      handle: target.handle,
      weight: target.weight,
      addedAt: target.added_at,
    };

    try {
      const post = twitterAdapter.normalize(raw, targetForNormalize);
      await upsertPost(env.DB, target.id, post);
      ingested++;
    } catch {
      skippedMalformed++;
    }
  }

  return new Response(
    JSON.stringify({ ingested, skippedNoTarget, skippedMalformed, datasetId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
