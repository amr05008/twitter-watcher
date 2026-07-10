import { describe, it, expect, vi } from "vitest";
import {
  selectTopSignal,
  suggestAccounts,
  type AnthropicPostInput,
  type AnthropicAuthorAggregate,
} from "../src/anthropic";

function fakeFetchOk(toolName: string, toolInput: unknown, stopReason = "tool_use") {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        stop_reason: stopReason,
        content: [
          {
            type: "tool_use",
            name: toolName,
            input: toolInput,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const env = { ANTHROPIC_API_KEY: "sk-test" };

describe("anthropic.selectTopSignal", () => {
  const posts: AnthropicPostInput[] = [
    {
      index: 1,
      source: "twitter",
      author: "karpathy",
      timestamp: "2026-05-27T14:00:00.000Z",
      text: "First post",
      url: "https://x.com/karpathy/status/1",
    },
    {
      index: 2,
      source: "twitter",
      author: "swyx",
      timestamp: "2026-05-27T13:00:00.000Z",
      text: "Second post",
      url: "https://x.com/swyx/status/2",
    },
  ];

  it("sends a tool-use request with select_top_signal tool", async () => {
    const fakeFetch = fakeFetchOk("select_top_signal", {
      picks: [
        { rank: 1, postIndex: 1, rationale: "novel claim" },
        { rank: 2, postIndex: 2, rationale: "useful summary" },
        { rank: 3, postIndex: 1, rationale: "fallback" },
      ],
    });
    await selectTopSignal(posts, env, "you are a signal extractor", fakeFetch as any);

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch.mock.calls as any[])[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse((init as any).body);
    expect(body.tools[0].name).toBe("select_top_signal");
    expect(body.tool_choice).toEqual({ type: "tool", name: "select_top_signal" });
    expect((init as any).headers["x-api-key"]).toBe("sk-test");
  });

  it("requests strict tool use with thinking disabled (Sonnet 5 contract)", async () => {
    const fakeFetch = fakeFetchOk("select_top_signal", { lead: "", picks: [] });
    await selectTopSignal(posts, env, "sys", fakeFetch as any);
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    expect(body.model).toBe("claude-sonnet-5");
    // Sonnet 5 runs adaptive thinking when the field is omitted; this task ran
    // thinking-off on Sonnet 4.6 and must stay that way (quality + token budget).
    expect(body.thinking).toEqual({ type: "disabled" });
    // strict:true is what guarantees picks arrives as a real array — without it
    // Sonnet 5 has been observed returning picks as a JSON-encoded string.
    expect(body.tools[0].strict).toBe(true);
    expect(body.tools[0].input_schema.additionalProperties).toBe(false);
    // Constraints unsupported under strict must not be present.
    const schema = JSON.stringify(body.tools[0].input_schema);
    expect(schema).not.toContain("minItems");
    expect(schema).not.toContain("maxLength");
  });

  it("clamps picks to maxPicks (schema can no longer enforce it under strict)", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      rank: i + 1,
      postIndex: (i % 2) + 1,
      rationale: `pick ${i + 1}`,
    }));
    const fakeFetch = fakeFetchOk("select_top_signal", { lead: "big day", picks: seven });
    const { picks } = await selectTopSignal(posts, env, "sys", fakeFetch as any);
    // maxPicks is also clamped to the batch size (2 posts here), so the 7
    // returned picks reduce to the top 2 by rank.
    expect(picks.length).toBe(2);
    expect(picks.map((p) => p.rank)).toEqual([1, 2]);
  });

  it("throws when the response is truncated (stop_reason max_tokens, not silent)", async () => {
    const fakeFetch = fakeFetchOk(
      "select_top_signal",
      { lead: "", picks: [] },
      "max_tokens",
    );
    await expect(
      selectTopSignal(posts, env, "sys", fakeFetch as any),
    ).rejects.toThrow(/max_tokens/);
  });

  it("formats input as a numbered list with [source] prefix", async () => {
    const fakeFetch = fakeFetchOk("select_top_signal", {
      picks: [
        { rank: 1, postIndex: 1, rationale: "r1" },
        { rank: 2, postIndex: 2, rationale: "r2" },
        { rank: 3, postIndex: 1, rationale: "r3" },
      ],
    });
    await selectTopSignal(posts, env, "sys", fakeFetch as any);
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    const userMsg = body.messages[0].content;
    expect(userMsg).toContain("[twitter] 1.");
    expect(userMsg).toContain("@karpathy");
    expect(userMsg).toContain("[twitter] 2.");
    expect(userMsg).toContain("@swyx");
  });

  it("caches the system prompt via ephemeral cache_control", async () => {
    const fakeFetch = fakeFetchOk("select_top_signal", {
      picks: [
        { rank: 1, postIndex: 1, rationale: "r1" },
        { rank: 2, postIndex: 2, rationale: "r2" },
        { rank: 3, postIndex: 1, rationale: "r3" },
      ],
    });
    await selectTopSignal(posts, env, "sys", fakeFetch as any);
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("parses the tool_use response into a lead + picks", async () => {
    const fakeFetch = fakeFetchOk("select_top_signal", {
      lead: "Two frontier moves today.",
      picks: [
        { rank: 1, postIndex: 2, rationale: "swyx wins" },
        { rank: 2, postIndex: 1, rationale: "karpathy" },
      ],
    });
    const { lead, picks } = await selectTopSignal(posts, env, "sys", fakeFetch as any);
    expect(lead).toBe("Two frontier moves today.");
    expect(picks.length).toBe(2);
    expect(picks[0]).toEqual({ rank: 1, postIndex: 2, rationale: "swyx wins" });
  });

  it("allows an empty picks array (quiet-day quality gate)", async () => {
    // Under strict, lead is a required field — the prompt says empty string on
    // quiet days, and selectTopSignal must map that back to undefined.
    const fakeFetch = fakeFetchOk("select_top_signal", { lead: "", picks: [] });
    const result = await selectTopSignal(posts, env, "sys", fakeFetch as any);
    expect(result.picks).toEqual([]);
    expect(result.lead).toBeUndefined();
  });

  it("retries transient non-OK responses, then throws after exhausting attempts", async () => {
    // Always-429 → every attempt fails; assert it retried (not one-and-done)
    // and still surfaced the error instead of silently returning nothing.
    const fakeFetch = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    );
    await expect(
      selectTopSignal(posts, env, "sys", fakeFetch as any, {
        retry: { maxAttempts: 3, sleep: async () => {} },
      }),
    ).rejects.toThrow(/429/);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("retries a transient 500 and succeeds on a later attempt", async () => {
    // The exact failure that sank the 2026-07-10 run: a one-off API 500. A
    // single blip should be absorbed silently rather than aborting the briefing.
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "select_top_signal",
              input: {
                lead: "back",
                picks: [{ rank: 1, postIndex: 1, rationale: "r" }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await selectTopSignal(posts, env, "sys", fakeFetch as any, {
      retry: { maxAttempts: 3, sleep: async () => {} },
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.picks).toHaveLength(1);
  });

  it("retries any 5xx, not just an enumerated subset (e.g. a 522 edge status)", async () => {
    // Edge proxies emit 520/522/524 for transient origin trouble — the same
    // blip class as a 500. The official SDKs retry every 5xx; so do we.
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("edge timeout", { status: 522 });
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "select_top_signal",
              input: { lead: "ok", picks: [] },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await selectTopSignal(posts, env, "sys", fakeFetch as any, {
      retry: { maxAttempts: 3, sleep: async () => {} },
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.picks).toEqual([]);
  });

  it("does not retry a non-retryable 4xx", async () => {
    // A 400 is a bug in our request, not a blip — retrying just wastes calls.
    const fakeFetch = vi.fn(async () =>
      new Response("bad request", { status: 400 }),
    );
    await expect(
      selectTopSignal(posts, env, "sys", fakeFetch as any, {
        retry: { maxAttempts: 3, sleep: async () => {} },
      }),
    ).rejects.toThrow(/400/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("retries network-level failures (fetch rejects)", async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "select_top_signal",
              input: { lead: "ok", picks: [] },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await selectTopSignal(posts, env, "sys", fakeFetch as any, {
      retry: { maxAttempts: 3, sleep: async () => {} },
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.picks).toEqual([]);
  });
});

describe("anthropic.suggestAccounts", () => {
  const authors: AnthropicAuthorAggregate[] = [
    { handle: "founder1", postCount: 12, sample: ["sample tweet 1", "sample tweet 2"] },
    { handle: "founder2", postCount: 8, sample: ["another tweet"] },
  ];

  it("sends a tool-use request with suggest_accounts tool", async () => {
    const fakeFetch = fakeFetchOk("suggest_accounts", {
      accounts: [
        { handle: "founder1", rationale: "high signal", signalScore: 0.9 },
        { handle: "founder2", rationale: "decent", signalScore: 0.6 },
        { handle: "founder1", rationale: "filler", signalScore: 0.3 },
      ],
    });
    await suggestAccounts("manychat", authors, env, "sys", fakeFetch as any);
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    expect(body.tools[0].name).toBe("suggest_accounts");
    expect(body.tool_choice).toEqual({ type: "tool", name: "suggest_accounts" });
  });

  it("includes the topic and per-author aggregates in the user message", async () => {
    const fakeFetch = fakeFetchOk("suggest_accounts", {
      accounts: [
        { handle: "founder1", rationale: "r", signalScore: 0.9 },
        { handle: "founder2", rationale: "r", signalScore: 0.5 },
        { handle: "founder1", rationale: "r", signalScore: 0.2 },
      ],
    });
    await suggestAccounts("manychat", authors, env, "sys", fakeFetch as any);
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    const userMsg = body.messages[0].content;
    expect(userMsg).toContain("manychat");
    expect(userMsg).toContain("@founder1");
    expect(userMsg).toContain("12 posts");
    expect(userMsg).toContain("@founder2");
    expect(userMsg).toContain("8 posts");
  });

  it("parses the tool_use response into ranked accounts", async () => {
    const fakeFetch = fakeFetchOk("suggest_accounts", {
      accounts: [
        { handle: "founder1", rationale: "high signal", signalScore: 0.92 },
        { handle: "founder2", rationale: "decent", signalScore: 0.6 },
        { handle: "founder3", rationale: "filler", signalScore: 0.3 },
      ],
    });
    const accounts = await suggestAccounts(
      "manychat",
      authors,
      env,
      "sys",
      fakeFetch as any,
    );
    expect(accounts.length).toBe(3);
    expect(accounts[0]).toEqual({
      handle: "founder1",
      rationale: "high signal",
      signalScore: 0.92,
    });
  });
});
