// Package pricing defines the Pricer interface and the data shape every
// price source returns. Two implementations live alongside this file:
// market-tracker (HTTP to market-tracker-backend) and TCGCSV (a free
// public mirror of TCGplayer prices).
package pricing

import "context"

// PriceRow is the canonical price shape across every source. Listing-
// count and depth fields are populated only by sources that have them
// (market-tracker once the upstream change lands; TCGCSV doesn't have
// them).
type PriceRow struct {
	DisplayKey           string   `json:"display_key"`
	Kind                 string   `json:"kind"` // "card"|"sealed"
	Source               string   `json:"source"`
	WeekStartDate        string   `json:"week_start_date,omitempty"`
	CapturedAt           string   `json:"captured_at,omitempty"`
	MarketPriceCents     *int32   `json:"market_price_cents"`
	LowestPriceCents     *int32   `json:"lowest_price_cents"`
	LowestLegitCents     *int32   `json:"lowest_legit_cents"`
	MedianPriceCents     *int32   `json:"median_price_cents"`
	ListingCount         *int32   `json:"listing_count,omitempty"`
	UnitsSoldWeek        *int32   `json:"units_sold_week,omitempty"`
	AddBackUnitsWeek     *int32   `json:"add_back_units_week,omitempty"`
	DepthToPlus10Units   *int32   `json:"depth_to_plus_10_units,omitempty"`
	DepthToPlus25Units   *int32   `json:"depth_to_plus_25_units,omitempty"`
	DepthToPlus50Units   *int32   `json:"depth_to_plus_50_units,omitempty"`
	SealedToSinglesEvPct *float64 `json:"sealed_to_singles_ev_pct,omitempty"`
}

// Lookup is a single price request. DisplayKey is the canonical key the
// caller wants prices keyed by in the response. The optional fields
// help sources where DisplayKey alone isn't a key (TCGCSV needs the
// TCGplayer productId + finish).
type Lookup struct {
	DisplayKey         string
	Kind               string // "card"|"sealed"
	TCGPlayerProductID string
	Finish             string // "nf"|"f"|"e"
}

// Pricer resolves a batch of lookups to PriceRows keyed by DisplayKey.
// Missing keys are simply absent from the map.
type Pricer interface {
	Lookup(ctx context.Context, reqs []Lookup) (map[string]PriceRow, error)
}

func ptrI32(v int32) *int32 { return &v }

// usdToCents rounds a USD float to cents, returning nil for non-positive.
func usdToCents(usd float64) *int32 {
	if usd <= 0 {
		return nil
	}
	c := int32(usd*100 + 0.5)
	return &c
}
