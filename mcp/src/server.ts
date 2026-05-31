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
const apifyWebhookSecret = process.env.TWITTER_WATCHER_APIFY_WEBHOOK_SECRET ?? "";

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
      "Given a topic (e.g. 'AI agents', 'LLM evals'), runs a live Twitter search across all of Twitter, aggregates posts by author, and returns the top accounts most worth following on this topic with rationale. Synchronous; typically takes 15-45 seconds (the underlying Apify search is slow). Returns 1-3 accounts with handle, rationale, signalScore (0-1), postCount, and up to 3 sample tweet texts (samples).",
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
        maxResults: {
          type: "integer",
          description: "Cap on tweets pulled from Apify. Defaults to 50.",
          minimum: 10,
          maximum: 200,
        },
      },
      required: ["topic"],
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
      "Pull the latest tweets from every account in the passive watch list (via Apify) and ingest them into the database. This is what the daily cron does automatically; call this on-demand to populate fresh tweets before running a briefing. Synchronous; typically 15-45 seconds. Returns how many tweets were ingested vs skipped.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ingest_apify_dataset",
    description:
      "Workaround for the unreliable Apify webhook: manually ingest tweets from a completed Apify run by passing its dataset ID. The Twitter Watcher worker pulls the dataset, normalizes tweets, and upserts them into D1 — same code path the webhook uses. Get the dataset ID from the Apify console: Runs → click the run → Storage → Dataset ID. Requires the Apify webhook secret to also be set in the MCP env.",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: {
          type: "string",
          description: "Apify dataset ID from a completed actor run.",
        },
      },
      required: ["datasetId"],
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
              text: `Refreshed ${result.handlesQueried} watched handle(s). Ingested ${result.ingested} new tweet(s). Skipped: ${result.skippedMalformed} malformed, ${result.skippedNoTarget} from un-watched authors.`,
            },
          ],
        };
      }

      case "ingest_apify_dataset": {
        if (!apifyWebhookSecret) {
          return {
            content: [
              {
                type: "text",
                text: "ingest_apify_dataset requires TWITTER_WATCHER_APIFY_WEBHOOK_SECRET env var. Set it in your MCP config and restart.",
              },
            ],
            isError: true,
          };
        }
        const a = (args ?? {}) as { datasetId: string };
        const result = await client.ingestApifyDataset({
          datasetId: a.datasetId,
          webhookSecret: apifyWebhookSecret,
        });
        return {
          content: [
            {
              type: "text",
              text: `Ingested ${result.ingested} tweet(s) from dataset ${result.datasetId}. Skipped: ${result.skippedMalformed} malformed, ${result.skippedNoTarget} from un-watched authors.`,
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
