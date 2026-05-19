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
	TargetPriceCents   int32   `json:"target_price_cents"`
	TargetTier         string  `json:"target_tier"` // "market", "+10%", "+25%", "+50%", "lowest_legit"
	DepthAheadUnits    int32   `json:"depth_ahead_units"`
	WeeklyVelocity     int32   `json:"weekly_velocity"`
	RefillRateWeek     int32   `json:"refill_rate_week"`  // units relisted per week (add_back_units_week)
	NetDrainWeek       int32   `json:"net_drain_week"`    // velocity − refill (true market shrinkage)
	ExpectedWeeks      float64 `json:"expected_weeks"`
	Confidence         string  `json:"confidence"` // "high"|"med"|"low"|"unknown"
	Note               string  `json:"note,omitempty"`
}

// Recommend picks a listing price targeting `targetDays`. Returns
// Confidence="unknown" with TargetPriceCents=0 if upstream depth/
// velocity fields aren't populated yet.
//
// Refill rate: if add_back_units_week is known, we use the net drain
// (sold − relisted) as the effective velocity. A high refill rate means
// the market is restocking as fast as it's selling — you need to price
// lower to actually move ahead of the queue.
func Recommend(p pricing.PriceRow, targetDays int) Recommendation {
	if p.UnitsSoldWeek == nil || p.MarketPriceCents == nil {
		return Recommendation{Confidence: "unknown", Note: "missing market or velocity"}
	}

	sold := int32(*p.UnitsSoldWeek)
	refill := int32(0)
	if p.AddBackUnitsWeek != nil {
		refill = *p.AddBackUnitsWeek
	}
	// Net drain is the true market shrinkage — sellers refilling offset buyers.
	netDrain := sold - refill
	if netDrain < 0 {
		netDrain = 0
	}

	weeks := float64(targetDays) / 7.0
	// Use net drain as effective velocity; fall back to gross sold when refill unknown.
	v := float64(netDrain)
	if p.AddBackUnitsWeek == nil {
		v = float64(sold)
	}

	base := Recommendation{
		WeeklyVelocity: sold,
		RefillRateWeek: refill,
		NetDrainWeek:   netDrain,
	}

	if v <= 0 {
		if p.LowestLegitCents != nil {
			base.TargetPriceCents = *p.LowestLegitCents
			base.TargetTier = "lowest_legit"
			base.Confidence = "low"
			base.Note = "zero net drain; priced at lowest_legit"
			return base
		}
		base.Confidence = "low"
		base.Note = "zero net drain and no lowest_legit"
		return base
	}

	mkt := *p.MarketPriceCents
	tiers := []struct {
		name  string
		mult  float64
		depth *int32
	}{
		{"market", 1.00, ptrI32(0)},
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
			base.TargetPriceCents = int32(float64(mkt) * t.mult)
			base.TargetTier = t.name
			base.DepthAheadUnits = *t.depth
			base.ExpectedWeeks = expected
			base.Confidence = "med"
			return base
		}
	}

	base.TargetPriceCents = mkt
	base.TargetTier = "market"
	base.Confidence = "low"
	base.Note = "target window not achievable at +50%; pricing at market"
	return base
}

func ptrI32(v int32) *int32 { return &v }
