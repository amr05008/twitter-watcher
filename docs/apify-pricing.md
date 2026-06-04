# Why we left Apify (2026-06)

**Resolved: migrated the tweet data source from Apify to [twitterapi.io](https://twitterapi.io)
(pay-as-you-go, ~$0.40/mo). Ongoing cost dropped from ~$29/mo to ~$0.40/mo.** This doc records
why, so the decision isn't re-litigated.

## The problem: Apify's $29/mo floor

This project pulled tweets through an Apify actor (`apidojo/tweet-scraper`). For ~2,300
tweets/month the actual *usage* was ~$1/mo — but Apify has **no pay-as-you-go below a paid
plan**:

- The Free plan gives $5/mo credit, can't pay overage, and can't add a card to continue past it.
- Usage-based actors are demo-capped (~10 items) on the Free plan regardless of credit.
- The cheapest paid plan is **Starter, $29/mo**.

So the all-in floor was $29/mo no matter how little we used. Confirmed on the actual invoice: a
single "Starter plan $29.00" line, no separate actor charge. Switching to a *different Apify
actor* (e.g. the usage-based `twitter-scraper-lite`) would **not** have helped — same $29 platform
floor. (An earlier version of this doc wrongly claimed a 30× saving from a usage-based actor; it
had priced the actor usage but ignored the platform floor.)

## Why twitterapi.io

Both Apify's actors and twitterapi.io are gray-area scrapers (neither uses the official X API),
so switching gave up no legitimacy — just a vendor with **true pay-as-you-go and no subscription
floor**:

- **~$0.15/1k tweets**, prepaid credit, no monthly minimum → ~$0.40/mo at our volume.
- Real operation: a registered LLC, ~18 months live, ~21K users / >99% success rate on its own
  Apify marketplace presence. Not vaporware, though a small/pseudonymous operator.
- Clean fit: `GET /twitter/user/last_tweets?userName=<handle>` returns the fields we already
  normalize (`id`, `text`, `url`, `createdAt`, `author.userName`); advanced search covers `discover`.

The tradeoff we accepted: a smaller vendor that could break or disappear. Mitigations already in
place — the `SourceAdapter` boundary makes the data source a contained swap, the Monday liveness
ping surfaces a silent break within a week, and rollback is `git revert` + re-subscribe Apify.

## If twitterapi.io ever fails

Rollback = revert the migration commit, restore the `APIFY_*` secrets, and re-subscribe Apify.
Going below twitterapi.io's price isn't really possible without self-hosting a scraper
(Nitter/snscrape/twscrape are dead or high-maintenance in 2026). The official X API is ~25–30×
more expensive and its free tier can't read timelines.

## Sources

- [Apify pricing](https://apify.com/pricing) · [reaching platform limits](https://help.apify.com/en/articles/11079614-reaching-platform-limits)
- [twitterapi.io pricing](https://twitterapi.io/pricing) · [last_tweets endpoint](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)
