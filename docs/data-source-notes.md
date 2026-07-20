# Data source notes

The tweet data source is [twitterapi.io](https://twitterapi.io) — pay-as-you-go,
~$0.40/mo at this project's volume (~2,300 tweets/month at ~$0.15/1k tweets). This doc
records why, so the choice isn't re-litigated.

**Official X API comparison (confirmed 2026-06-30).** Moving the same ~2,300 tweets/mo to
the official X API (pay-per-use, $0.005/read) would cost **~$11.50/mo — ~29×** — for zero
functional change. The official path is only *required* if this becomes a resold,
multi-tenant product (X ToS bars reselling scraped data); for the current single-user feed
the ToS trigger doesn't apply, so twitterapi.io stays. If it ever does go paid, cost scales
per user: ~100 users ≈ $1,150/mo, and ~870 users hits the 2M-read/mo pay-per-use cap and the
~$42k/mo Enterprise floor — that cliff, not the $11.50, is the monetization go/no-go.

## Selection criteria

The data source is the one external dependency with real recurring cost and real fragility,
so it was chosen against a few hard requirements:

- **True pay-as-you-go, no subscription floor.** Most managed scraper platforms gate usage
  behind a paid plan — typically a ~$29/mo minimum that you pay even when actual usage is
  ~$1. A single-user project can't justify that. twitterapi.io bills prepaid credit at
  ~$0.15/1k tweets with no monthly minimum, which is the difference between ~$0.40/mo and
  ~$29/mo at this volume.
- **A clean fit for the data already normalized.** `GET /twitter/user/last_tweets?userName=<handle>`
  returns `id`, `text`, `url`, `createdAt`, `author.userName` — the exact fields the ingest
  path maps — and advanced search covers `discover`.
- **A real operator.** A registered LLC, ~18 months live, with a public track record
  (~21K users / >99% success rate on its marketplace presence). Small and pseudonymous, but
  not vaporware.

## Endpoints in use

| Endpoint | Used by | Notes |
| --- | --- | --- |
| `GET /twitter/user/last_tweets` | `ingest` (watched-account refresh), `explore.getAccountTweets` (any handle, paginated) | Tweets nest under `data.tweets`. Omits replies unless `includeReplies=true` — explore passes it (a mostly-replies account otherwise looks years stale); ingest deliberately doesn't (briefing stays originals-only). |
| `GET /twitter/tweet/advanced_search` | `discover` (one page → Claude), `explore.searchTweets` (paginated raw) | Full Twitter query syntax; `queryType=Latest\|Top`; tweets top-level under `tweets`. |
| `GET /twitter/user/followings` | `explore.getAccountFollowing` | `pageSize` 20–200; returns userName/name/followers/description. |

The `explore.*` calls (added for interactive Claude Code sessions) all go through
`src/twitterapi.ts`, which centralizes the `X-API-Key` header and cursor pagination
(`has_next_page` / `next_cursor`). They're read-only and pull a larger swath of raw data
(default 150 / cap 1000 items per call); the briefing pipeline is untouched.

### advanced_search quirks (silent failures)

twitterapi.io's `advanced_search` fails *quietly* — it returns an empty `tweets` array rather
than an error — in two cases we hit:

- The **`min_faves:` operator** zeroes out results (verified: identical query returned 30 without
  it, 0 with `min_faves:5`). Filter by the returned engagement counts in-session instead.
- **Over-long queries** zero out too (a ~7×9-term two-group query returned 0; ~3×4 and ~7×7
  worked). Keep `OR` groups small.

Plain `OR`, parentheses, quoted phrases, `from:`, and `-filter:replies`/`-filter:retweets` all
work as expected.

## The tradeoff

twitterapi.io is a gray-area scraper — it doesn't use the official X API. So is essentially
every affordable option: the official X API is ~25–30× more expensive and its free tier
can't read timelines at all. Choosing a scraper gave up no legitimacy that a pricier managed
alternative would have kept.

The real risk accepted is a smaller vendor that could break or disappear. Three mitigations
are already in place:

- The **`SourceAdapter` boundary** (`src/adapters/`) makes the data source a contained swap —
  the briefing logic never names the vendor.
- The **Monday liveness ping** surfaces a silent break within a week (see the README's
  "quiet vs. dead" note).
- **Per-handle error isolation** on refresh means one failing handle can't sink the whole run.

## If twitterapi.io ever fails

Swapping providers is a single adapter change behind `SourceAdapter`. Going below its price
isn't really possible without self-hosting a scraper (Nitter / snscrape / twscrape are dead or
high-maintenance in 2026), and the official X API is far more expensive with no timeline read
on the free tier — so the realistic move is another pay-as-you-go scraper, not a category change.

## Sources

- [twitterapi.io pricing](https://twitterapi.io/pricing) · [last_tweets endpoint](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)
