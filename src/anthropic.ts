const MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface AnthropicPostInput {
  index: number;
  source: string;
  author: string;
  timestamp: string;
  text: string;
  url: string;
}

export interface SignalPick {
  rank: number;
  postIndex: number;
  rationale: string;
}

export interface AnthropicAuthorAggregate {
  handle: string;
  postCount: number;
  sample: string[];
}

export interface AccountSuggestion {
  handle: string;
  rationale: string;
  signalScore: number;
}

interface AnthropicResponse {
  stop_reason?: string;
  content?: Array<{ type: string; name?: string; input?: unknown }>;
}

type FetchLike = typeof fetch;

async function callTool<T>(
  body: object,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<T> {
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  // With forced tool_choice the only healthy stop is tool_use. Anything else
  // (max_tokens = truncated tool input, refusal, …) must fail loudly — a
  // truncated input can parse as valid-looking garbage.
  if (data.stop_reason !== "tool_use") {
    throw new Error(
      `Anthropic response stopped with "${data.stop_reason}" instead of tool_use`,
    );
  }
  const tool = data.content?.find((b) => b.type === "tool_use");
  if (!tool || tool.input == null) {
    throw new Error("Anthropic response missing tool_use block");
  }
  return tool.input as T;
}

function formatPostsForSignal(posts: AnthropicPostInput[]): string {
  return posts
    .map(
      (p) =>
        `[${p.source}] ${p.index}. @${p.author} (${p.timestamp}): ${p.text} — ${p.url}`,
    )
    .join("\n");
}

function formatAuthorsForDiscover(
  topic: string,
  lookbackDays: number,
  authors: AnthropicAuthorAggregate[],
): string {
  const lines = authors.map((a) => {
    const samples = a.sample
      .map((s) => `"${s.replace(/"/g, '\\"').slice(0, 200)}"`)
      .join(" / ");
    return `- @${a.handle}: ${a.postCount} posts, sample: ${samples}`;
  });
  return `Topic: "${topic}"\nWindow: last ${lookbackDays} days\n\nAuthors:\n${lines.join("\n")}`;
}

export interface SelectTopSignalOptions {
  minPicks?: number;
  maxPicks?: number;
}

export interface SignalSelection {
  /** One-sentence summary of the day's signal; omitted when nothing is picked. */
  lead?: string;
  picks: SignalPick[];
}

export async function selectTopSignal(
  posts: AnthropicPostInput[],
  env: { ANTHROPIC_API_KEY: string },
  systemPrompt: string,
  fetchImpl: FetchLike = fetch,
  opts: SelectTopSignalOptions = {},
): Promise<SignalSelection> {
  // Daily default: 1–3 is the norm, up to 5 on heavy days, and 0 is valid so
  // the prompt's quality gate can keep a quiet day silent. Clamp to batch size.
  const maxPicks = Math.max(1, Math.min(opts.maxPicks ?? 5, posts.length));
  const minPicks = Math.max(0, Math.min(opts.minPicks ?? 0, maxPicks));
  const body = {
    model: MODEL,
    max_tokens: 1024,
    // Sonnet 5 runs adaptive thinking when this field is omitted (4.6 ran
    // thinking-off). Keep it off: it matches the tuned behavior, and thinking
    // would eat into max_tokens ahead of the tool call.
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    // strict guarantees the tool input validates against the schema — without
    // it Sonnet 5 has returned `picks` as a JSON-encoded string. Strict mode
    // rejects minItems/maxItems/maxLength/minimum, so those bounds live in the
    // description (and maxPicks is clamped below).
    tools: [
      {
        name: "select_top_signal",
        description:
          `Select the top ${minPicks}–${maxPicks} highest-signal posts from the batch ` +
          `(return an empty picks array if nothing clears the bar). ` +
          `lead: one sentence (≤160 chars) summarizing the day's signal, empty string when picks is empty. ` +
          `Each pick: rank (1 = most important, ≤${maxPicks}), postIndex (the post's number in the batch), ` +
          `rationale (standalone headline, ≤200 chars).`,
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            lead: { type: "string" },
            picks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "integer" },
                  postIndex: { type: "integer" },
                  rationale: { type: "string" },
                },
                required: ["rank", "postIndex", "rationale"],
                additionalProperties: false,
              },
            },
          },
          required: ["lead", "picks"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "tool", name: "select_top_signal" },
    messages: [{ role: "user", content: formatPostsForSignal(posts) }],
  };

  const result = await callTool<SignalSelection>(
    body,
    env.ANTHROPIC_API_KEY,
    fetchImpl,
  );
  const picks = [...(result.picks ?? [])]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxPicks);
  return { lead: result.lead || undefined, picks };
}

export async function suggestAccounts(
  topic: string,
  authors: AnthropicAuthorAggregate[],
  env: { ANTHROPIC_API_KEY: string },
  systemPrompt: string,
  fetchImpl: FetchLike = fetch,
  lookbackDays = 7,
): Promise<AccountSuggestion[]> {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "suggest_accounts",
        description:
          "Identify the top 1–3 accounts worth following for ongoing signal on a topic. " +
          "Each account: handle, rationale (≤200 chars), signalScore (0–1).",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            accounts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  handle: { type: "string" },
                  rationale: { type: "string" },
                  signalScore: { type: "number" },
                },
                required: ["handle", "rationale", "signalScore"],
                additionalProperties: false,
              },
            },
          },
          required: ["accounts"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "tool", name: "suggest_accounts" },
    messages: [
      {
        role: "user",
        content: formatAuthorsForDiscover(topic, lookbackDays, authors),
      },
    ],
  };

  const result = await callTool<{ accounts: AccountSuggestion[] }>(
    body,
    env.ANTHROPIC_API_KEY,
    fetchImpl,
  );
  // Strict mode can't express maxItems — enforce the documented top-3 here.
  return (result.accounts ?? []).slice(0, 3);
}
