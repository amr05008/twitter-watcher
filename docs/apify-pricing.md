# Apify pricing: can we get below the $29/mo floor?

**Verdict (2026-06-01): No — not on Apify. Investigated and dropped.** Switching from
the rental actor to a usage-based one does **not** save money, because Apify's platform
plan is the binding cost, not the actor's per-tweet rate. This doc records why, so the
question doesn't get re-opened on a false premise.

> ⚠️ An earlier version of this doc claimed a usage-based actor would cost "well under
> $1/month — a 30× saving." **That was wrong.** It priced the actor's *usage* but ignored
> Apify's platform-plan floor (below). The corrected analysis is here.

## The binding constraint: Apify's platform plan, not the actor

Apify usage has two layers: the **platform plan** (a subscription) and the **actor**
(rental fee or per-result usage, drawn from the plan's credit). The actor rate is cheap;
the platform floor is not avoidable:

- **No pay-as-you-go without a subscription.** The Free plan gives **$5/mo credit**, resets
  monthly, **cannot pay overage**, and you can't add a card to keep going past it
  ([help](https://help.apify.com/en/articles/11079614-reaching-platform-limits)). To run
  any actor at real volume you must subscribe to a paid plan.
- **Cheapest paid plan is Starter, still $29/mo** ([pricing](https://apify.com/pricing)).
  The $29 comes back as $29 of usage credit, so light usage is "free" *within* the $29 —
  but the $29 floor itself is unavoidable.
- **Usage-based actors are demo-capped (~10 items) on the Free plan.** This is a
  publisher restriction apidojo sets, lifted only by a paid plan
  ([monetize docs](https://docs.apify.com/platform/actors/publishing/monetize)). So the
  "~$1/mo of tweets fits inside the $5 free credit → effectively free" idea is blocked
  regardless of the credit math.

**Net:** all-in cheapest viable cost is **$29/mo either way**. For our ~2.3K tweets/month
(~$1 of usage), switching actors just leaves more of the $29 credit unspent — it doesn't
lower the bill.

**Confirmed on the actual invoice (2026-06):** a single "Starter plan (monthly) $29.00"
line (+ local tax), with **no separate actor/rental charge**. So the current
`apidojo/tweet-scraper` adds nothing on top of the platform plan — the $29 *is* the whole
cost, and switching actors would save exactly $0.

## What we actually use

- Weekday briefing: ~7 handles × ~15 tweets × 5 days ≈ **~2.3K tweets/month**, plus a few `discover` calls.
- That's ~$1/mo of actual usage against a $29 plan — i.e. ~$28/mo of credit is wasted.

## The actors (researched 2026-05-31, for the record)

If the platform economics ever change (a real Apify PAYG tier, or leaving Apify), this is
the actor landscape. `twitter-scraper-lite` is a confirmed near drop-in for our code; the
others would need work.

| Actor | Per-tweet rate | Input compat | Output compat | Notes |
| --- | --- | --- | --- | --- |
| `apidojo/tweet-scraper` (current) | no separate charge — runs within the $29 plan | — | — | What we run today. |
| [`apidojo/twitter-scraper-lite`](https://apify.com/apidojo/twitter-scraper-lite) | event-based, ~$0.40/1K | ✅ identical (`twitterHandles`, `searchTerms`, `maxItems`, `sort`, `tweetLanguage`) | ✅ same shape; body is `text` but our `normalize()` already does `fullText ?? text` | Same vendor; would be a **secret-only swap**. 4.5★, ~27K users. |
| [`xquik/x-tweet-scraper`](https://apify.com/xquik/x-tweet-scraper) | $0.15/1K (+1GB start fee) | ✅ keeps `twitterHandles` (but `queryType`/`lang` field-name ambiguity) | ⚠ `author.username` lowercase, `isRetweet` maybe missing, no `twitterUrl` → normalizer patch | Cheapest, but unproven (948 users, 5 reviews). |
| [`kaitoeasyapi/...pay-per-result-cheapest`](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest) | $0.25/1K (→$0.18 tiered) | ❌ no batch handles — must build `from:<handle>` search queries | ✅ close (`author.userName`, `isRetweet`, `twitterUrl`) | Most battle-tested (38.4M runs); biggest migration. |

## If you still want below $29

Apify can't do it. The only path is **leaving Apify** for a no-subscription, pay-per-use
tweet API (e.g. twitterapi.io-style, ~$0.15/1K, card-on-file, no monthly floor). That's a
separate, larger project — new integration plus reliability/ToS diligence — not an actor
swap. Not pursued as of 2026-06-01.

Alternatively: accept the $29 floor and **use the wasted ~$28/mo credit** — more watched
accounts, a second source (the Reddit adapter), or higher cadence all fit inside it at no
extra cost.

## Sources

- [Apify pricing](https://apify.com/pricing) · [reaching platform limits](https://help.apify.com/en/articles/11079614-reaching-platform-limits) · [actor monetization](https://docs.apify.com/platform/actors/publishing/monetize)
- [apidojo/tweet-scraper](https://apify.com/apidojo/tweet-scraper) · [apidojo/twitter-scraper-lite](https://apify.com/apidojo/twitter-scraper-lite)
- [kaitoeasyapi cheapest tweet scraper](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest) · [xquik/x-tweet-scraper](https://apify.com/xquik/x-tweet-scraper)
