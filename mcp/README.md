# twitter-watcher-mcp

A local MCP server that lets any Claude client (Claude Desktop, Claude Code, etc.) drive your deployed Twitter Watcher Worker on demand. It's a thin HTTP wrapper — all the real logic (Apify, Claude, Discord, D1) lives in the Worker.

Once installed, you can ask Claude things like:

| Tool | Ask Claude like… |
| --- | --- |
| `run_briefing` | *"Run my Twitter Watcher briefing."* |
| `refresh_tweets` | *"Refresh my watched tweets."* |
| `discover_accounts` | *"Find the top accounts discussing AI agents."* |
| `list_watched_accounts` | *"What Twitter accounts am I watching?"* |
| `add_watched_account` | *"Add @karpathy to my watch list."* |
| `remove_watched_account` | *"Stop watching @sama."* |
| `ingest_apify_dataset` | *"Ingest Apify dataset abc123."* |

Composable — Claude chains them automatically: *"Pull fresh tweets and run my briefing"* → `refresh_tweets` then `run_briefing`.

## Tools

| Tool | What it does |
| --- | --- |
| `run_briefing` | Run a briefing now. Posts the day's tiered top signals to Discord, or reports skipped if nothing clears the bar. |
| `refresh_tweets` | Pull fresh tweets for every watched handle from Apify into D1. Synchronous, ~15–45s. |
| `discover_accounts` | Topic search → top accounts. Synchronous, ~15–45s. |
| `list_watched_accounts` | Show the current watch list. |
| `add_watched_account` | Add a handle to the watch list. |
| `remove_watched_account` | Remove a handle. |
| `ingest_apify_dataset` | Manually ingest a completed Apify run by dataset ID (optional fallback). |

## Install

```bash
cd mcp
npm install
npm run build   # produces dist/server.js — the stdio MCP server
```

## Configure

Add a `twitter-watcher` server entry to your Claude client config, using the **absolute path** to `dist/server.js`.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
**Claude Code** — `~/.claude/settings.json` or a project `.claude/settings.json`.

```json
{
  "mcpServers": {
    "twitter-watcher": {
      "command": "node",
      "args": ["/absolute/path/to/twitter-watcher/mcp/dist/server.js"],
      "env": {
        "TWITTER_WATCHER_BASE_URL": "https://<your-worker>.workers.dev",
        "TWITTER_WATCHER_TRIGGER_TOKEN": "<your-trigger-token>",
        "TWITTER_WATCHER_APIFY_WEBHOOK_SECRET": "<optional — only for ingest_apify_dataset>"
      }
    }
  }
}
```

Restart the Claude client after editing config.

## Environment variables

| Var | Required | Description |
| --- | --- | --- |
| `TWITTER_WATCHER_BASE_URL` | yes | Base URL of the deployed Worker (no trailing slash needed). |
| `TWITTER_WATCHER_TRIGGER_TOKEN` | yes | The same `TRIGGER_TOKEN` set as a Worker secret. |
| `TWITTER_WATCHER_APIFY_WEBHOOK_SECRET` | no | Only for the `ingest_apify_dataset` tool. Matches the Worker's `APIFY_WEBHOOK_SECRET`. |

## Verify

In a new Claude conversation: *"List the Twitter accounts I'm watching."* Claude should call `list_watched_accounts` and return your handles.

Or poke the server directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | TWITTER_WATCHER_BASE_URL=https://<your-worker>.workers.dev \
    TWITTER_WATCHER_TRIGGER_TOKEN=<token> \
    node dist/server.js
```

## Troubleshooting

- **"missing required env vars"** at startup → set both `TWITTER_WATCHER_BASE_URL` and `TWITTER_WATCHER_TRIGGER_TOKEN` in the config `env` block.
- **Tools don't appear** → restart the Claude client; make sure `args` is an absolute path to the built `dist/server.js` (not `src/server.ts`).
- **Every tool call 404s** → wrong `TRIGGER_TOKEN`. The Worker returns 404 (not 401) on mismatch by design.
- **`discover_accounts` takes 30+ seconds** → expected; Apify search is slow.

## Development

```bash
npm run dev        # run from source with tsx (no build)
npm run build      # compile to dist/
npm test           # vitest — HTTP client unit tests
npm run typecheck  # tsc --noEmit
```
