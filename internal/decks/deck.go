// Package decks loads YAML deck/sealed-product definitions from disk.
//
// A "deck" here is anything with a fixed component list whose EV we want
// to compute. The same shape covers a single preconstructed deck, a
// display (box of decks), and eventually any sealed product whose
// contents are deterministic.
package decks

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Deck is a fixed-contents product. ProductDisplayKey is the
// market-tracker display_key of the sealed product itself (so we can
// price the box). Components is what's inside.
type Deck struct {
	Key                string      `yaml:"key"`                            // e.g. "aetherdrift-commander-deck-a"
	Name               string      `yaml:"name"`                           // human-readable
	Game               string      `yaml:"game"`                           // "mtg"
	SetCode            string      `yaml:"set_code"`                       // "drc"
	ProductDisplayKey  string      `yaml:"product_display_key"`            // sealed deck's key in market-tracker
	ProductTCGPlayerID  string      `yaml:"product_tcgplayer_id,omitempty"`  // sealed deck's TCGPlayer productId
	ProductManapoolSlug string      `yaml:"product_manapool_slug,omitempty"` // Manapool URL slug: "{set_code}/{slug}"
	Image               string      `yaml:"image,omitempty"`                 // relative URL for deck image, e.g. /img/decks/foo.jpg
	Channels            []string    `yaml:"channels,omitempty"`              // preferred sell channels: tcgplayer, ebay, manapool
	// DeckPriceCents is a manual fallback for the sealed deck market price when
	// market-tracker has no data for this product. Set to the known TCGPlayer
	// market price in cents (e.g. 2500 = $25.00).
	DeckPriceCents *int32      `yaml:"deck_price_cents,omitempty"`
	Components     []Component `yaml:"components"`
}

// Component is a card line in a deck. DisplayKey points at a card row
// in market-tracker (e.g. "mtg-dft-001-nf"). Quantity is the number of
// copies of that exact printing in this product.
//
// Notes:
//   - ReplaceWith optionally points at an alt printing whose price we
//     should use instead of this one (e.g. the deck includes a
//     showcase/foil that's only available as a singleton — value the
//     non-foil if that's what gets cracked and shipped).
//   - LowValueExempt forces inclusion regardless of the floor (useful
//     for cards below the floor that you ship as bonuses anyway).
type Component struct {
	DisplayKey         string `yaml:"display_key"`
	Quantity           int    `yaml:"qty"`
	Name               string `yaml:"name,omitempty"`               // human label, not load-bearing
	TCGPlayerProductID string `yaml:"tcgplayer_product_id,omitempty"`
	Finish             string `yaml:"finish,omitempty"`             // "nf"|"f"|"e", used by TCGCSV pricer
	Note               string `yaml:"note,omitempty"`
	ReplaceWith        string `yaml:"replace_with,omitempty"`
	LowValueExempt     bool   `yaml:"low_value_exempt,omitempty"`
}

// Display represents a sealed case: N copies of a set of decks plus an
// optional set of extra components (promo cards, dice, etc.).
//
// Type classifies the product for EV comparison purposes:
//   - "commander_case"  – sealed case of precon commander decks
//   - "booster_display" – sealed booster display box
//
// ProductDisplayKey is the market-tracker key for the sealed case itself
// (used to price the case on the buy side). Each contained Deck carries
// its own ProductDisplayKey for the individual sealed deck price.
type Display struct {
	Key               string       `yaml:"key"`
	Name              string       `yaml:"name"`
	Game              string       `yaml:"game"`
	SetCode           string       `yaml:"set_code"`
	Type              string       `yaml:"type,omitempty"`              // "commander_case" | "booster_display"
	ProductDisplayKey  string `yaml:"product_display_key"`
	ProductTCGPlayerID string `yaml:"product_tcgplayer_id,omitempty"` // sealed case TCGPlayer productId
	// When TCGPlayer doesn't sell the full case, define the set-of-N product
	// and how many sets make up one case. CaseCost = sets_of_n_per_case × set_price.
	ProductSetOfNTCGPlayerID string `yaml:"product_set_of_n_tcgplayer_id,omitempty"`
	SetsOfNPerCase           int    `yaml:"sets_of_n_per_case,omitempty"`
	// CasePriceCents is a manual fallback for the sealed case market price when
	// market-tracker has no sealed product data. Set to the known TCGPlayer
	// market price for the full case in cents (e.g. 15000 = $150.00).
	CasePriceCents  *int32       `yaml:"case_price_cents,omitempty"`
	Decks           []DeckCopies `yaml:"decks"`
	ExtraComponents []Component  `yaml:"extra_components,omitempty"` // promo cards, dice, etc.
}

type DeckCopies struct {
	DeckKey string `yaml:"deck_key"`
	Copies  int    `yaml:"copies"`
}

// LoadDeck reads a single deck YAML.
func LoadDeck(path string) (Deck, error) {
	var d Deck
	b, err := os.ReadFile(path)
	if err != nil {
		return d, err
	}
	if err := yaml.Unmarshal(b, &d); err != nil {
		return d, fmt.Errorf("%s: %w", path, err)
	}
	return d, nil
}

// LoadDisplay reads a display YAML.
func LoadDisplay(path string) (Display, error) {
	var d Display
	b, err := os.ReadFile(path)
	if err != nil {
		return d, err
	}
	if err := yaml.Unmarshal(b, &d); err != nil {
		return d, fmt.Errorf("%s: %w", path, err)
	}
	return d, nil
}

// LoadAllDecks walks dir and returns every *.yaml file as a Deck. Files
// whose top-level YAML lacks `components` are skipped (they're displays,
// loaded separately). Caller passes filename predicate if it cares.
func LoadAllDecks(dir string) (map[string]Deck, error) {
	out := map[string]Deck{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if filepath.Ext(path) != ".yaml" {
			return nil
		}
		d, err := LoadDeck(path)
		if err != nil {
			return err
		}
		if len(d.Components) == 0 {
			return nil // probably a display
		}
		if d.Key == "" {
			return fmt.Errorf("%s: missing key", path)
		}
		out[d.Key] = d
		return nil
	})
	return out, err
}
