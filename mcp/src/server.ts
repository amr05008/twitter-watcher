#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TwitterWatcherClient } from "./client.js";

const baseUrl = process.env.TWITTER_WATCHER_BASE_URL;
const triggerToken = process.env.TWITTER_WATCHER_TRIGGER_TOKEN;

if (!baseUrl || !triggerToken) {
  console.error(
    "twitter-watcher-mcp: missing required env vars TWITTER_WATCHER_BASE_URL and/or TWITTER_WATCHER_TRIGGER_TOKEN",
  );
  process.exit(1);
}

const client = new TwitterWatcherClient({
  baseUrl,
  triggerToken,
});

const server = new Server(
  {
    name: "twitter-watcher",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const tools = [
  {
    name: "run_briefing",
    description:
      "Trigger a Twitter Watcher briefing immediately. Pulls unsummarized tweets from the watched accounts, has Claude pick the top signals (1-3 normally, up to 5 on heavy days), and posts a tiered digest embed to the configured Discord channel. If nothing clears the signal bar, it posts nothing and reports skipped. Returns the briefing ID and post count.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "discover_accounts",
    description:
      "Given a topic (e.g. 'AI agents', 'LLM evals'), runs a live Twitter search, aggregates posts by author, and returns the top accounts most worth following on this topic with rationale. Returns 1-3 accounts with handle, rationale, signalScore (0-1), postCount, and up to 3 sample tweet texts (samples).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic to search for (e.g. 'AI agents', 'LLM evals').",
        },
        lookbackDays: {
          type: "integer",
          description: "How many days of tweets to consider. Defaults to 7.",
          minimum: 1,
          maximum: 30,
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "search_tweets",
    description:
      "Search Twitter and return the RAW matching tweets (text + engagement + author) into this session for direct reading/analysis — not a server-side summary. Use for exploring how people talk about a topic. The query accepts Twitter advanced-search syntax: parentheses, OR, quoted phrases, from:user, -filter:replies, -filter:retweets. Paginates under the hood up to maxTweets. IMPORTANT: keep queries short (a handful of OR terms per group) and do NOT use the min_faves: operator — both cause the search to silently return zero results; instead over-pull and filter by the returned likeCount in-session. Example query: '(\"LLM eval\" OR \"AI agent\") (benchmark OR framework) -filter:replies'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Twitter advanced-search query string (supports OR, parentheses, quotes, from:, -filter:replies, min_faves:, since_time:/until_time:).",
        },
        queryType: {
          type: "string",
          enum: ["Latest", "Top"],
          description: "'Latest' (chronological, default) or 'Top' (most engaged).",
        },
        maxTweets: {
          type: "integer",
          description: "Max tweets to pull across pages. Default 150, max 1000.",
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_account_tweets",
    description:
      "Pull the RAW recent tweets (text + engagement) for ANY handle (not just watched accounts) into this session. Includes replies (filter in-session via the isReply flag) — an account whose recent activity is mostly replies would otherwise look years stale. Use to read what a seed account actually posts — e.g. to derive its themes/vocabulary before finding similar accounts. Pass the handle without '@'. Paginates up to maxTweets.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Twitter handle without the '@' prefix (e.g. 'karpathy').",
        },
        maxTweets: {
          type: "integer",
          description: "Max tweets to pull across pages. Default 150, max 1000.",
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "get_account_following",
    description:
      "List the accounts a given handle follows, with bios and follower counts — the curated-peer signal for 'accounts similar to @X'. Returns raw account data for in-session filtering. Pass the handle without '@'. Paginates up to maxAccounts.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Twitter handle without the '@' prefix (e.g. 'karpathy').",
        },
        maxAccounts: {
          type: "integer",
          description: "Max accounts to pull across pages. Default 200, max 1000.",
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "list_watched_accounts",
    description:
      "List the Twitter accounts currently in the passive watch list. These are the accounts whose tweets are pulled daily for the briefing.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "add_watched_account",
    description:
      "Add a Twitter handle to the passive watch list so its tweets are included in the next briefing. Pass the handle without the '@' prefix. Returns alreadyExisted: true if the handle was already in the list (still a success).",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Twitter handle without the '@' prefix (e.g. 'karpathy').",
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_watched_account",
    description:
      "Remove a Twitter handle from the passive watch list. Returns removed: false if the handle was not in the list.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Twitter handle without the '@' prefix.",
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_tweets",
    description:
      "Pull the latest tweets from every account in the passive watch list (via twitterapi.io) and ingest them into the database. This is what the daily cron does automatically; call this on-demand to populate fresh tweets before running a briefing. Returns how many tweets were ingested vs skipped.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "run_briefing": {
        const result = await client.runBriefing();
        return {
          content: [
            {
              type: "text",
              text: result.skipped
                ? `No new signal — nothing cleared the bar, so no briefing was posted (id: ${result.briefingId}).`
                : `Briefing posted to Discord. Briefing ID: ${result.briefingId}. Posts surfaced: ${result.postCount}.`,
            },
          ],
        };
      }

      case "discover_accounts": {
        const a = (args ?? {}) as {
          topic: string;
          lookbackDays?: number;
          maxResults?: number;
        };
        const result = await client.discoverAccounts(a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "search_tweets": {
        const a = (args ?? {}) as {
          query: string;
          queryType?: "Latest" | "Top";
          maxTweets?: number;
        };
        const result = await client.searchTweets(a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_account_tweets": {
        const a = (args ?? {}) as { handle: string; maxTweets?: number };
        const result = await client.getAccountTweets(a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_account_following": {
        const a = (args ?? {}) as { handle: string; maxAccounts?: number };
        const result = await client.getAccountFollowing(a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "list_watched_accounts": {
        const result = await client.listWatchedAccounts();
        const lines = result.targets.map(
          (t) => `- @${t.handle} (${t.source}, kind=${t.kind}, weight=${t.weight})`,
        );
        return {
          content: [
            {
              type: "text",
              text:
                lines.length === 0
                  ? "No accounts in the watch list."
                  : `${lines.length} watched account(s):\n${lines.join("\n")}`,
            },
          ],
        };
      }

      case "add_watched_account": {
        const a = (args ?? {}) as { handle: string };
        const result = await client.addWatchedAccount({ handle: a.handle });
        return {
          content: [
            {
              type: "text",
              text: result.alreadyExisted
                ? `@${a.handle} was already in the watch list (id: ${result.id}).`
                : `Added @${a.handle} to the watch list (id: ${result.id}).`,
            },
          ],
        };
      }

      case "remove_watched_account": {
        const a = (args ?? {}) as { handle: string };
        const result = await client.removeWatchedAccount({ handle: a.handle });
        return {
          content: [
            {
              type: "text",
              text: result.removed
                ? `Removed @${a.handle} from the watch list.`
                : `@${a.handle} was not in the watch list — nothing to remove.`,
            },
          ],
        };
      }

      case "refresh_tweets": {
        const result = await client.refreshTweets();
        return {
          content: [
            {
              type: "text",
              text: `Refreshed ${result.handlesQueried} watched handle(s). Ingested ${result.ingested} new tweet(s). Skipped: ${result.skippedMalformed} malformed tweet(s), ${result.failedHandles} handle(s) failed to fetch.`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error calling ${name}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("twitter-watcher-mcp: ready on stdio");
