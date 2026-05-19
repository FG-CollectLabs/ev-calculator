// Package listings fetches live listing depth from secondary marketplaces
// (TCGPlayer, Manapool) and computes sell-time estimates.
//
// The core model:
//
//	Listings are sorted cheapest-first. At any given price P, every
//	listing priced below P will sell before yours (assuming buyers
//	always buy the cheapest available copy). So:
//
//	  queue_ahead(P) = sum of quantities for all listings with price < P
//	  days_to_sell(P) = queue_ahead(P) / daily_sell_rate
//
//	To find a target price that clears your copy in at most N days:
//	  walk listings from cheapest until cumulative qty >= N * daily_sell_rate
//	  list just below the price of the next listing
package listings

import (
	"context"
	"sort"
)

// Listing is a single marketplace offer: one seller at one price with N copies.
type Listing struct {
	PriceCents   int32
	ShippingCents int32 // 0 for free ship / TCGPlayer Direct
	IsFreeship   bool  // true when shipping_cents == 0 or is TCG Direct
	Quantity     int
	Condition    string // "Near Mint", "Lightly Played", etc.
	Printing     string // "Normal", "Foil", etc.
}

// Depth is the full set of live listings for a product, sorted ascending
// by price. Use the methods below for sell-time analysis.
type Depth struct {
	Listings      []Listing // sorted cheapest-first
	TotalUnits    int
	LowestCents   int32
	UnitsAtLowest int // copies available at the single lowest price point
}

// Fetcher retrieves live listing depth for a product by its platform-specific ID.
type Fetcher interface {
	FetchDepth(ctx context.Context, productID string) (Depth, error)
}

// QueueAhead counts how many units are listed strictly below priceCents.
// These units sell before yours at that price.
func (d *Depth) QueueAhead(priceCents int32) int {
	total := 0
	for _, l := range d.Listings {
		if l.PriceCents >= priceCents {
			break
		}
		total += l.Quantity
	}
	return total
}

// QueueAheadFreeship counts only free-shipping listings below priceCents.
// For cards priced above freeshipThreshCents, buyers strongly prefer free-ship
// sellers — paid-shipping listings are effectively invisible competition.
func (d *Depth) QueueAheadFreeship(priceCents, freeshipThreshCents int32) int {
	if priceCents < freeshipThreshCents {
		return d.QueueAhead(priceCents)
	}
	total := 0
	for _, l := range d.Listings {
		if l.PriceCents >= priceCents {
			break
		}
		if l.IsFreeship {
			total += l.Quantity
		}
	}
	return total
}

// DaysToSell estimates days to sell one copy at priceCents given a daily
// sell rate (units/day). Returns a large value when velocity is zero.
func (d *Depth) DaysToSell(priceCents int32, dailyRate float64) float64 {
	if dailyRate <= 0 {
		return 9999
	}
	return float64(d.QueueAhead(priceCents)) / dailyRate
}

// PriceToSellIn returns the lowest price at which your copy clears in at
// most targetDays days given dailyRate (units/day). The returned price is
// 1 cent below the first listing that would push your queue beyond the target.
//
// Returns (0, false) when no price achieves the target (too slow a market
// or no listing data).
func (d *Depth) PriceToSellIn(targetDays int, dailyRate float64) (int32, bool) {
	if dailyRate <= 0 || len(d.Listings) == 0 {
		return 0, false
	}
	targetQueue := dailyRate * float64(targetDays)
	cumulative := 0
	for _, l := range d.Listings {
		if float64(cumulative) >= targetQueue {
			// Listing at l.PriceCents would put us over — undercut it by 1c.
			price := l.PriceCents - 1
			if price < 1 {
				price = 1
			}
			return price, true
		}
		cumulative += l.Quantity
	}
	// All listings are within the target queue: list at or just above the
	// highest listed price (i.e. we're fine listing anywhere).
	last := d.Listings[len(d.Listings)-1]
	return last.PriceCents, true
}

// buildDepth sorts listings by price and computes summary fields.
// Called by each platform fetcher after it has collected raw listing data.
func buildDepth(listings []Listing) Depth {
	sort.Slice(listings, func(i, j int) bool {
		return listings[i].PriceCents < listings[j].PriceCents
	})
	d := Depth{Listings: listings}
	for _, l := range listings {
		d.TotalUnits += l.Quantity
	}
	if len(listings) > 0 {
		d.LowestCents = listings[0].PriceCents
		for _, l := range listings {
			if l.PriceCents == d.LowestCents {
				d.UnitsAtLowest += l.Quantity
			} else {
				break
			}
		}
	}
	return d
}

// freeshipThreshCents is the card price above which buyers strongly prefer
// free-shipping sellers. Below this threshold, shipping adds are expected
// and all listings compete equally.
const freeshipThreshCents = 500 // $5.00

// SellRecommendation bundles the output of a sell-time analysis for one product.
type SellRecommendation struct {
	ProductID            string  `json:"product_id"`
	Platform             string  `json:"platform"` // "tcgplayer" | "manapool"
	LowestCents          int32   `json:"lowest_cents"`
	UnitsAtLowest        int     `json:"units_at_lowest"`
	TotalUnits           int     `json:"total_units"`
	FreeshipUnits        int     `json:"freeship_units"`        // total free-ship units in depth
	TargetDays           int     `json:"target_days"`
	TargetCents          int32   `json:"target_cents"`          // price to hit target (all listings)
	FreeshipTargetCents  int32   `json:"freeship_target_cents"` // price vs only free-ship competition
	QueueAhead           int     `json:"queue_ahead"`
	FreeshipQueueAhead   int     `json:"freeship_queue_ahead"`  // free-ship-only queue depth
	DailyRate            float64 `json:"daily_rate"`
	ExpectedDays         float64 `json:"expected_days"`
	Achievable           bool    `json:"achievable"`
}

// Recommend computes a sell recommendation for targetDays given the listing
// depth and a weekly sell velocity sourced from market-tracker.
func Recommend(d Depth, productID, platform string, unitsSoldWeek int32, targetDays int) SellRecommendation {
	rec := SellRecommendation{
		ProductID:     productID,
		Platform:      platform,
		LowestCents:   d.LowestCents,
		UnitsAtLowest: d.UnitsAtLowest,
		TotalUnits:    d.TotalUnits,
		TargetDays:    targetDays,
	}
	for _, l := range d.Listings {
		if l.IsFreeship {
			rec.FreeshipUnits += l.Quantity
		}
	}

	dailyRate := float64(unitsSoldWeek) / 7.0
	rec.DailyRate = dailyRate

	price, ok := d.PriceToSellIn(targetDays, dailyRate)
	rec.Achievable = ok
	if ok {
		rec.TargetCents = price
		rec.QueueAhead = d.QueueAhead(price)
		rec.ExpectedDays = d.DaysToSell(price, dailyRate)
		// Free-ship perspective: how many free-ship units are ahead of our target?
		rec.FreeshipQueueAhead = d.QueueAheadFreeship(price, freeshipThreshCents)
		// If our target price is above the threshold, suggest undercutting
		// the free-ship queue rather than the all-listings queue.
		if price >= freeshipThreshCents {
			freePrice, freeOk := d.PriceToSellInFreeship(targetDays, dailyRate)
			if freeOk {
				rec.FreeshipTargetCents = freePrice
			}
		}
	}
	return rec
}

// PriceToSellInFreeship is like PriceToSellIn but only counts free-shipping
// listings as competition for cards priced above freeshipThreshCents.
func (d *Depth) PriceToSellInFreeship(targetDays int, dailyRate float64) (int32, bool) {
	if dailyRate <= 0 || len(d.Listings) == 0 {
		return 0, false
	}
	targetQueue := dailyRate * float64(targetDays)
	cumulative := 0
	for _, l := range d.Listings {
		if !l.IsFreeship {
			continue
		}
		if float64(cumulative) >= targetQueue {
			price := l.PriceCents - 1
			if price < 1 {
				price = 1
			}
			return price, true
		}
		cumulative += l.Quantity
	}
	if cumulative == 0 {
		return 0, false
	}
	// All free-ship listings within target: list at or above the last free-ship price.
	for i := len(d.Listings) - 1; i >= 0; i-- {
		if d.Listings[i].IsFreeship {
			return d.Listings[i].PriceCents, true
		}
	}
	return 0, false
}
