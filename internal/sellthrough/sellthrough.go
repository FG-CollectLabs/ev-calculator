// Package sellthrough computes the price you have to list at to clear a
// single in your target window, given current inventory depth and
// recent weekly velocity.
//
// Model (intentionally simple — refine later):
//
//   1. We have depth_to_plus_X_units for X in {10, 25, 50}: the count
//      of cheaper listings up to +X% of market. Plus listing_count
//      (everything) and units_sold_week (recent weekly velocity).
//   2. To clear in T weeks, every listing priced below ours must sell
//      first. So we want: depth_at_our_price / units_sold_week <= T.
//   3. Walk the depth tiers from cheapest (market or below) up. The
//      first tier whose depth/velocity <= T is the price ceiling.
//
// Limitations: ignores price elasticity (a buyer's willingness to pay
// changes with price, which compresses the curve); ignores phantom
// listings; treats velocity as constant. Good enough as a v1 anchor.
package sellthrough

import "github.com/FG-CollectLabs/ev-calculator/internal/pricing"

// Recommendation is the per-card output: a target listing price plus
// the assumptions we used so it's auditable.
type Recommendation struct {
	TargetPriceCents   int32  `json:"target_price_cents"`
	TargetTier         string `json:"target_tier"` // "market", "+10%", "+25%", "+50%", "lowest_legit"
	DepthAheadUnits    int32  `json:"depth_ahead_units"`
	WeeklyVelocity     int32  `json:"weekly_velocity"`
	ExpectedWeeks      float64 `json:"expected_weeks"`
	Confidence         string `json:"confidence"` // "high"|"med"|"low"|"unknown"
	Note               string `json:"note,omitempty"`
}

// Recommend picks a listing price targeting `targetDays`. Returns
// Confidence="unknown" with TargetPriceCents=0 if upstream depth/
// velocity fields aren't populated yet (the gap noted in decisions.md).
func Recommend(p pricing.PriceRow, targetDays int) Recommendation {
	if p.UnitsSoldWeek == nil || p.MarketPriceCents == nil {
		return Recommendation{Confidence: "unknown", Note: "missing market or velocity"}
	}
	weeks := float64(targetDays) / 7.0
	v := float64(*p.UnitsSoldWeek)
	if v <= 0 {
		// No recorded sales — fall back to lowest_legit so we beat the floor.
		if p.LowestLegitCents != nil {
			return Recommendation{
				TargetPriceCents: *p.LowestLegitCents,
				TargetTier:       "lowest_legit",
				WeeklyVelocity:   0,
				Confidence:       "low",
				Note:             "zero weekly sales recorded; priced at lowest_legit",
			}
		}
		return Recommendation{Confidence: "low", Note: "zero weekly sales and no lowest_legit"}
	}

	mkt := *p.MarketPriceCents
	tiers := []struct {
		name     string
		mult     float64
		depth    *int32
	}{
		{"market", 1.00, ptrI32(0)}, // assume zero depth at market by definition
		{"+10%", 1.10, p.DepthToPlus10Units},
		{"+25%", 1.25, p.DepthToPlus25Units},
		{"+50%", 1.50, p.DepthToPlus50Units},
	}

	for _, t := range tiers {
		if t.depth == nil {
			continue
		}
		expected := float64(*t.depth) / v
		if expected <= weeks {
			return Recommendation{
				TargetPriceCents: int32(float64(mkt) * t.mult),
				TargetTier:       t.name,
				DepthAheadUnits:  *t.depth,
				WeeklyVelocity:   int32(v),
				ExpectedWeeks:    expected,
				Confidence:       "med",
			}
		}
	}
	// Even +50% won't clear in window: fall back to market and flag.
	return Recommendation{
		TargetPriceCents: mkt,
		TargetTier:       "market",
		WeeklyVelocity:   int32(v),
		Confidence:       "low",
		Note:             "target window not achievable at +50%; pricing at market",
	}
}

func ptrI32(v int32) *int32 { return &v }
