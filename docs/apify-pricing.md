# Apify pricing: moving off the $29/mo floor

This project pulls tweets through an [Apify](https://apify.com) actor. The default
actor, `apidojo/tweet-scraper`, is a **rental** actor — it needs the Apify Starter
plan (**$29/mo**, which includes $29 of usage credit). You pay the $29 whether or
not you use the credit. For a personal weekly briefing, that's almost all wasted.

This doc is the research behind switching to **usage-based** pricing. No code has
changed yet — it's a recommendation plus the migration notes.

## What I actually use

- Weekly briefing: ~8 watched handles × ~40 tweets ≈ **320 tweets/week ≈ ~1.3K/month**, plus a handful of `discover` calls.
- If I move to daily later: ~3.6K tweets/month.

## The options (May 2026)

| Actor | Pricing | Notes |
| --- | --- | --- |
| `apidojo/tweet-scraper` (current) | **$29/mo rental** | Fixed floor. What this repo defaults to. |
| [`apidojo/twitter-scraper-lite`](https://apify.com/apidojo/twitter-scraper-lite) | **~$0.20 / 1K results**, usage-based | Same vendor → likely the same result shape, so the smallest migration. |
| [`kaitoeasyapi/...pay-per-result-cheapest`](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest) | **$0.25 / 1K tweets** | Different output schema. |
| [`xquik/x-tweet-scraper`](https://apify.com/xquik/x-tweet-scraper) | **$0.15 / 1K tweets** | Cheapest per tweet; different schema. |

## The math

At ~1.3K–3.6K tweets/month, a pay-per-result actor costs **well under $1/month** vs
the $29 rental floor — a **30×+ saving**, with no monthly minimum.

| | Rental | Pay-per-result @ $0.25/1K |
| --- | --- | --- |
| Weekly (~1.3K/mo) | $29 | ~$0.33 |
| Daily (~3.6K/mo) | $29 | ~$0.90 |

## Recommendation

**Start with `apidojo/twitter-scraper-lite`.** It's the same vendor as the current
actor, so the JSON result shape is most likely identical — meaning the migration may
be as small as swapping `APIFY_ACTOR_ID` and verifying the input parameter names.
Only fall back to `kaitoeasyapi` / `xquik` if the per-tweet price difference matters
at higher volume.

## Migration risk to know before you switch

The current ingest path (`src/ingest.ts`) sends a **batch of `twitterHandles`** to
the actor. Most pay-per-result actors **don't accept that input** — they take
`from:<handle>` **search queries** instead. So a vendor switch isn't just a schema
remap; it likely means building `from:` queries in `ingest.ts`, not only updating
`normalize()`.

Touchpoints when you do migrate:

- `APIFY_ACTOR_ID` (env / `wrangler secret`)
- `src/ingest.ts` — the request body (`twitterHandles` vs `from:` search terms), `maxItems`
- `src/discover.ts` — already uses `searchTerms`, so this path is the easier one
- `src/adapters/twitter.ts` — `normalize()`, if the result shape differs
- `tests/fixtures/apify-*.json` — replace with a real payload from the new actor

## Sources

- [Best Twitter/X scrapers on Apify (2026)](https://use-apify.com/docs/best-apify-actors/best-twitter-scrapers)
- [apidojo/tweet-scraper](https://apify.com/apidojo/tweet-scraper) · [apidojo/twitter-scraper-lite](https://apify.com/apidojo/twitter-scraper-lite)
- [kaitoeasyapi cheapest tweet scraper](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest) · [xquik/x-tweet-scraper](https://apify.com/xquik/x-tweet-scraper)
