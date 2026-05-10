# Decisions

## 2026-05-07 — Repo split, no DB
Backend Go service consumes market-tracker over HTTP. No own Postgres
in v1. Deck contents are YAML in-repo so they're reviewable and
versioned. If we need history of EV-over-time later, a small SQLite
or PG-side table works; not load-bearing yet.

## 2026-05-07 — Pricing source: lowest_legit
Net-after-fees math uses `lowest_legit_cents` per card as the realistic
sell price floor, falling back to `market_price_cents`. Reason: TCG
"market" is the trailing trade average and overstates what a fresh
listing actually clears at; lowest_legit excludes obvious phantom and
mispriced rows so it's the better anchor.

## 2026-05-07 — Sell-through model is depth-and-velocity, no elasticity
v1 picks the cheapest price tier `t` whose `depth_to_plus_t / units_sold_week`
fits the target window. Ignores price elasticity, phantoms, and
seasonality. Refine when this measurably misprices.

## 2026-05-07 — Hard dependency on market-tracker price-batch fields
Sell-through pricing needs `listing_count`, `units_sold_week`, and
`depth_to_plus_{10,25,50}_units` in the `/v1/prices/batch` response.
Today the response only carries the price columns (see
`market-tracker-backend/internal/prices/handler.go`). Until that's
extended, `sellthrough.Recommend` returns Confidence="unknown" and the
report is buy-only.

Action item on the **market-tracker-backend** side:
- Extend `prices.PriceRow` and the `fetchLatest` SELECTs to include
  the listing-count and depth columns from `card_snapshots_weekly` /
  `sealed_snapshots_weekly`.
- No schema change needed — the columns exist.

## 2026-05-07 — Fee model starts as flat percent + per-sale flat
`internal/fees` exposes named profiles (tcgplayer-direct, ebay, etc.).
No per-card variance, no shipping subsidies, no payment-processor
breakouts beyond what the marketplace bundles. Good enough for buy/sell
decisions; revisit if shipping cost becomes meaningful per card.
