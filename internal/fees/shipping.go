package fees

// ShippingProfile models per-card shipping economics on a marketplace where
// the seller (us) chooses one of three regimes based on card price:
//
//	BuyerPaid       — card below FreeShipThreshold; buyer pays BuyerPaidCents
//	                  for shipping, we eat real shipping cost (PWE).
//	FreeShipPWE     — card between FreeShipThreshold and TrackedThreshold;
//	                  we bake PWE cost into the listing price.
//	FreeShipTracked — card at/above TrackedThreshold; we bake tracked
//	                  bubble-mailer cost into the listing price.
//
// All cents.
type ShippingProfile struct {
	Name                    string
	PWECostCents            int32 // materials + 1oz stamp for plain-white-envelope shipment
	TrackedCostCents        int32 // bubble mailer + tracked label + postage
	BuyerPaidCents          int32 // what we charge buyer for shipping on sub-FreeShipThreshold sales
	TrackedThreshold        int32 // card price at which we switch from PWE to tracked
	FreeShipThreshold       int32 // card price at which we bake shipping into the listing
	SealedDeckShippingCents int32 // sealed-deck shipping (small box; can't bubble-mailer a sealed deck)
}

// DefaultTCGPlayerShipping is the locked-in default from the 2026-05-19
// pricing-strategy discussion. See
// `.github/projects/ev-calculator/shipping-net-strategy.md` for the
// per-item cost breakdown and rationale.
var DefaultTCGPlayerShipping = ShippingProfile{
	Name:                    "tcgplayer-default",
	PWECostCents:            93,   // $0.15 materials + $0.78 USPS Forever
	TrackedCostCents:        375,  // bubble + Ground Advantage 2oz tracked
	BuyerPaidCents:          150,  // what we charge buyer on sub-$5 sales
	TrackedThreshold:        2000, // $20 — matches eBay bubble cutoff
	FreeShipThreshold:       500,  // $5 — TCGPlayer free-shipping badge cutoff
	SealedDeckShippingCents: 500,  // ~$5 small box + Ground Advantage; sealed decks won't bubble-mailer
}

// Regime constants for the breakdown's Regime field.
const (
	RegimeBuyerPaid       = "buyer_paid"
	RegimeFreeShipPWE     = "free_ship_pwe"
	RegimeFreeShipTracked = "free_ship_tracked"
)

// NetBreakdown is the per-card net broken down into its components so the
// frontend (and humans debugging EV reports) can see exactly how the final
// net was derived.
type NetBreakdown struct {
	Regime             string `json:"regime"`
	ListPriceCents     int32  `json:"list_price_cents"`
	FeesCents          int32  `json:"fees_cents"`
	ShipCostCents      int32  `json:"ship_cost_cents"`
	BuyerShipPaidCents int32  `json:"buyer_ship_paid_cents"`
	NetPerCopyCents    int32  `json:"net_per_copy_cents"`
}

// Apply computes the regime-aware net for a single card at the given market
// price using the supplied fee profile (which already accounts for the
// marketplace commission + payment processing).
//
// List price equals the card's gross market price in every regime — we
// list at market and absorb the shipping cost (or charge buyer separately
// in the buyer-paid regime).
func (sp ShippingProfile) Apply(grossCents int32, fp Profile) NetBreakdown {
	b := NetBreakdown{ListPriceCents: grossCents}

	switch {
	case grossCents >= sp.TrackedThreshold:
		b.Regime = RegimeFreeShipTracked
		b.ShipCostCents = sp.TrackedCostCents
	case grossCents >= sp.FreeShipThreshold:
		b.Regime = RegimeFreeShipPWE
		b.ShipCostCents = sp.PWECostCents
	default:
		b.Regime = RegimeBuyerPaid
		b.ShipCostCents = sp.PWECostCents
		b.BuyerShipPaidCents = sp.BuyerPaidCents
	}

	// Fees are computed off the list price (gross) regardless of regime.
	netAfterFees := fp.NetCents(grossCents)
	b.FeesCents = grossCents - netAfterFees

	net := netAfterFees - b.ShipCostCents + b.BuyerShipPaidCents
	if net < 0 {
		net = 0
	}
	b.NetPerCopyCents = net
	return b
}
