const MODEL = "claude-sonnet-4-6";
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
  // Weekday default: 1–3 is the norm, up to 5 on heavy days, and 0 is valid so
  // the prompt's quality gate can keep a quiet day silent. Clamp to batch size.
  const maxPicks = Math.max(1, Math.min(opts.maxPicks ?? 5, posts.length));
  const minPicks = Math.max(0, Math.min(opts.minPicks ?? 0, maxPicks));
  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "select_top_signal",
        description: `Select the top ${minPicks}–${maxPicks} highest-signal posts from the batch (return none if nothing clears the bar).`,
        input_schema: {
          type: "object",
          properties: {
            lead: { type: "string", maxLength: 160 },
            picks: {
              type: "array",
              minItems: minPicks,
              maxItems: maxPicks,
              items: {
                type: "object",
                properties: {
                  rank: { type: "integer", minimum: 1, maximum: maxPicks },
                  postIndex: { type: "integer" },
                  rationale: { type: "string", maxLength: 200 },
                },
                required: ["rank", "postIndex", "rationale"],
              },
            },
          },
          required: ["picks"],
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
  return { lead: result.lead, picks: result.picks ?? [] };
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
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "suggest_accounts",
        description:
          "Identify the top 3 accounts worth following for ongoing signal on a topic.",
        input_schema: {
          type: "object",
          properties: {
            accounts: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  handle: { type: "string" },
                  rationale: { type: "string", maxLength: 200 },
                  signalScore: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["handle", "rationale", "signalScore"],
              },
            },
          },
          required: ["accounts"],
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
  return result.accounts;
}
