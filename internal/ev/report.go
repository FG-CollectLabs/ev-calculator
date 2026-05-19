// Package ev assembles the final report: per-card line items, totals,
// and scenario comparisons against the sealed case cost.
package ev

import (
	"context"
	"fmt"

	"github.com/FG-CollectLabs/ev-calculator/internal/decks"
	"github.com/FG-CollectLabs/ev-calculator/internal/fees"
	"github.com/FG-CollectLabs/ev-calculator/internal/listings"
	"github.com/FG-CollectLabs/ev-calculator/internal/pricing"
	"github.com/FG-CollectLabs/ev-calculator/internal/sellthrough"
)

type Options struct {
	LowValueFloorCents    int32
	TargetSellthroughDays int
	FeeProfile            string
	PriceSource           string // "tcgplayer" by default
	PriceColumn           string // "market"|"direct_low"|"mid"|"low"; default direct_low
}

// grossFromRow picks the gross-price column the user has chosen, with a
// sane fallback chain when the chosen column is null.
func grossFromRow(p pricing.PriceRow, col string) (int32, string, bool) {
	pick := func(name string, v *int32) (int32, string, bool) {
		if v != nil && *v > 0 {
			return *v, name, true
		}
		return 0, "", false
	}
	switch col {
	case "market":
		if c, n, ok := pick("market", p.MarketPriceCents); ok {
			return c, n, true
		}
	case "mid":
		if c, n, ok := pick("mid", p.MedianPriceCents); ok {
			return c, n, true
		}
	case "low":
		if c, n, ok := pick("low", p.LowestPriceCents); ok {
			return c, n, true
		}
	default: // direct_low
		if c, n, ok := pick("direct_low", p.LowestLegitCents); ok {
			return c, n, true
		}
	}
	// Fallback chain: market -> direct_low -> mid -> low.
	for _, opt := range []struct {
		name string
		v    *int32
	}{
		{"market", p.MarketPriceCents},
		{"direct_low", p.LowestLegitCents},
		{"mid", p.MedianPriceCents},
		{"low", p.LowestPriceCents},
	} {
		if c, n, ok := pick(opt.name, opt.v); ok {
			return c, n, true
		}
	}
	return 0, "", false
}

type LineItem struct {
	DisplayKey         string            `json:"display_key"`
	Name               string            `json:"name,omitempty"`
	Quantity           int               `json:"qty"`
	Note               string            `json:"note,omitempty"`
	TCGPlayerProductID string            `json:"tcgplayer_product_id,omitempty"`
	Finish             string            `json:"finish,omitempty"` // "nf" | "f" | "e"
	Price              *pricing.PriceRow `json:"price,omitempty"`
	// MarketPriceCents is the TCGPlayer market price (midpoint of recent sales).
	// This is the primary EV basis used for net calculations.
	MarketPriceCents *int32 `json:"market_price_cents,omitempty"`
	// DirectLowCents is the lowest price from vetted TCGPlayer Direct sellers.
	DirectLowCents  *int32 `json:"direct_low_cents,omitempty"`
	// Platform-specific net after fees, per copy.
	//
	// TCGPlayerNet is a regime-aware breakdown (buyer-paid/PWE/tracked) so
	// the frontend can show how the net was derived. NetPerCopyCents inside
	// the breakdown is what feeds IncludedNetCents below.
	TCGPlayerNet     *fees.NetBreakdown `json:"tcgplayer_net,omitempty"`
	ManapoolNetCents *int32             `json:"manapool_net_cents,omitempty"` // market × (1 - Manapool fees); nil when no Manapool price
	// EbayNetCents is market after eBay fees (13.25%) and shipping (ESE $0.89 for <$20, bubble $3.75 for $20+).
	// Represents what you pocket if you list at market with free shipping.
	EbayNetCents      *int32 `json:"ebay_net_cents,omitempty"`
	// EV roll-up fields (use market price as basis).
	NetPerCopyCents int32 `json:"net_per_copy_cents"` // = TCGPlayerNet.NetPerCopyCents (primary channel)
	NetTotalCents   int32 `json:"net_total_cents"`    // NetPerCopyCents × Quantity
	IncludedInEV    bool  `json:"included_in_ev"`
	ExcludeReason   string `json:"exclude_reason,omitempty"`
	SellthroughRec  *sellthrough.Recommendation `json:"sellthrough,omitempty"`
	LiveDepth       map[string]*listings.SellRecommendation `json:"live_depth,omitempty"`
}

// DeckReport covers one precon deck within a case.
//
// Three comparison points:
//  1. SealedMarketCents – what the sealed deck sells for on the market (gross).
//  2. SealedNetCents    – after applying sell fees to the sealed price.
//  3. IncludedNetCents  – net proceeds if you crack it and sell every card.
//
// SinglesDeltaCents = IncludedNetCents - SealedMarketCents (positive = singles win).
//
// SealedLiveDepth holds live listing depth for the sealed deck itself (not
// individual cards), keyed by platform. Used to answer "at what price does
// the sealed deck sell in X days on platform Y?"
type DeckReport struct {
	DeckKey          string     `json:"deck_key"`
	Name             string     `json:"name"`
	Image            string     `json:"image,omitempty"`
	Channels         []string   `json:"channels,omitempty"`           // preferred sell channels
	LineItems              []LineItem `json:"line_items"`
	IncludedNetCents       int32      `json:"included_net_cents"`                // singles net after TCGPlayer fees (primary)
	ManapoolIncludedNetCents int32    `json:"manapool_included_net_cents"`       // singles net after Manapool 8% fees
	ExcludedNetCents       int32      `json:"excluded_net_cents"`                // below-floor cards net (informational)
	SealedMarketCents *int32    `json:"sealed_market_cents,omitempty"` // gross market price of sealed deck
	SealedNetCents    *int32    `json:"sealed_net_cents,omitempty"`    // sealed price after sell fees
	SealedLiveDepth  map[string]*listings.SellRecommendation `json:"sealed_live_depth,omitempty"` // keyed by platform
	SinglesDeltaCents *int32    `json:"singles_delta_cents,omitempty"` // singles net − sealed market
	SinglesDeltaPct   *float64  `json:"singles_delta_pct,omitempty"`
	Copies            int       `json:"copies"` // copies of this deck in the parent case
}

// DisplayReport covers a full sealed case across three EV scenarios.
//
// Scenario A – Sell sealed decks: buy the case, sell each contained deck
// sealed on the secondary market.
//   Revenue = SealedDecksNetCents (fees applied to each deck's market price)
//   Cost    = CaseCostCents
//   Delta   = SealedDecksDeltaCents
//
// Scenario B – Sell singles: buy the case, crack every deck, sell each card.
//   Revenue = SinglesNetCents (fees applied to each card's chosen price column)
//   Cost    = CaseCostCents
//   Delta   = SinglesDeltaCents
//
// BestScenario names whichever scenario has the higher delta ("sealed_decks",
// "singles", or "" when cost data is unavailable).
type DisplayReport struct {
	DisplayKey  string       `json:"display_key"`
	Name        string       `json:"name"`
	SetCode     string       `json:"set_code,omitempty"`
	ProductType string       `json:"product_type,omitempty"` // e.g. "commander_case"
	FeeProfile  string       `json:"fee_profile,omitempty"`  // e.g. "tcgplayer-marketplace-l4"
	Decks       []DeckReport `json:"decks"`

	// Buy side
	CaseCostCents *int32 `json:"case_cost_cents,omitempty"` // sealed case market price

	// Scenario A: sell each deck sealed
	SealedDecksGrossCents int32    `json:"sealed_decks_gross_cents"`            // sum(deck market × copies)
	SealedDecksNetCents   int32    `json:"sealed_decks_net_cents"`              // sum(deck net × copies)
	SealedDecksDeltaCents *int32   `json:"sealed_decks_delta_cents,omitempty"`  // SealedDecksNet − CaseCost
	SealedDecksDeltaPct   *float64 `json:"sealed_decks_delta_pct,omitempty"`

	// Scenario B: crack and sell singles
	SinglesNetCents   int32    `json:"singles_net_cents"`
	SinglesDeltaCents *int32   `json:"singles_delta_cents,omitempty"` // SinglesNet − CaseCost
	SinglesDeltaPct   *float64 `json:"singles_delta_pct,omitempty"`

	BestScenario string `json:"best_scenario,omitempty"` // "sealed_decks" | "singles"
}

type Builder struct {
	Pricer          pricing.Pricer
	Decks           map[string]decks.Deck
	Opts            Options
	// ListingFetchers provides live depth per platform (e.g. "tcgplayer",
	// "manapool"). When set, each card LineItem gets a LiveDepth entry for
	// each fetcher whose product ID is known. Fetcher errors are logged and
	// skipped so a failing scrape never breaks the EV report.
	ListingFetchers map[string]listings.Fetcher
}

func (b *Builder) BuildDisplay(ctx context.Context, d decks.Display) (DisplayReport, error) {
	fp := fees.Get(b.Opts.FeeProfile)
	out := DisplayReport{
		DisplayKey:  d.ProductDisplayKey,
		Name:        d.Name,
		SetCode:     d.SetCode,
		ProductType: d.Type,
		FeeProfile:  fp.Name,
	}

	// Collect price lookups: every card component, every sealed deck, and
	// the case itself.
	seen := map[string]struct{}{}
	var lookups []pricing.Lookup

	addCard := func(c decks.Component) {
		key := c.DisplayKey
		if c.ReplaceWith != "" {
			key = c.ReplaceWith
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		lookups = append(lookups, pricing.Lookup{
			DisplayKey:         key,
			Kind:               "card",
			TCGPlayerProductID: c.TCGPlayerProductID,
			Finish:             c.Finish,
		})
	}

	for _, dc := range d.Decks {
		dk, ok := b.Decks[dc.DeckKey]
		if !ok {
			return out, fmt.Errorf("deck %q referenced by display not loaded", dc.DeckKey)
		}
		for _, c := range dk.Components {
			addCard(c)
		}
		if _, ok := seen[dk.ProductDisplayKey]; !ok && dk.ProductDisplayKey != "" {
			seen[dk.ProductDisplayKey] = struct{}{}
			lookups = append(lookups, pricing.Lookup{
				DisplayKey:         dk.ProductDisplayKey,
				Kind:               "sealed",
				TCGPlayerProductID: dk.ProductTCGPlayerID,
				Finish:             "nf",
			})
		}
	}

	// Case sealed price (direct product).
	if _, ok := seen[d.ProductDisplayKey]; !ok && d.ProductDisplayKey != "" {
		seen[d.ProductDisplayKey] = struct{}{}
		lookups = append(lookups, pricing.Lookup{
			DisplayKey:         d.ProductDisplayKey,
			Kind:               "sealed",
			Finish:             "nf",
			TCGPlayerProductID: d.ProductTCGPlayerID,
		})
	}
	// Set-of-N fallback for case cost (e.g. DRC has no full-case TCGPlayer
	// product; instead we look up the "set of 2" and multiply).
	setOfNKey := d.ProductDisplayKey + ":set-of-n"
	if d.ProductSetOfNTCGPlayerID != "" && d.SetsOfNPerCase > 0 {
		if _, ok := seen[setOfNKey]; !ok {
			seen[setOfNKey] = struct{}{}
			lookups = append(lookups, pricing.Lookup{
				DisplayKey:         setOfNKey,
				Kind:               "sealed",
				TCGPlayerProductID: d.ProductSetOfNTCGPlayerID,
				Finish:             "nf",
			})
		}
	}

	prices, err := b.Pricer.Lookup(ctx, lookups)
	if err != nil {
		return out, err
	}

	// Case buy-side cost: market data first, then set-of-N × multiplier,
	// then the manual YAML fallback (case_price_cents).
	if row, ok := prices[d.ProductDisplayKey]; ok && row.MarketPriceCents != nil {
		out.CaseCostCents = row.MarketPriceCents
	} else if row, ok := prices[setOfNKey]; ok && row.MarketPriceCents != nil && d.SetsOfNPerCase > 0 {
		derived := *row.MarketPriceCents * int32(d.SetsOfNPerCase)
		out.CaseCostCents = &derived
	} else if d.CasePriceCents != nil {
		out.CaseCostCents = d.CasePriceCents
	}

	for _, dc := range d.Decks {
		dk := b.Decks[dc.DeckKey]
		dr := b.buildDeckReport(ctx, dk, prices, fp)
		dr.Copies = dc.Copies

		// Scale per-card totals by copy count.
		for i := range dr.LineItems {
			dr.LineItems[i].NetTotalCents *= int32(dc.Copies)
			dr.LineItems[i].Quantity *= dc.Copies
		}
		dr.IncludedNetCents *= int32(dc.Copies)
		dr.ManapoolIncludedNetCents *= int32(dc.Copies)
		dr.ExcludedNetCents *= int32(dc.Copies)

		// Scenario A accumulation (sealed decks).
		if dr.SealedMarketCents != nil {
			gross := *dr.SealedMarketCents * int32(dc.Copies)
			out.SealedDecksGrossCents += gross
		}
		if dr.SealedNetCents != nil {
			net := *dr.SealedNetCents * int32(dc.Copies)
			out.SealedDecksNetCents += net
		}

		// Scenario B accumulation (singles).
		out.SinglesNetCents += dr.IncludedNetCents

		// Per-deck delta: singles net (×copies) vs sealed net (×copies).
		// Computed here so both sides are in the same units.
		if dr.SealedNetCents != nil {
			sealedNetTotal := *dr.SealedNetCents * int32(dc.Copies)
			delta := dr.IncludedNetCents - sealedNetTotal
			dr.SinglesDeltaCents = &delta
			if sealedNetTotal > 0 {
				pct := float64(delta) / float64(sealedNetTotal)
				dr.SinglesDeltaPct = &pct
			}
		}

		out.Decks = append(out.Decks, dr)
	}

	// Compute deltas vs case cost.
	if out.CaseCostCents != nil && *out.CaseCostCents > 0 {
		caseCost := *out.CaseCostCents

		sealedDelta := out.SealedDecksNetCents - caseCost
		out.SealedDecksDeltaCents = &sealedDelta
		sealedPct := float64(sealedDelta) / float64(caseCost)
		out.SealedDecksDeltaPct = &sealedPct

		singlesDelta := out.SinglesNetCents - caseCost
		out.SinglesDeltaCents = &singlesDelta
		singlesPct := float64(singlesDelta) / float64(caseCost)
		out.SinglesDeltaPct = &singlesPct

		if out.SealedDecksNetCents >= out.SinglesNetCents {
			out.BestScenario = "sealed_decks"
		} else {
			out.BestScenario = "singles"
		}
	}

	return out, nil
}

func (b *Builder) buildDeckReport(ctx context.Context, dk decks.Deck, prices map[string]pricing.PriceRow, fp fees.Profile) DeckReport {
	r := DeckReport{
		DeckKey:  dk.Key,
		Name:     dk.Name,
		Image:    dk.Image,
		Channels: dk.Channels,
	}

	// Sealed deck market price (gross) and net after fees.
	// Falls back to the manual deck_price_cents YAML field when market-tracker
	// has no sealed product data for this deck.
	// Sealed decks ship in a small box (~$5) — we can't bubble-mailer them —
	// so we deduct SealedDeckShippingCents from net after fees.
	sealedShip := fees.DefaultTCGPlayerShipping.SealedDeckShippingCents
	sealedNetAfter := func(gross int32) int32 {
		n := fp.NetCents(gross) - sealedShip
		if n < 0 {
			n = 0
		}
		return n
	}
	if box, ok := prices[dk.ProductDisplayKey]; ok && box.MarketPriceCents != nil {
		r.SealedMarketCents = box.MarketPriceCents
		net := sealedNetAfter(*box.MarketPriceCents)
		r.SealedNetCents = &net
	} else if dk.DeckPriceCents != nil {
		r.SealedMarketCents = dk.DeckPriceCents
		net := sealedNetAfter(*dk.DeckPriceCents)
		r.SealedNetCents = &net
	}

	// Live depth for the sealed deck itself (not individual cards).
	// TCGPlayer: uses ProductTCGPlayerID; Manapool: uses ProductManapoolSlug.
	if len(b.ListingFetchers) > 0 {
		sealedIDs := map[string]string{}
		if dk.ProductTCGPlayerID != "" {
			sealedIDs["tcgplayer"] = dk.ProductTCGPlayerID
		}
		if dk.ProductManapoolSlug != "" {
			sealedIDs["manapool"] = dk.ProductManapoolSlug
		}
		for platform, productID := range sealedIDs {
			fetcher, ok := b.ListingFetchers[platform]
			if !ok {
				continue
			}
			depth, err := fetcher.FetchDepth(ctx, productID)
			if err != nil {
				continue
			}
			if r.SealedLiveDepth == nil {
				r.SealedLiveDepth = make(map[string]*listings.SellRecommendation)
			}
			rec := listings.Recommend(depth, productID, platform, 0, b.Opts.TargetSellthroughDays)
			r.SealedLiveDepth[platform] = &rec
		}
	}

	for _, c := range dk.Components {
		key := c.DisplayKey
		if c.ReplaceWith != "" {
			key = c.ReplaceWith
		}
		li := LineItem{
			DisplayKey:         c.DisplayKey,
			Name:               c.Name,
			Quantity:           c.Quantity,
			Note:               c.Note,
			TCGPlayerProductID: c.TCGPlayerProductID,
			Finish:             c.Finish,
		}
		row, ok := prices[key]
		if !ok {
			li.ExcludeReason = "no price found"
			r.LineItems = append(r.LineItems, li)
			continue
		}
		li.Price = &row
		li.MarketPriceCents = row.MarketPriceCents
		li.DirectLowCents = row.LowestLegitCents

		// Use market price as the EV basis (gross for floor check + net calc).
		grossPerCopy, _, ok := grossFromRow(row, "market")
		if !ok {
			// Fall back to direct_low if market is absent.
			grossPerCopy, _, ok = grossFromRow(row, "direct_low")
		}
		if !ok {
			li.ExcludeReason = "no usable price"
			r.LineItems = append(r.LineItems, li)
			continue
		}

		// Per-platform nets. For singles, strip the per-order flat fee because
		// it applies per ORDER not per card; charging it per card vastly overstates cost.
		singlesProf := fp
		if fp.PerSaleCents > 0 {
			singlesVariant := fees.Get(fp.Name + "-singles")
			if singlesVariant.Name == fp.Name+"-singles" {
				singlesProf = singlesVariant
			} else {
				// No dedicated singles variant: zero out the flat fee inline.
				singlesProf.PerSaleCents = 0
			}
		}
		// Regime-aware TCGPlayer net: PWE / tracked / buyer-paid shipping
		// cost is folded in based on card price. See
		// `.github/projects/ev-calculator/shipping-net-strategy.md`.
		tcgBreakdown := fees.DefaultTCGPlayerShipping.Apply(grossPerCopy, singlesProf)
		li.TCGPlayerNet = &tcgBreakdown
		tcgNet := tcgBreakdown.NetPerCopyCents
		if row.MarketPriceCents != nil {
			mpNet := fees.Get("manapool").NetCents(*row.MarketPriceCents)
			li.ManapoolNetCents = &mpNet
			// eBay net: list at market (free shipping baked into market comps),
			// subtract eBay fees then subtract physical shipping cost.
			ebayGross := fees.Get("ebay").NetCents(*row.MarketPriceCents)
			ebayNet := ebayGross - fees.EbayShippingCents(*row.MarketPriceCents)
			if ebayNet < 0 {
				ebayNet = 0
			}
			li.EbayNetCents = &ebayNet
		}

		li.NetPerCopyCents = tcgNet
		li.NetTotalCents = li.NetPerCopyCents * int32(li.Quantity)

		if !c.LowValueExempt && grossPerCopy < b.Opts.LowValueFloorCents {
			li.IncludedInEV = false
			li.ExcludeReason = fmt.Sprintf("below floor (%d cents)", b.Opts.LowValueFloorCents)
			r.ExcludedNetCents += li.NetTotalCents
		} else {
			li.IncludedInEV = true
			r.IncludedNetCents += li.NetTotalCents
			if li.ManapoolNetCents != nil {
				r.ManapoolIncludedNetCents += *li.ManapoolNetCents * int32(li.Quantity)
			}
		}

		rec := sellthrough.Recommend(row, b.Opts.TargetSellthroughDays)
		li.SellthroughRec = &rec

		// Live depth for individual cards: TCGPlayer only for now.
		// Manapool per-card slugs can be added to Component YAML when needed.
		if fetcher, ok := b.ListingFetchers["tcgplayer"]; ok && c.TCGPlayerProductID != "" {
			depth, err := fetcher.FetchDepth(ctx, c.TCGPlayerProductID)
			if err == nil {
				var velocity int32
				if row.UnitsSoldWeek != nil {
					velocity = *row.UnitsSoldWeek
				}
				rec := listings.Recommend(depth, c.TCGPlayerProductID, "tcgplayer", velocity, b.Opts.TargetSellthroughDays)
				li.LiveDepth = map[string]*listings.SellRecommendation{"tcgplayer": &rec}
			}
		}

		r.LineItems = append(r.LineItems, li)
	}

	return r
}
