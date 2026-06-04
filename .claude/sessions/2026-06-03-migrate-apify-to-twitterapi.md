---
date: 2026-06-03
summary: Migrated the tweet data source from Apify to twitterapi.io (single vendor), after establishing Apify's $29/mo floor couldn't be beaten on-platform
tags: [apify, twitterapi, ingest, discover, cost, migration, adapters]
---

## Summary
Investigated whether Apify's ~$29/mo (~$350/yr) cost was justified and concluded it
couldn't be beaten *on Apify* (no pay-as-you-go below the $29 platform plan; usage-based
actors are demo-capped on free). Since Apify is a gray-area scraper like the alternatives —
not official X access — migrating off it loses no legitimacy. Moved both ingest and `discover`
to **twitterapi.io** (pay-as-you-go, ~$0.40/mo) and removed Apify entirely. Verified live in
prod, then a `/grill` pass added loud-alert hardening for a total source outage.

## Changes
- **`src/ingest.ts`** — rewrote `refreshHandleIngest` to per-handle twitterapi.io
  `last_tweets` fetch (vs Apify batch) with per-handle error isolation; throws on *total*
  failure (every handle errored). `IngestResult.skippedNoTarget` → `failedHandles`.
- **`src/adapters/twitter.ts`** — normalize twitterapi.io's shape (already compatible:
  `fullText ?? text`, `twitterUrl ?? url`, classic `createdAt`); removed the Apify webhook handler.
- **`src/discover.ts`** — search via twitterapi.io `advanced_search`.
- **`src/worker.ts`** — inner refresh catch now posts the red Discord alert on total failure, then continues.
- **`src/env.ts` / `src/router.ts`** — `APIFY_*` → `TWITTERAPI_IO_KEY`; removed `/webhook/apify` route.
- **`mcp/`** — removed `ingest_apify_dataset` tool + client method; descriptions/shape updated.
- Docs: README, mcp/README, `.dev.vars.example`, `wrangler.example.toml`; repurposed
  `docs/apify-pricing.md` into a "why we left Apify" record. Fixtures swapped to twitterapi.io.
- Commits: `17eef6c` (migration), `73aec2b` (doc fix), `0c73588` (total-failure alert). Preceding
  Apify-pricing investigation: `3275fbc`, `03692fa`, `eba5e1d`.

## Decisions
- **Remove Apify entirely, no fallback toggle** (Aaron: "twitter-only, nothing fancy" + $10 already
  loaded in twitterapi.io). Rollback = `git revert` + re-subscribe Apify, not a hot standby.
- **twitterapi.io over SocialData/RapidAPI/xquik/official X API** — cleanest fit (handle in, full
  tweet incl. URL out), cheapest with no subscription floor, same operator as a proven Apify actor.
- **Grill outcome:** a renamed/suspended handle returns HTTP 200 + empty (silent drop-out, parity
  with Apify — documented, not "fixed"); a *total* outage now throws → loud alert (the one change made).

## Notes
- twitterapi.io quirks (verified against live API): timeline nests tweets under `data.tweets`;
  search returns them top-level under `tweets`; no `isRetweet` field (retweets via `retweeted_tweet`
  / "RT @" text); `createdAt` is classic "Tue Jun 02 …" format (`new Date()` parses it).
- Live verify (prod): refresh 140 ingested / briefing 3 picks / discover 3 accounts. Tests: root 79, mcp 10.
- **Pending Aaron actions:** cancel the Apify plan (banks the saving); restart the Claude client
  (local MCP server still runs pre-rebuild code); optionally rotate the twitterapi.io key (it appeared
  in this session's transcript) and delete the inert `APIFY_*` Worker secrets.
