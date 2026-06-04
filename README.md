# Twitter Watcher

I want the signal from Twitter without being on Twitter. So this watches a small set of hand-picked accounts for me, has Claude pick the handful of posts actually worth reading, and drops them into a Discord channel as a tight weekday briefing. No feed, no doomscroll — and on a quiet day, no message at all.

It's a Cloudflare Worker on a cron. Every weekday it pulls fresh tweets from [twitterapi.io](https://twitterapi.io), stores them in D1, asks Claude Sonnet for the day's top signals, and posts a tiered Discord embed. If nothing clears the bar, it stays silent. That's the whole thing.

> **This is my personal setup, shared as a reference.** The architecture transfers directly to anyone who wants the same "Twitter signal without Twitter" pipeline, but the setup below assumes you'll swap in your own Cloudflare account, D1 database, Anthropic key, Discord webhook, and watch list. Adapt it, don't expect to clone and run it untouched.

## What it does

```
                     ┌─────────── Cloudflare Worker ───────────┐
  weekday cron  ──▶  │  refresh → twitterapi.io                 │
  (Mon–Fri 11 UTC)   │     ↓                                    │
                     │   D1 (posts) ──▶ Claude (tiered top) ───▶│──▶ Discord briefing
                     │     ↑                                    │
                     │   prune posts > 30 days                  │
                     └──────────────────────────────────────────┘
                               ▲
                     MCP server│(optional) — drive it from any Claude client:
                               │ run a briefing, refresh, discover/add/remove accounts
```

- **Weekday briefing.** Every weekday (Mon–Fri) the Worker pulls fresh tweets, has Claude pick the day's top signals, and posts a tiered Discord embed: a one-line lead, a numbered **Don't miss** (1–3), and an **Also worth a look** tier only on heavy days. Each run covers the window since the last posted briefing, so Monday reaches back over the weekend. If nothing clears the signal bar, it posts nothing — quiet days stay quiet. The one exception is a **quiet Monday**, which posts a one-line liveness ping ("watcher's alive, N days since last signal") so a dead cron is distinguishable from a quiet stretch. If the run *fails*, it posts a failure alert so it never silently goes dark.
- **Discover (optional, on-demand).** `POST /api/discover { topic }` runs a live Twitter search and has Claude rank the accounts worth following on that topic. I keep this around to find new accounts to add to the watch list, this is not part of the weekday run.
- **Drive it from Claude.** A local [MCP server](./mcp/README.md) exposes the whole thing as tools, so I can run a briefing, refresh tweets, or add/remove accounts from any Claude conversation.

### Example briefing

A run posted to my Discord, tiered for scanning:

> **Twitter Watcher — 2026-05-31**
> Opus 4.8 shipped, Claude Code got dynamic workflows, and Gemini 3.5 Flash landed.
>
> 📌 **Don't miss**
> 1. Opus 4.8 out — SWE-bench Pro 64.3→69.2, same price — @bcherny [↗]
> 2. Claude Code dynamic workflows: auto-orchestration + parallel subagents — @ClaudeDevs [↗]
> 3. Salesforce: a 231-day migration shipped in 13 days with Claude Code — @bcherny [↗]
>
> **Also worth a look**
> • Gemini 3.5 Flash beats 3.1 Pro, 4× faster at half the cost — @demishassabis [↗]

The headline under each item is Claude's rationale — the full tweet text isn't shown, so the rationale has to stand on its own.

## Cadence

It runs every weekday by default. To change it, edit `wrangler.toml` `[triggers].crons` and `npm run deploy`:

```toml
crons = ["0 11 * * 1-5"]    # default — weekdays, Mon–Fri 11:00 UTC
crons = ["0 11 * * 1"]      # weekly, Monday 11:00 UTC
crons = ["0 11 * * *"]      # daily, including weekends
```

The cron does not fire under `wrangler dev` — use `POST /trigger` for the dev loop.

Each run scopes its candidate tweets to the window since the last *posted* briefing (floored at 72h so Monday covers the weekend, capped at 7 days). Pick counts are governed by the prompt (1–3 normal, up to 5 on heavy days, 0 on a quiet day → no message) and clamped by `minPicks`/`maxPicks` on `selectTopSignal` in `src/anthropic.ts` (default `0`/`5`). If you move to a weekly cadence, raise `maxPicks` — a week holds more signal than a day.

## Setup

### Prerequisites

- **Cloudflare Workers** — the **free tier is fine**. The twitterapi.io/Claude calls take a few seconds of I/O wait, which doesn't count against Workers' CPU-time limit (only active code execution does, and ours is trivial). No paid plan needed for this workload.
- **A [twitterapi.io](https://twitterapi.io) account + API key.** This is the tweet data source (both the timeline ingest and `discover` search). Pay-as-you-go, no subscription floor — ~$0.15/1k tweets, so this project runs ~$0.40/mo. Load a few dollars of prepaid credit and grab the key from the dashboard. ([`docs/data-source-notes.md`](./docs/data-source-notes.md) covers why this data source and the tradeoffs.)
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
   npx wrangler secret put TWITTERAPI_IO_KEY      # twitterapi.io dashboard → API Key
   ```
   For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in (gitignored).

4. **Deploy:**
   ```bash
   npm run deploy
   ```

## Smoke test

```bash
# 1. Pull fresh tweets first (otherwise the briefing has nothing to surface).
#    Expect {"handlesQueried":N,"ingested":M,...} — ingested > 0 confirms twitterapi.io works.
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
| `POST` | `/trigger` | Run a briefing now. `{ briefingId, postCount }` or `{ skipped: true, briefingId }` when nothing clears the bar. |
| `POST` | `/api/refresh` | Pull fresh tweets from twitterapi.io and ingest into D1 (the cron does this first each run). |
| `POST` | `/api/discover` | Topic search → top accounts. Body: `{ topic, lookbackDays? }`. |
| `GET` | `/api/watch-targets` | List watched handles. |
| `POST` | `/api/promote` | Add a handle. Body: `{ handle, source? }`. |
| `DELETE` | `/api/watch-targets` | Remove a handle. Body: `{ handle, source? }`. |

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Every request 404s | Wrong `TRIGGER_TOKEN`. The Worker returns 404 (not 401) on token mismatch by design. |
| `/api/refresh` returns `ingested: 0` | twitterapi.io key missing/invalid, out of credit, or all handle fetches failed (`failedHandles` > 0). Check `npx wrangler tail` and the twitterapi.io dashboard balance. |
| One handle never appears | A renamed/suspended handle returns an empty result (HTTP 200), so it's **silently** skipped — it won't show up in `failedHandles` (that only counts network/auth/HTTP errors). If a handle stops appearing, check it still exists on X. |
| Briefing reports `skipped` / nothing posts | Either no unsummarized posts in the window (run `/api/refresh` first, or check the cron ran) or Claude judged nothing worth surfacing. Silent skips are expected on quiet days. |
| A failure alert showed up in Discord | The scheduled run threw. Check `npx wrangler tail` for the actual error. |

`npx wrangler tail` streams live Worker logs — the first place to look when something's off.

## Design decisions worth stealing

The portable ideas, independent of the stack. If you build your own version, these are the parts that earned their keep:

- **Quiet days stay silent.** The prompt can return zero picks, and zero means no message. A digest that posts even when there's nothing to say trains you to ignore it. Padding to hit a count is the failure mode — [the prompt](./prompts/briefing.md) explicitly forbids it.
- **Distinguish "quiet" from "dead."** Silence is ambiguous — genuinely low signal, or did the cron die? A quiet Monday posts a one-line liveness ping ("watcher's alive, N days since last signal"), and any run that *throws* posts a failure alert. Silence then always means "nothing worth saying," never "broken."
- **The rationale is the product.** The digest shows Claude's one-line headline, not the tweet. So the prompt forces each headline to stand alone ("first benchmark showing X beats Y on agentic coding," not "interesting AI take"). The model isn't just ranking — it's writing the thing you actually read.
- **404, not 401.** A wrong token returns 404, so the route's existence is hidden from probes. A 401 would confirm "something's here." Cheap obscurity for a public Worker with no UI.
- **The prompt is the surface you iterate on — make that loop fast.** `prompts/briefing.md` is the real product, not the orchestration code. An [offline eval harness](./tests/eval-briefing.test.ts) runs the actual selection over a frozen batch with no Discord post or D1 write, so you can A/B prompt edits against identical input. Version the prompt, not just the code.
- **Window candidates by last *success*, not a fixed lookback.** Each run covers the gap since the last *posted* briefing (floored so Monday reaches over the weekend, capped so a long outage doesn't dump a week's backlog). Output cadence and input window stay decoupled.
- **Keep a source-adapter seam.** Ingest hides behind a `SourceAdapter` interface, so the briefing logic never names Twitter. Reddit/Threads/RSS can drop in without touching selection or delivery.

## How it works

- **One Worker, two handlers** — `fetch` (HTTP routes) and `scheduled` (the weekday cron). Entry: `src/worker.ts`.
- **Router** — `src/router.ts`, a single switch over `(method, path)`; every route 404s on token mismatch.
- **Briefing** — `src/briefing.ts`: `getUnsummarized → Claude.selectTopSignal → Discord embed → markSummarized`. The scheduled handler also prunes summarized posts older than 30 days so D1 stays lean.
- **Discover** — `src/discover.ts`: `twitterapi.io search → normalize → aggregate by author → Claude.suggestAccounts`.
- **Claude** — `src/anthropic.ts`: tool-use for strict JSON, ephemeral cache on system prompts. Ported from `inbox-watcher`.
- **Source adapters** — `src/adapters/`. Twitter is the only one today, but the `SourceAdapter` interface means Reddit/Threads/etc. can drop in without touching the briefing logic.
- **D1 schema** — `watch_targets`, `posts` (unique on `(source, source_id)`), `briefings`. See `schema.sql`.

## Project structure

```
src/
├── worker.ts        # fetch + scheduled entry
├── router.ts        # route dispatch + token / path-secret guards
├── briefing.ts      # weekday briefing orchestrator (tiered, windowed, silent-skip)
├── discover.ts      # topic → accounts orchestrator
├── ingest.ts        # twitterapi.io per-handle refresh → normalize → upsert
├── db.ts            # all D1 queries (incl. prunePosts)
├── discord.ts       # embed formatter + webhook POST (incl. failure alert)
├── anthropic.ts     # selectTopSignal + suggestAccounts (tool-use)
└── adapters/        # SourceAdapter interface + twitter.ts
prompts/             # briefing.md + discover.md (bundled at build time)
mcp/                 # local MCP server — drive it from any Claude client
scripts/             # seed-handles.mjs — sync watch-handles.txt → D1 via the API
watch-handles.txt    # hand-editable watch list (source of truth for `npm run seed`)
tests/               # vitest — real SQL against an in-memory SQLite shim
```

## Development

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev (no cron — use POST /trigger)
```

To tune the briefing selection prompt, use the offline eval harness — it runs the real
`selectTopSignal` over a frozen batch of posts (`tests/fixtures/briefing-batch.json`) and
prints the picks, with no Discord post or D1 write, so you can A/B prompt edits against
identical input:

```bash
npm run eval:briefing   # needs ANTHROPIC_API_KEY in .dev.vars; spends ~1 Sonnet call
```

It self-skips during `npm test` (gated on `RUN_EVAL`), so CI stays free. See the header of
[`tests/eval-briefing.test.ts`](./tests/eval-briefing.test.ts) for the re-snapshot command.

## Costs (rough monthly, single-user)

- Cloudflare Workers: **$0** (free tier — this workload fits easily)
- twitterapi.io: **~$0.40** (pay-as-you-go, ~$0.15/1k tweets × ~2.3k tweets/mo — no subscription floor)
- Anthropic: **$1–10** (Sonnet 4.6, tool-use, ephemeral cache — one small tool call per weekday run)
- Discord: **$0**

So **~$1–11/mo** with no fixed platform floor — every line item is usage-based or free.

## Roadmap

- **"Accounts like my seed list"** — use the discover backend to suggest accounts similar to the ones I already watch, and fold that into the weekday flow.
- **Per-account weights** — the `weight` column exists but the prompt doesn't use it yet.

## Version history

### v1.2.0 — 2026-06-03
Settled the tweet data source on pay-as-you-go **twitterapi.io** (~$0.40/mo, no subscription floor).
- Per-handle timeline fetch with per-handle error isolation, so one bad handle can't sink the whole refresh; `discover` search uses the same source.
- One vendor, one key (`TWITTERAPI_IO_KEY`).

### v1.1.0 — 2026-05-31
Refined how the briefing delivers, for scannability over a flat ranked list.
- **Weekday cadence** (Mon–Fri 11:00 UTC) instead of weekly; each run scopes candidates to a dynamic window since the last posted briefing (72h floor / 7d cap).
- **Tiered digest**: a one-line lead, a numbered **Don't miss** (1–3), and an **Also worth a look** tier on heavy days. Claude's rationale is now the standalone headline; full tweet bodies dropped.
- **Quiet days stay silent** — the prompt may return zero picks and the run posts nothing. A quiet **Monday** is the exception: it posts a one-line liveness ping so a dead cron stays visible. Failure alerts remain.
- Per-handle pull trimmed to 15 tweets for the shorter window.

### v1.0.0 — 2026-05-30
First public release. Deployed and verified end-to-end.
- Weekly Discord briefing (Mondays 11:00 UTC): refresh → top 5–7 signals via Claude → embed
- "No new signal" heartbeat, Discord failure alerts, and D1 pruning of summarized posts older than 30 days
- On-demand `discover` backend + local MCP server to drive it from any Claude client
