# ev-calculator

V2 of the FutureGadgetCollections collection-admin EV tool. Decides what
sealed product is worth buying by pricing every constituent single
against the market-tracker price oracle, applying fees, and comparing
to box cost.

## Shape

- **Go 1.25** service + CLI; no DB of its own.
- **Inputs:** hand-curated YAML decklists in `data/decks/`.
- **Prices:** HTTP to `market-tracker-backend` (`POST /v1/prices/batch`).
  See `docs/decisions.md` for the field-set the calculator depends on.
- **Outputs:** JSON report; `cmd/ev` prints a human-readable summary,
  `cmd/api` exposes `GET /v1/ev/{deck_key}` for the frontend.

## Binaries

| Binary    | Purpose                                                 |
|-----------|---------------------------------------------------------|
| `cmd/api` | Long-running HTTP service for the future Vite frontend. |
| `cmd/ev`  | One-shot CLI: `ev report aetherdrift-commander-display` |

## First product

Aetherdrift commander display (set code `dft`):

- `data/decks/aetherdrift/display.yaml` — the box (2x of each deck).
- `data/decks/aetherdrift/deck-a.yaml` — deck 1 contents.
- `data/decks/aetherdrift/deck-b.yaml` — deck 2 contents.

Card lines reference market-tracker `display_key` directly so there's
no name-resolution layer.

## Configuration

| Env                         | Default                  | Notes |
|-----------------------------|--------------------------|-------|
| `EV_API_ADDR`               | `:8081`                  | API listen addr |
| `EV_MARKET_TRACKER_BASE_URL`| `http://localhost:8080`  | market-tracker-backend root |
| `EV_MARKET_TRACKER_TOKEN`   | (empty)                  | Bearer if you ever gate `/v1/prices/batch` |
| `EV_LOW_VALUE_FLOOR_CENTS`  | `25`                     | Cards below this are excluded from the singles EV |
| `EV_TARGET_SELLTHROUGH_DAYS`| `90`                     | Default window for sell-through pricing |
| `EV_FEE_PROFILE`            | `tcgplayer-direct`       | See `internal/fees` |
