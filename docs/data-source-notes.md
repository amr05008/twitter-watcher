# Data source notes

The tweet data source is [twitterapi.io](https://twitterapi.io) — pay-as-you-go,
~$0.40/mo at this project's volume (~2,300 tweets/month at ~$0.15/1k tweets). This doc
records why, so the choice isn't re-litigated.

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
