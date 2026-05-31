---
date: 2026-05-31
summary: Reworked the briefing into a tiered weekday digest with a quiet-day silent skip and a dynamic candidate window
tags: [briefing, discord, cadence, anthropic, prompt, mcp]
---

## Summary
The weekly briefing rendered as a flat list of 5–7 full-tweet embed fields — hard to scan, and important items risked getting buried. Reworked it into a **tiered weekday digest**: a one-line lead, a numbered **Don't miss** (1–3), and an **Also worth a look** tier on heavy days, with Claude's rationale serving as the standalone headline (full tweet bodies dropped). Moved the cron from weekly (Mon) to **every weekday (Mon–Fri)**, added a **quality gate** so quiet days post nothing, and fixed a latent batching issue that daily cadence would have exposed.

## Changes
- `wrangler.toml` — cron `0 11 * * 1` → `0 11 * * 1-5`; comment rewritten.
- `src/ingest.ts` — per-handle Apify pull 40 → 15 tweets (shorter window).
- `src/db.ts` — `getUnsummarized` takes an optional `{ sincePostedAt }` window; added `getLastBriefing`.
- `prompts/briefing.md` — rewritten for daily/tiered: 1–3 norm (up to 5 heavy days, 0 allowed), firm quality gate, `lead` field, rationale-as-standalone-headline.
- `src/anthropic.ts` — `selectTopSignal` returns `{ lead, picks }`; defaults `maxPicks` 7→5, `minPicks` 5→0 (empty allowed); `lead` added to tool schema.
- `src/briefing.ts` — cron computes a dynamic window (last-briefing time, floored 72h / capped 7d); **silent skip** (`{ skipped: true }`) when no candidates or no picks — no Discord post, no mark, no row; passes `lead` through.
- `src/discord.ts` — `formatBriefing` renders a single tiered embed in `description`; **removed `formatHeartbeat`**, added `formatHealthPing` (Monday liveness).
- `src/router.ts`, `src/worker.ts` — `BriefingResult` heartbeat→skipped; stale comments updated.
- `mcp/src/{client,server}.ts` — result `heartbeat`→`skipped`; tool description updated.
- Tests updated: `tests/{discord,anthropic,briefing,db}.test.ts`, `mcp/tests/client.test.ts`. README + mcp/README + version history (v1.1.0).

## Decisions
- **Daily despite the noise/cost caveat.** Total Apify + Anthropic volume ~doubles vs weekly (still ~$1→$2/mo). Mitigated by the 3-item default cap and the silent-skip quality gate. `maxItems` (15) is the cost knob; ~8 would be cost-neutral.
- **Silent skip, not a daily heartbeat** — except Mondays. Quiet days post nothing to avoid daily nothing-burgers; the red failure-alert path covers real cron breakage. To close the "stopped cron looks like a quiet stretch" blind spot, a **quiet Monday** posts a one-line liveness ping (`formatHealthPing`), guaranteeing ≥1 message/week. The ping is cron-only and Monday-only, writes no briefing row, and doesn't anchor the window (so "days since last signal" stays honest). Added after the initial silent-skip build at Aaron's request.
- **Dynamic window via `getLastBriefing`, not a fixed 48h.** A fixed window breaks Mondays (misses the weekend) and re-chews stale unpicked posts. Windowing back to the last *posted* briefing self-heals across skipped days; floor 72h / cap 7d.

## Notes
- `summarized_in` semantics unchanged ("appeared in a briefing"); only picks are marked. Unpicked posts get one more look next run, then age out of the window (and prune at 30d).
- Verified: `npm test` (78), `npm run typecheck`, mcp `npm test` (11) + typecheck — all green.
- Not yet done: deploy + live `run_briefing` via MCP against the deployed worker to eyeball the embed; observe the first autonomous weekday cron.
