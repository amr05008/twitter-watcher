import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRequest, type RouteHandlers, type BriefingResult } from "../src/router";
import type { Env } from "../src/env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as any,
    ANTHROPIC_API_KEY: "sk-test",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    TRIGGER_TOKEN: "right-token",
    TWITTERAPI_IO_KEY: "twapi-key",
    ...overrides,
  };
}

function makeHandlers(overrides: Partial<RouteHandlers> = {}): RouteHandlers {
  return {
    runBriefing: vi.fn(
      async (): Promise<BriefingResult> => ({ briefingId: "test-id", postCount: 0 }),
    ),
    runDiscover: vi.fn(async () => ({
      topic: "test",
      generatedAt: "2026-05-27T00:00:00.000Z",
      runId: "run-1",
      accounts: [],
    })),
    runPromote: vi.fn(async () => ({ id: "twitter:handle:x", alreadyExisted: false })),
    listWatchTargets: vi.fn(async () => ({ targets: [] })),
    deleteWatchTarget: vi.fn(async () => ({ id: "twitter:handle:x", removed: true })),
    refreshHandleIngest: vi.fn(async () => ({
      handlesQueried: 0,
      ingested: 0,
      failedHandles: 0,
      skippedMalformed: 0,
    })),
    ...overrides,
  };
}

describe("router /trigger", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/trigger", {
      method: "POST",
      headers: { "x-trigger-token": "wrong" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
    expect(handlers.runBriefing).not.toHaveBeenCalled();
  });

  it("returns 404 on missing token", async () => {
    const req = new Request("https://w.example/trigger", { method: "POST" });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
  });

  it("invokes runBriefing with trigger='manual' when token matches", async () => {
    const req = new Request("https://w.example/trigger", {
      method: "POST",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.runBriefing).toHaveBeenCalledWith(env, "manual");
  });
});

describe("router /api/discover", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/api/discover", {
      method: "POST",
      headers: { "x-trigger-token": "wrong" },
      body: JSON.stringify({ topic: "manychat" }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
    expect(handlers.runDiscover).not.toHaveBeenCalled();
  });

  it("invokes runDiscover with parsed body on right token", async () => {
    const req = new Request("https://w.example/api/discover", {
      method: "POST",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ topic: "manychat", lookbackDays: 5 }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.runDiscover).toHaveBeenCalledWith(env, {
      topic: "manychat",
      lookbackDays: 5,
    });
  });

  it("returns 400 when body is missing topic", async () => {
    const req = new Request("https://w.example/api/discover", {
      method: "POST",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ lookbackDays: 7 }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(400);
    expect(handlers.runDiscover).not.toHaveBeenCalled();
  });
});

describe("router /api/promote", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/api/promote", {
      method: "POST",
      headers: { "x-trigger-token": "wrong" },
      body: JSON.stringify({ handle: "karpathy" }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
  });

  it("invokes runPromote with default source='twitter' when not specified", async () => {
    const req = new Request("https://w.example/api/promote", {
      method: "POST",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle: "karpathy" }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.runPromote).toHaveBeenCalledWith(env, {
      handle: "karpathy",
      source: "twitter",
    });
  });

  it("returns 400 when body is missing handle", async () => {
    const req = new Request("https://w.example/api/promote", {
      method: "POST",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(400);
  });
});

describe("router /api/refresh", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/api/refresh", {
      method: "POST",
      headers: { "x-trigger-token": "wrong" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
    expect(handlers.refreshHandleIngest).not.toHaveBeenCalled();
  });

  it("invokes refreshHandleIngest on right token", async () => {
    const req = new Request("https://w.example/api/refresh", {
      method: "POST",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.refreshHandleIngest).toHaveBeenCalledOnce();
  });

  it("returns 404 on GET (POST only)", async () => {
    const req = new Request("https://w.example/api/refresh", {
      method: "GET",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
  });
});

describe("router /api/watch-targets GET", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "GET",
      headers: { "x-trigger-token": "wrong" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
    expect(handlers.listWatchTargets).not.toHaveBeenCalled();
  });

  it("invokes listWatchTargets on right token", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "GET",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.listWatchTargets).toHaveBeenCalledOnce();
  });
});

describe("router /api/watch-targets DELETE", () => {
  let env: Env;
  let handlers: RouteHandlers;

  beforeEach(() => {
    env = makeEnv();
    handlers = makeHandlers();
  });

  it("returns 404 on wrong token", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "DELETE",
      headers: { "x-trigger-token": "wrong" },
      body: JSON.stringify({ handle: "x" }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
  });

  it("invokes deleteWatchTarget with default source on right token", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "DELETE",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle: "karpathy" }),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(200);
    expect(handlers.deleteWatchTarget).toHaveBeenCalledWith(env, {
      handle: "karpathy",
      source: "twitter",
    });
  });

  it("returns 400 when body is missing handle", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "DELETE",
      headers: {
        "x-trigger-token": "right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(400);
  });

  it("returns 404 on POST (only GET / DELETE allowed)", async () => {
    const req = new Request("https://w.example/api/watch-targets", {
      method: "POST",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, env, handlers);
    expect(res.status).toBe(404);
  });
});

describe("router default", () => {
  it("returns 404 on unknown path", async () => {
    const req = new Request("https://w.example/nope", { method: "GET" });
    const res = await handleRequest(req, makeEnv(), makeHandlers());
    expect(res.status).toBe(404);
  });

  it("returns 404 on /trigger via GET (only POST allowed)", async () => {
    const req = new Request("https://w.example/trigger", {
      method: "GET",
      headers: { "x-trigger-token": "right-token" },
    });
    const res = await handleRequest(req, makeEnv(), makeHandlers());
    expect(res.status).toBe(404);
  });
});
