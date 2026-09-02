import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CONFIRMATION_REQUIRED,
  EXIT_HTTP,
  EXIT_USAGE,
  runCli,
} from "../src/cli";
import { TwitterWatcherHttpError } from "../src/client";

function setup(overrides: Record<string, unknown> = {}) {
  const client = {
    runBriefing: vi.fn(async () => ({ briefingId: "b1", postCount: 2 })),
    refreshTweets: vi.fn(async () => ({ handlesQueried: 2, ingested: 3, failedHandles: 0, skippedMalformed: 0 })),
    discoverAccounts: vi.fn(async () => ({ topic: "ai", generatedAt: "now", runId: "r1", accounts: [] })),
    searchTweets: vi.fn(async () => ({ query: "ai", queryType: "Top", fetched: 0, hasMore: false, tweets: [] })),
    getAccountTweets: vi.fn(async () => ({ handle: "karpathy", fetched: 0, hasMore: false, tweets: [] })),
    getAccountFollowing: vi.fn(async () => ({ handle: "karpathy", fetched: 0, hasMore: false, accounts: [] })),
    listWatchedAccounts: vi.fn(async () => ({ targets: [] })),
    addWatchedAccount: vi.fn(async () => ({ id: "twitter:handle:x", alreadyExisted: false })),
    removeWatchedAccount: vi.fn(async () => ({ id: "twitter:handle:x", removed: true })),
    ...overrides,
  };
  const out: string[] = [];
  const err: string[] = [];
  const clientFactory = vi.fn(() => client as any);
  const deps = {
    env: {
      TWITTER_WATCHER_BASE_URL: "https://watcher.example.dev",
      TWITTER_WATCHER_TRIGGER_TOKEN: "secret-token",
    },
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    clientFactory,
  };
  return { client, out, err, clientFactory, deps };
}

function parsed(out: string[]): any {
  return JSON.parse(out.join(""));
}

describe("twitter-watcher CLI read commands", () => {
  it("maps search-tweets arguments and emits JSON", async () => {
    const s = setup();
    expect(await runCli(["search-tweets", "--query", "claude code", "--type", "Top", "--max", "50"], s.deps)).toBe(0);
    expect(s.client.searchTweets).toHaveBeenCalledWith({ query: "claude code", queryType: "Top", maxTweets: 50 });
    expect(parsed(s.out).hasMore).toBe(false);
    expect(s.err).toEqual([]);
  });

  it("maps account-tweets and normalizes a leading @", async () => {
    const s = setup();
    expect(await runCli(["account-tweets", "--handle", "@karpathy", "--max", "25"], s.deps)).toBe(0);
    expect(s.client.getAccountTweets).toHaveBeenCalledWith({ handle: "karpathy", maxTweets: 25 });
  });

  it("maps account-following", async () => {
    const s = setup();
    expect(await runCli(["account-following", "--handle", "karpathy", "--max", "200"], s.deps)).toBe(0);
    expect(s.client.getAccountFollowing).toHaveBeenCalledWith({ handle: "karpathy", maxAccounts: 200 });
  });

  it("maps discover", async () => {
    const s = setup();
    expect(await runCli(["discover", "--topic", "AI agents", "--lookback-days", "7"], s.deps)).toBe(0);
    expect(s.client.discoverAccounts).toHaveBeenCalledWith({ topic: "AI agents", lookbackDays: 7 });
  });

  it("maps watch-list", async () => {
    const s = setup();
    expect(await runCli(["watch-list"], s.deps)).toBe(0);
    expect(s.client.listWatchedAccounts).toHaveBeenCalledOnce();
  });
});

describe("twitter-watcher CLI side-effect guards", () => {
  it.each([
    ["refresh", "POST", "/api/refresh"],
    ["briefing", "POST", "/trigger"],
  ])("dry-runs %s without credentials or a client", async (command, method, path) => {
    const s = setup();
    const deps = { ...s.deps, env: {} };
    expect(await runCli([command, "--dry-run"], deps)).toBe(0);
    expect(parsed(s.out)).toEqual({ dryRun: true, method, path });
    expect(s.clientFactory).not.toHaveBeenCalled();
  });

  it("dry-runs watch-add with a normalized body", async () => {
    const s = setup();
    expect(await runCli(["watch-add", "--handle", "@karpathy", "--dry-run"], s.deps)).toBe(0);
    expect(parsed(s.out)).toEqual({
      dryRun: true,
      method: "POST",
      path: "/api/promote",
      body: { handle: "karpathy", source: "twitter" },
    });
    expect(s.clientFactory).not.toHaveBeenCalled();
  });

  it.each(["refresh", "briefing"])("requires confirmation for %s", async (command) => {
    const s = setup();
    expect(await runCli([command], s.deps)).toBe(EXIT_CONFIRMATION_REQUIRED);
    expect(s.clientFactory).not.toHaveBeenCalled();
    expect(s.err.join("")).toContain("--dry-run");
  });

  it("executes every write command only with --yes", async () => {
    const refresh = setup();
    expect(await runCli(["refresh", "--yes"], refresh.deps)).toBe(0);
    expect(refresh.client.refreshTweets).toHaveBeenCalledOnce();

    const briefing = setup();
    expect(await runCli(["briefing", "--yes"], briefing.deps)).toBe(0);
    expect(briefing.client.runBriefing).toHaveBeenCalledOnce();

    const add = setup();
    expect(await runCli(["watch-add", "--handle", "x", "--yes"], add.deps)).toBe(0);
    expect(add.client.addWatchedAccount).toHaveBeenCalledWith({ handle: "x" });

    const remove = setup();
    expect(await runCli(["watch-remove", "--handle", "x", "--yes"], remove.deps)).toBe(0);
    expect(remove.client.removeWatchedAccount).toHaveBeenCalledWith({ handle: "x" });
  });
});

describe("twitter-watcher CLI validation and errors", () => {
  it("prints help without credentials", async () => {
    const s = setup();
    expect(await runCli(["--help"], { ...s.deps, env: {} })).toBe(0);
    expect(s.out.join("")).toContain("search-tweets");
    expect(s.clientFactory).not.toHaveBeenCalled();
  });

  it("rejects invalid ranges before creating a client", async () => {
    const s = setup();
    expect(await runCli(["search-tweets", "--query", "ai", "--max", "1001"], s.deps)).toBe(EXIT_USAGE);
    expect(s.clientFactory).not.toHaveBeenCalled();
  });

  it("rejects invalid handles", async () => {
    const s = setup();
    expect(await runCli(["account-tweets", "--handle", "not a handle"], s.deps)).toBe(EXIT_USAGE);
    expect(s.clientFactory).not.toHaveBeenCalled();
  });

  it("names missing variables without exposing values", async () => {
    const s = setup();
    expect(await runCli(["watch-list"], { ...s.deps, env: {} })).toBe(EXIT_USAGE);
    expect(s.err.join("")).toContain("TWITTER_WATCHER_BASE_URL");
    expect(s.err.join("")).toContain("TWITTER_WATCHER_TRIGGER_TOKEN");
  });

  it("redacts the trigger token from HTTP errors", async () => {
    const s = setup({
      listWatchedAccounts: vi.fn(async () => {
        throw new TwitterWatcherHttpError("GET", "/api/watch-targets", 500, "upstream echoed secret-token");
      }),
    });
    expect(await runCli(["watch-list"], s.deps)).toBe(EXIT_HTTP);
    expect(s.err.join("")).toContain("[redacted]");
    expect(s.err.join("")).not.toContain("secret-token");
  });

  it("rejects credential-bearing base URLs", async () => {
    const s = setup();
    const env = {
      ...s.deps.env,
      TWITTER_WATCHER_BASE_URL: "https://user:password@watcher.example.dev",
    };
    expect(await runCli(["watch-list"], { ...s.deps, env })).toBe(EXIT_USAGE);
    expect(s.clientFactory).not.toHaveBeenCalled();
  });
});
