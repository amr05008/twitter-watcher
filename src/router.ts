import type { Env } from "./env";
import type {
  AccountFollowingRequest,
  AccountFollowingResponse,
  AccountTweetsRequest,
  AccountTweetsResponse,
  SearchTweetsRequest,
  SearchTweetsResponse,
} from "./explore";

export type {
  AccountFollowingRequest,
  AccountFollowingResponse,
  AccountTweetsRequest,
  AccountTweetsResponse,
  SearchTweetsRequest,
  SearchTweetsResponse,
};

export interface DiscoverRequest {
  topic: string;
  lookbackDays?: number;
  maxResults?: number;
}

export interface DiscoverResponse {
  topic: string;
  generatedAt: string;
  runId: string;
  accounts: Array<{
    handle: string;
    rationale: string;
    signalScore: number;
    postCount: number;
    samples: string[];
  }>;
}

export interface PromoteRequest {
  handle: string;
  source: string;
}

export interface PromoteResponse {
  id: string;
  alreadyExisted: boolean;
}

export type BriefingResult =
  | { briefingId: string; postCount: number }
  | { skipped: true; briefingId: string }
  | { healthPing: true; briefingId: string };

export interface ListWatchTargetsResponse {
  targets: Array<{
    id: string;
    source: string;
    kind: string;
    handle: string;
    weight: number;
    addedAt: string;
  }>;
}

export interface DeleteWatchTargetRequest {
  handle: string;
  source: string;
}

export interface DeleteWatchTargetResponse {
  id: string;
  removed: boolean;
}

export interface RefreshResponse {
  handlesQueried: number;
  ingested: number;
  failedHandles: number;
  skippedMalformed: number;
}

export interface RouteHandlers {
  runBriefing(env: Env, trigger: "cron" | "manual"): Promise<BriefingResult>;
  runDiscover(env: Env, body: DiscoverRequest): Promise<DiscoverResponse>;
  runPromote(env: Env, body: PromoteRequest): Promise<PromoteResponse>;
  listWatchTargets(env: Env): Promise<ListWatchTargetsResponse>;
  deleteWatchTarget(env: Env, body: DeleteWatchTargetRequest): Promise<DeleteWatchTargetResponse>;
  refreshHandleIngest(env: Env): Promise<RefreshResponse>;
  searchTweets(env: Env, body: SearchTweetsRequest): Promise<SearchTweetsResponse>;
  getAccountTweets(env: Env, body: AccountTweetsRequest): Promise<AccountTweetsResponse>;
  getAccountFollowing(env: Env, body: AccountFollowingRequest): Promise<AccountFollowingResponse>;
}

function tokenOk(req: Request, expected: string): boolean {
  const got = req.headers.get("x-trigger-token");
  if (!got || got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function badRequest(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export async function handleRequest(
  req: Request,
  env: Env,
  handlers: RouteHandlers,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // /api/watch-targets supports GET (list) and DELETE (remove)
  if (path === "/api/watch-targets") {
    if (req.method === "GET") {
      if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
      const result = await handlers.listWatchTargets(env);
      return jsonResponse(result);
    }
    if (req.method === "DELETE") {
      if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
      const body = await parseJsonBody<Partial<DeleteWatchTargetRequest>>(req);
      if (!body || typeof body.handle !== "string" || body.handle.length === 0) {
        return badRequest("missing required field 'handle'");
      }
      const result = await handlers.deleteWatchTarget(env, {
        handle: body.handle,
        source: typeof body.source === "string" && body.source.length > 0 ? body.source : "twitter",
      });
      return jsonResponse(result);
    }
    return notFound();
  }

  // All other token-gated routes require POST
  if (req.method !== "POST") return notFound();

  if (path === "/trigger") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const result = await handlers.runBriefing(env, "manual");
    return jsonResponse(result);
  }

  if (path === "/api/refresh") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const result = await handlers.refreshHandleIngest(env);
    return jsonResponse(result);
  }

  if (path === "/api/discover") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const body = await parseJsonBody<Partial<DiscoverRequest>>(req);
    if (!body || typeof body.topic !== "string" || body.topic.length === 0) {
      return badRequest("missing required field 'topic'");
    }
    const result = await handlers.runDiscover(env, {
      topic: body.topic,
      ...(typeof body.lookbackDays === "number" && { lookbackDays: body.lookbackDays }),
      ...(typeof body.maxResults === "number" && { maxResults: body.maxResults }),
    });
    return jsonResponse(result);
  }

  if (path === "/api/search-tweets") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const body = await parseJsonBody<Partial<SearchTweetsRequest>>(req);
    if (!body || typeof body.query !== "string" || body.query.length === 0) {
      return badRequest("missing required field 'query'");
    }
    const result = await handlers.searchTweets(env, {
      query: body.query,
      ...(body.queryType === "Top" || body.queryType === "Latest"
        ? { queryType: body.queryType }
        : {}),
      ...(typeof body.maxTweets === "number" && { maxTweets: body.maxTweets }),
    });
    return jsonResponse(result);
  }

  if (path === "/api/account-tweets") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const body = await parseJsonBody<Partial<AccountTweetsRequest>>(req);
    if (!body || typeof body.handle !== "string" || body.handle.length === 0) {
      return badRequest("missing required field 'handle'");
    }
    const result = await handlers.getAccountTweets(env, {
      handle: body.handle,
      ...(typeof body.maxTweets === "number" && { maxTweets: body.maxTweets }),
    });
    return jsonResponse(result);
  }

  if (path === "/api/account-following") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const body = await parseJsonBody<Partial<AccountFollowingRequest>>(req);
    if (!body || typeof body.handle !== "string" || body.handle.length === 0) {
      return badRequest("missing required field 'handle'");
    }
    const result = await handlers.getAccountFollowing(env, {
      handle: body.handle,
      ...(typeof body.maxAccounts === "number" && { maxAccounts: body.maxAccounts }),
    });
    return jsonResponse(result);
  }

  if (path === "/api/promote") {
    if (!tokenOk(req, env.TRIGGER_TOKEN)) return notFound();
    const body = await parseJsonBody<Partial<PromoteRequest>>(req);
    if (!body || typeof body.handle !== "string" || body.handle.length === 0) {
      return badRequest("missing required field 'handle'");
    }
    const result = await handlers.runPromote(env, {
      handle: body.handle,
      source: typeof body.source === "string" && body.source.length > 0 ? body.source : "twitter",
    });
    return jsonResponse(result);
  }

  return notFound();
}
