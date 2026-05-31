import { describe, it, expect, vi } from "vitest";
import {
  selectTopSignal,
  suggestAccounts,
  type AnthropicPostInput,
  type AnthropicAuthorAggregate,
} from "../src/anthropic";

function fakeFetchOk(toolName: string, toolInput: unknown) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
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
    const fakeFetch = fakeFetchOk("select_top_signal", { picks: [] });
    const result = await selectTopSignal(posts, env, "sys", fakeFetch as any);
    expect(result.picks).toEqual([]);
    expect(result.lead).toBeUndefined();
    // minItems is 0 so the tool schema permits returning nothing.
    const body = JSON.parse(((fakeFetch.mock.calls as any[])[0][1] as any).body);
    expect(body.tools[0].input_schema.properties.picks.minItems).toBe(0);
  });

  it("throws on non-OK responses (no silent fallback for signal pipeline)", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    );
    await expect(
      selectTopSignal(posts, env, "sys", fakeFetch as any),
    ).rejects.toThrow();
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
