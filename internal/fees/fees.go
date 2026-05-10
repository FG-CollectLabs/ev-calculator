// Package fees models marketplace + payment-processor fees as
// percentage + per-sale flat. Numbers are starting points pulled from
// the user's V1 spreadsheet; tune in one place and they propagate.
package fees

// Profile is a named fee structure. Apply.NetCents(grossCents) returns
// what lands in your account after the marketplace and payment
// processor take their cut.
type Profile struct {
	Name           string
	CommissionPct  float64 // 0.105 = 10.5%
	PerSaleCents   int32   // flat per-sale fee in cents
	PaymentPct     float64 // payment processor (0 if marketplace bundles)
	PaymentFlatCents int32 // payment processor flat
}

// Numbers mirror theexpectedvalue.com/scripts/tcgplayer-fees.js so we
// match a published reference. txnPct is the TCG payment-processing
// component; we fold it into PaymentPct.
var profiles = map[string]Profile{
	"tcgplayer-marketplace-l4": {
		Name:          "tcgplayer-marketplace-l4",
		CommissionPct: 0.1075, // Level 1-4 marketplace
		PaymentPct:    0.025,
		PerSaleCents:  30, // per-order flat; apply to sealed product listings only
	},
	// Singles variant: same % as L4 but no per-order flat.
	// For singles, the $0.30 is per ORDER not per card, so applying it
	// per card vastly overstates the fee cost. Use this profile for card-level EV.
	"tcgplayer-marketplace-l4-singles": {
		Name:          "tcgplayer-marketplace-l4-singles",
		CommissionPct: 0.1075,
		PaymentPct:    0.025,
		PerSaleCents:  0,
	},
	"tcgplayer-marketplace-pro": {
		Name:          "tcgplayer-marketplace-pro",
		CommissionPct: 0.0925 + 0.0250, // Pro adds 2.5%
		PaymentPct:    0.025,
		PerSaleCents:  30,
	},
	"tcgplayer-direct": {
		Name:          "tcgplayer-direct",
		CommissionPct: 0.0895,
		PaymentPct:    0.025,
		PerSaleCents:  0, // Direct waives the per-order fee
	},
	"tcgplayer-marketplace": {
		Name:          "tcgplayer-marketplace",
		CommissionPct: 0.0895,
		PerSaleCents:  30,
	},
	"ebay": {
		Name:             "ebay",
		CommissionPct:    0.1325, // collectible cards final value fee
		PerSaleCents:     30,
		PaymentPct:       0.0, // bundled
		PaymentFlatCents: 0,
	},
	// Manapool charges a flat 8% seller fee with no per-sale flat.
	// https://manapool.com/help/selling
	"manapool": {
		Name:          "manapool",
		CommissionPct: 0.08,
		PerSaleCents:  0,
		PaymentPct:    0.0,
	},
}

func Get(name string) Profile {
	if p, ok := profiles[name]; ok {
		return p
	}
	return profiles["tcgplayer-direct"]
}

// NetCents applies the profile to a gross sale price.
//
//	net = gross - (gross * commission) - perSaleFlat - (gross * payment) - paymentFlat
func (p Profile) NetCents(grossCents int32) int32 {
	g := float64(grossCents)
	net := g - g*p.CommissionPct - float64(p.PerSaleCents) - g*p.PaymentPct - float64(p.PaymentFlatCents)
	if net < 0 {
		return 0
	}
	return int32(net)
}
