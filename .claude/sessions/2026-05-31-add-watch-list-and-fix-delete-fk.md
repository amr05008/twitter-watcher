---
date: 2026-05-31
summary: Added hand-editable watch list + seed sync script; curated real handles; found and fixed a production FK bug in the delete path; wired and verified the MCP server.
tags: [watch-list, d1, foreign-keys, mcp, bugfix]
---

## Summary
Built a flat-file watch list (`watch-handles.txt`) plus a `npm run seed` sync script so the watch list is hand-editable and re-appliable instead of hand-written SQL. Curating the real list exercised the `DELETE /api/watch-targets` path for the first time, which surfaced a production crash: D1 enforces the `posts.target_id → watch_targets` foreign key, so deleting a handle that had ingested posts threw `FOREIGN KEY constraint failed`. Fixed it, hardened the test harness to match D1, then wired and verified the MCP server end-to-end (refresh → briefing → list, all driven conversationally).

## Changes
- `watch-handles.txt` (new) — hand-editable watch list, one handle per line, `#` comments.
- `scripts/seed-handles.mjs` (new) — syncs the file to D1 via `/api/watch-targets` + `/api/promote`; `--prune` for true two-way sync, `--dry-run`, `--local`.
- `package.json` — added `seed` script.
- `README.md`, `seed.sql` — documented the flat-file path as the maintained alternative to one-shot `seed.sql`.
- `src/db.ts` — `deleteWatchTarget` now deletes the target's posts before the target (app-level cascade).
- `tests/helpers/fake-d1.ts` — `PRAGMA foreign_keys = ON` so the harness enforces FKs like D1.
- `tests/db.test.ts` — regression test: delete a target that still has posts.
- Commits: `67d2a4a` (feat: watch list + seed script), `dba7a02` (fix: delete FK cascade).

## Decisions
- **Flat file + sync script over editing `seed.sql` or a file in `src/`.** D1 is the runtime source of truth (nothing reads a file at runtime); `seed.sql` is one-shot bootstrap that drifts once you curate live. A data file in `src/` would mislead (that dir is the bundled Worker). So: `watch-handles.txt` at repo root, synced through the existing validated API routes.
- **App-level cascade (delete posts then target) over schema `ON DELETE CASCADE`.** The latter would require a live D1 table rebuild; the app-level fix works on the existing deployed schema and is uniform across installs. Left `schema.sql` unchanged.
- **Hardened the test harness (FK on) as part of the fix**, since FK-off was the reason the bug was invisible to tests.

## Notes
- MCP server build output (`mcp/dist/`) is gitignored; MCP client config lives in project-local Claude settings (not committed). Verified via `list_watched_accounts` returning the 7 handles and a refresh pulling 280 tweets.
- Trigger token was rotated this session (the old one leaked into the transcript during manual curl/seed runs).
- First *autonomous* cron run (Mon 11:00 UTC) had not yet fired post-release — worth confirming on the next Monday.
- Deferred to later sessions: Apify usage-based migration, the aaronroy.com writeup, and the `docs/briefing-example.png` screenshot (user is tweaking Discord delivery first).
