# Twitter Watcher

I want the signal from Twitter without being on Twitter. So this watches a small set of hand-picked accounts for me, has Claude pick the handful of posts actually worth reading each week, and drops them into a Discord channel as a briefing. No feed, no doomscroll, one curated message a week.

It's a Cloudflare Worker on a cron. It pulls fresh tweets from [Apify](https://apify.com), stores them in D1, asks Claude Sonnet for the top 5–7 signals of the week, and posts a Discord embed. That's the whole thing.

> **This is my personal setup, shared as a reference.** The architecture transfers directly to anyone who wants the same "Twitter signal without Twitter" pipeline, but the setup below assumes you'll swap in your own Cloudflare account, D1 database, Anthropic key, Discord webhook, and watch list. Adapt it, don't expect to clone and run it untouched.

## What it does

```
                    ┌─────────── Cloudflare Worker ───────────┐
  weekly cron  ──▶  │  refresh → Apify (tweet scraper)         │
  (Mon 11 UTC)      │     ↓                                    │
                    │   D1 (posts) ──▶ Claude (top 5–7) ──────▶│──▶ Discord briefing
                    │     ↑                                    │
                    │   prune posts > 30 days                  │
                    └──────────────────────────────────────────┘
                              ▲
                    MCP server│(optional) — drive it from any Claude client:
                              │ run a briefing, refresh, discover/add/remove accounts
```

- **Weekly briefing.** Every Monday the Worker pulls fresh tweets from the watched accounts, has Claude pick the 5–7 highest-signal posts of the past week, and posts them to Discord. If there's nothing new, it posts a short "no new signal" heartbeat. If the run *fails*, it posts a failure alert so it never silently goes dark.
- **Discover (optional, on-demand).** `POST /api/discover { topic }` runs a live Twitter search and has Claude rank the accounts worth following on that topic. I keep this around to find new accounts to add to the watch list, this is not part of the weekly run.
- **Drive it from Claude.** A local [MCP server](./mcp/README.md) exposes the whole thing as tools, so I can run a briefing, refresh tweets, or add/remove accounts from any Claude conversation.

### Example briefing

A real run, picked from ~47 tweets, posted to my Discord:

> **#1 — @karpathy** — Personal update: I've joined Anthropic…
> _Major talent move with direct implications for frontier LLM R&D direction._

> **#2 — @karpathy** — Software horror: litellm PyPI supply-chain attack. `pip install litellm` was enough to exfiltrate SSH keys, cloud creds, Kubernetes configs…
> _Active supply-chain attack — actionable security alert._

## Cadence

It's weekly by default. To change it, edit `wrangler.toml` `[triggers].crons` and `npm run deploy`:

```toml
crons = ["0 11 * * 1"]      # default — weekly, Monday 11:00 UTC
crons = ["0 11 * * *"]      # daily 11:00 UTC
crons = ["0 11 1 * *"]      # monthly, 1st of the month
```

The cron does not fire under `wrangler dev` — use `POST /trigger` for the dev loop.

If you switch to daily, you'll probably want fewer picks per briefing (a day has less signal than a week). The count is a parameter on `selectTopSignal` in `src/anthropic.ts` (`minPicks`/`maxPicks`, default 5–7) — pass `{ maxPicks: 3 }` from `runBriefing` for the daily feel.

## Setup

### Prerequisites

- **Cloudflare Workers** — the **free tier is fine**. The Apify/Claude calls take 15–45s, but that's I/O wait, which doesn't count against Workers' CPU-time limit (only active code execution does, and ours is trivial). No paid plan needed for this workload.
- **An Apify account + tweet-scraper actor.** The default is `apidojo/tweet-scraper` (Starter plan, $29/mo) — note `APIFY_ACTOR_ID` wants its **API form with a tilde**, `apidojo~tweet-scraper`, not the store's slash form. That fixed floor is mostly wasted for personal use — see [`docs/apify-pricing.md`](./docs/apify-pricing.md) for usage-based actors that drop it to well under $1/mo.
- **Anthropic API key** with a monthly budget cap.
- **Discord webhook** for the channel you want briefings in (channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL).

### One-time setup

1. **Repo + deps:**
   ```bash
   git clone git@github.com:amr05008/twitter-watcher.git
   cd twitter-watcher
   cp wrangler.example.toml wrangler.toml
   npm install
   ```

   `wrangler` is a local devDependency, so prefix commands with `npx` (or install it globally).

2. **D1 database:**
   ```bash
   npx wrangler d1 create twitter-watcher
   # paste the returned database_id into wrangler.toml
   npx wrangler d1 execute twitter-watcher --remote --file schema.sql
   npx wrangler d1 execute twitter-watcher --remote --file seed.sql   # edit seed.sql first — it's example handles
   npx wrangler d1 execute twitter-watcher --remote --command "SELECT COUNT(*) FROM watch_targets"
   ```
   Always use `--remote`, never `--local` — the local D1 binding is a separate database the deployed Worker won't see.

   `seed.sql` is a one-shot bootstrap and goes stale once you curate at runtime. For an ongoing, hand-editable watch list, use [`watch-handles.txt`](./watch-handles.txt) (one handle per line) and `npm run seed` instead — it syncs the file to D1 through the `/api/promote` route (`-- --prune` makes it a true two-way sync). Needs `WATCHER_URL` + `TRIGGER_TOKEN` in the env (or `.dev.vars`), so run it after deploy.

3. **Secrets** (set with the CLI, or in the Cloudflare dashboard → your Worker → Settings → Variables → as Secret):
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put DISCORD_WEBHOOK_URL
   npx wrangler secret put TRIGGER_TOKEN          # openssl rand -hex 32
   npx wrangler secret put APIFY_WEBHOOK_SECRET   # openssl rand -hex 32
   npx wrangler secret put APIFY_TOKEN            # console.apify.com/account/integrations
   npx wrangler secret put APIFY_ACTOR_ID         # apidojo~tweet-scraper  (tilde, not slash)
   ```
   For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in (gitignored).

4. **Deploy:**
   ```bash
   npm run deploy
   ```

## Smoke test

```bash
# 1. Pull fresh tweets first (otherwise the briefing has nothing to surface).
#    Expect {"handlesQueried":N,"ingested":M,...} — ingested > 0 confirms Apify works.
curl -X POST -H "X-Trigger-Token: $TRIGGER_TOKEN" \
  https://<your-worker>.workers.dev/api/refresh

# 2. Run a briefing now (posts to your Discord channel)
curl -X POST -H "X-Trigger-Token: $TRIGGER_TOKEN" \
  https://<your-worker>.workers.dev/trigger

# List your watched accounts
curl -H "X-Trigger-Token: $TRIGGER_TOKEN" \
  https://<your-worker>.workers.dev/api/watch-targets

# Find accounts discussing a topic (optional discover flow)
curl -X POST -H "X-Trigger-Token: $TRIGGER_TOKEN" -H "Content-Type: application/json" \
  -d '{"topic":"AI agents","lookbackDays":7}' \
  https://<your-worker>.workers.dev/api/discover
```

All routes require the `X-Trigger-Token` header. A wrong token returns **404, not 401** — by design, so the route's existence is hidden from probes.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/trigger` | Run a briefing now. `{ briefingId, postCount }` or `{ heartbeat: true, briefingId }`. |
| `POST` | `/api/refresh` | Pull fresh tweets from Apify and ingest into D1 (the cron does this first each run). ~15–45s. |
| `POST` | `/api/discover` | Topic search → top accounts. Body: `{ topic, lookbackDays?, maxResults? }`. ~15–45s. |
| `GET` | `/api/watch-targets` | List watched handles. |
| `POST` | `/api/promote` | Add a handle. Body: `{ handle, source? }`. |
| `DELETE` | `/api/watch-targets` | Remove a handle. Body: `{ handle, source? }`. |
| `POST` | `/webhook/apify/<secret>` | Optional Apify completion webhook (path-secret-gated). Not load-bearing — `/api/refresh` covers it. |

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Every request 404s | Wrong `TRIGGER_TOKEN`. The Worker returns 404 (not 401) on token mismatch by design. |
| `error code: 1101` on `/api/refresh` or `/trigger` | Unhandled exception, almost always the Apify call. Most common cause: `APIFY_ACTOR_ID` set to the store's slash form `apidojo/tweet-scraper` — the API needs the **tilde** form `apidojo~tweet-scraper`. Run `npx wrangler tail` to see the real error. |
| Apify returns `noResults` | The `apidojo` actor blocks API access on Apify's free plan — you need a paid plan, or a usage-based actor (see `docs/apify-pricing.md`). |
| Briefing posts "no new signal" | No unsummarized posts in D1 — run `/api/refresh` first, or check the cron ran. |
| A failure alert showed up in Discord | The scheduled run threw. Check `npx wrangler tail` for the actual error. |
| `discover` takes 30+ seconds | Expected — Apify search is slow. |

`npx wrangler tail` streams live Worker logs — the first place to look when something's off.

## How it works

- **One Worker, two handlers** — `fetch` (HTTP routes) and `scheduled` (the weekly cron). Entry: `src/worker.ts`.
- **Router** — `src/router.ts`, a single switch over `(method, path)`; every route 404s on token mismatch.
- **Briefing** — `src/briefing.ts`: `getUnsummarized → Claude.selectTopSignal → Discord embed → markSummarized`. The scheduled handler also prunes summarized posts older than 30 days so D1 stays lean.
- **Discover** — `src/discover.ts`: `Apify search → normalize → aggregate by author → Claude.suggestAccounts`.
- **Claude** — `src/anthropic.ts`: tool-use for strict JSON, ephemeral cache on system prompts. Ported from `inbox-watcher`.
- **Source adapters** — `src/adapters/`. Twitter is the only one today, but the `SourceAdapter` interface means Reddit/Threads/etc. can drop in without touching the briefing logic.
- **D1 schema** — `watch_targets`, `posts` (unique on `(source, source_id)`), `briefings`. See `schema.sql`.

## Project structure

```
src/
├── worker.ts        # fetch + scheduled entry
├── router.ts        # route dispatch + token / path-secret guards
├── briefing.ts      # weekly briefing orchestrator
├── discover.ts      # topic → accounts orchestrator
├── ingest.ts        # Apify refresh → normalize → upsert
├── db.ts            # all D1 queries (incl. prunePosts)
├── discord.ts       # embed formatter + webhook POST (incl. failure alert)
├── anthropic.ts     # selectTopSignal + suggestAccounts (tool-use)
└── adapters/        # SourceAdapter interface + twitter.ts
prompts/             # briefing.md + discover.md (bundled at build time)
mcp/                 # local MCP server — drive it from any Claude client
scripts/             # seed-handles.mjs — sync watch-handles.txt → D1 via the API
watch-handles.txt    # hand-editable watch list (source of truth for `npm run seed`)
docs/apify-pricing.md
tests/               # vitest — real SQL against an in-memory SQLite shim
```

## Development

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev (no cron — use POST /trigger)
```

## Costs (rough monthly, single-user)

- Cloudflare Workers: **$0** (free tier — this workload fits easily)
- Apify: **$29** on the default rental actor, or **< $1** on a usage-based one ([`docs/apify-pricing.md`](./docs/apify-pricing.md))
- Anthropic: **$1–10** (Sonnet 4.6, tool-use, ephemeral cache — weekly briefings are tiny)
- Discord: **$0**

So ~$1–11/mo once you move off the Apify rental floor — Apify is the only real cost.

## Roadmap

- **Usage-based Apify** — the research is done ([`docs/apify-pricing.md`](./docs/apify-pricing.md)); the migration is the next code change.
- **"Accounts like my seed list"** — use the discover backend to suggest accounts similar to the ones I already watch, and fold that into the weekly flow.
- **More sources** — a Reddit adapter (`src/adapters/reddit.ts`) is the highest-value second source; the adapter interface is already built for it.
- **Per-account weights** — the `weight` column exists but the prompt doesn't use it yet.

## Version history

### v1.0.0 — 2026-05-30
First public release. Deployed and verified end-to-end (Apify → D1 → Claude → Discord).
- Weekly Discord briefing (Mondays 11:00 UTC): refresh → top 5–7 signals via Claude → embed
- "No new signal" heartbeat, Discord failure alerts, and D1 pruning of summarized posts older than 30 days
- On-demand `discover` backend + local MCP server (7 tools) to drive it from any Claude client
- Usage-based Apify migration researched but not yet applied — see [`docs/apify-pricing.md`](./docs/apify-pricing.md)
