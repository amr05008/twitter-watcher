# twitter-watcher-mcp

A local MCP server that lets any Claude client (Claude Desktop, Claude Code, etc.) drive your deployed Twitter Watcher Worker on demand. It's a thin HTTP wrapper — all the real logic (twitterapi.io, Claude, Discord, D1) lives in the Worker.

Once installed, you can ask Claude things like:

| Tool | Ask Claude like… |
| --- | --- |
| `run_briefing` | *"Run my Twitter Watcher briefing."* |
| `refresh_tweets` | *"Refresh my watched tweets."* |
| `discover_accounts` | *"Find the top accounts discussing AI agents."* |
| `search_tweets` | *"Pull recent tweets about AI agents so we can read them."* |
| `get_account_tweets` | *"Show me what @karpathy has been posting."* |
| `get_account_following` | *"Who does @karpathy follow?"* |
| `list_watched_accounts` | *"What Twitter accounts am I watching?"* |
| `add_watched_account` | *"Add @karpathy to my watch list."* |
| `remove_watched_account` | *"Stop watching @sama."* |

Composable — Claude chains them automatically: *"Pull fresh tweets and run my briefing"* → `refresh_tweets` then `run_briefing`.

## Tools

| Tool | What it does |
| --- | --- |
| `run_briefing` | Run a briefing now. Posts the day's tiered top signals to Discord, or reports skipped if nothing clears the bar. |
| `refresh_tweets` | Pull fresh tweets for every watched handle from twitterapi.io into D1. |
| `discover_accounts` | Topic search → Claude distills the top accounts (server-side). |
| `list_watched_accounts` | Show the current watch list. |
| `add_watched_account` | Add a handle to the watch list. |
| `remove_watched_account` | Remove a handle. |

### Exploration tools (raw data into the session)

These three return **raw tweets/accounts straight into the conversation** — no server-side
distillation — so you and Claude can read the real text and pair on themes. Read-only; they never
touch D1 or the briefing pipeline.

| Tool | What it does |
| --- | --- |
| `search_tweets` | Paginated advanced search. `query` takes Twitter syntax (`OR`, quotes, `from:`, `-filter:replies`, `-filter:retweets`). `queryType` Latest\|Top. Default 150 tweets, max 1000. |
| `get_account_tweets` | Raw recent tweets for any handle (not just watched ones), replies included — filter via `isReply`. Default 150, max 1000. |
| `get_account_following` | The accounts a handle follows, with bios + follower counts — the backbone for "accounts similar to @X". Default 200, max 1000. |

**"Accounts similar to @someone"** is composed in-session: `get_account_following` (curated
peers) + `get_account_tweets` (derive their themes) + `search_tweets` (who else posts on those
themes) → Claude synthesizes a shortlist → `add_watched_account` for keepers.

**Advanced-search gotchas** (learned the hard way — twitterapi.io fails *silently* on these):
- The `min_faves:` operator makes the search return **zero** results. Don't use it; over-pull
  (`queryType: "Top"`, larger `maxTweets`) and filter by the returned `likeCount` in-session.
- **Over-long queries return zero** too. Keep each parenthesised `OR` group to ~6 terms.
- Ambiguous single words pull unrelated meanings (e.g. a common-noun trade term can surface
  unrelated art/hobby tweets) — add context terms to disambiguate.
- **Absence from results ≠ deleted.** X visibility-filters some live tweets (typically
  link-bearing originals from small accounts) out of *both* search and timeline pulls; the
  author still sees them on their own profile. The only existence ground truth is the by-ID
  endpoint: `GET /twitter/tweets?tweet_ids=<id>` (not exposed as a tool — curl it directly).

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
        "TWITTER_WATCHER_TRIGGER_TOKEN": "<your-trigger-token>"
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
- **`refresh_tweets` ingests 0** → check the Worker's `TWITTERAPI_IO_KEY` and the twitterapi.io credit balance.

## Development

```bash
npm run dev        # run from source with tsx (no build)
npm run build      # compile to dist/
npm test           # vitest — HTTP client unit tests
npm run typecheck  # tsc --noEmit
```
