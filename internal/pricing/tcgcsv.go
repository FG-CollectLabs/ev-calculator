package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// TCGCSVClient pulls free public TCGplayer prices from tcgcsv.com.
//
// API:
//   GET /tcgplayer/{categoryId}/groups          -> list of (groupId, abbreviation)
//   GET /tcgplayer/{categoryId}/{groupId}/prices -> price rows per (productId, subType)
//
// Magic categoryId is 1. We resolve set abbreviation -> groupId on
// first lookup and cache. Each PriceRow returned to the caller carries
//   marketPrice -> MarketPriceCents
//   lowPrice    -> LowestPriceCents
//   directLowPrice -> LowestLegitCents (Direct sellers are TCG-vetted,
//                                       closest analogue to "lowest legit")
//   midPrice    -> MedianPriceCents
type TCGCSVClient struct {
	BaseURL    string
	CategoryID int
	HTTP       *http.Client

	mu      sync.Mutex
	groupID map[string]int           // setAbbrev (uppercase) -> groupId
	cache   map[int]map[string]rawPx // groupId -> productId+subType -> price
}

func NewTCGCSV() *TCGCSVClient {
	return &TCGCSVClient{
		BaseURL:    "https://tcgcsv.com",
		CategoryID: 1, // Magic
		HTTP:       &http.Client{Timeout: 15 * time.Second},
		groupID:    map[string]int{},
		cache:      map[int]map[string]rawPx{},
	}
}

type rawPx struct {
	ProductID      int     `json:"productId"`
	LowPrice       float64 `json:"lowPrice"`
	MidPrice       float64 `json:"midPrice"`
	HighPrice      float64 `json:"highPrice"`
	MarketPrice    float64 `json:"marketPrice"`
	DirectLowPrice float64 `json:"directLowPrice"`
	SubTypeName    string  `json:"subTypeName"` // "Normal"|"Foil"
}

type rawGroup struct {
	GroupID      int    `json:"groupId"`
	Name         string `json:"name"`
	Abbreviation string `json:"abbreviation"`
}

type tcgcsvWrap struct {
	Results json.RawMessage `json:"results"`
}

func (c *TCGCSVClient) resolveGroupID(ctx context.Context, abbrev string) (int, error) {
	c.mu.Lock()
	if id, ok := c.groupID[abbrev]; ok {
		c.mu.Unlock()
		return id, nil
	}
	c.mu.Unlock()

	url := fmt.Sprintf("%s/tcgplayer/%d/groups", c.BaseURL, c.CategoryID)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "ev-calculator/0.1 (+https://github.com/FG-CollectLabs/ev-calculator)")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("tcgcsv groups: status %d", resp.StatusCode)
	}
	var w tcgcsvWrap
	if err := json.NewDecoder(resp.Body).Decode(&w); err != nil {
		return 0, err
	}
	var groups []rawGroup
	if err := json.Unmarshal(w.Results, &groups); err != nil {
		return 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, g := range groups {
		c.groupID[g.Abbreviation] = g.GroupID
	}
	id, ok := c.groupID[abbrev]
	if !ok {
		return 0, fmt.Errorf("tcgcsv: no group for set %q", abbrev)
	}
	return id, nil
}

// loadPrices fetches every price row for a group and indexes them by
// "<productId>|<subType>". subType is "Normal" or "Foil" (Etched cards
// also show as Foil in TCGCSV; map etched -> Foil for now).
func (c *TCGCSVClient) loadPrices(ctx context.Context, groupID int) (map[string]rawPx, error) {
	c.mu.Lock()
	if m, ok := c.cache[groupID]; ok {
		c.mu.Unlock()
		return m, nil
	}
	c.mu.Unlock()

	url := fmt.Sprintf("%s/tcgplayer/%d/%d/prices", c.BaseURL, c.CategoryID, groupID)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "ev-calculator/0.1 (+https://github.com/FG-CollectLabs/ev-calculator)")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("tcgcsv prices group=%d: status %d", groupID, resp.StatusCode)
	}
	var w tcgcsvWrap
	if err := json.NewDecoder(resp.Body).Decode(&w); err != nil {
		return nil, err
	}
	var rows []rawPx
	if err := json.Unmarshal(w.Results, &rows); err != nil {
		return nil, err
	}
	out := make(map[string]rawPx, len(rows))
	for _, r := range rows {
		out[fmt.Sprintf("%d|%s", r.ProductID, r.SubTypeName)] = r
	}
	c.mu.Lock()
	c.cache[groupID] = out
	c.mu.Unlock()
	return out, nil
}

// Lookup uses the per-component TCGPlayerProductID + Finish + the set
// code derived from DisplayKey (e.g. "mtg-drc-4-f" -> "DRC") to find
// rows in the right group.
func (c *TCGCSVClient) Lookup(ctx context.Context, reqs []Lookup) (map[string]PriceRow, error) {
	// Group by set abbreviation so we hit each group's prices.json once.
	bySet := map[string][]Lookup{}
	for _, r := range reqs {
		set := setFromDisplayKey(r.DisplayKey)
		if set == "" || r.TCGPlayerProductID == "" {
			continue
		}
		bySet[set] = append(bySet[set], r)
	}

	out := map[string]PriceRow{}
	for setAbbrev, lks := range bySet {
		groupID, err := c.resolveGroupID(ctx, setAbbrev)
		if err != nil {
			return nil, err
		}
		prices, err := c.loadPrices(ctx, groupID)
		if err != nil {
			return nil, err
		}
		for _, l := range lks {
			sub := "Normal"
			if l.Finish == "f" || l.Finish == "e" {
				sub = "Foil"
			}
			key := fmt.Sprintf("%s|%s", l.TCGPlayerProductID, sub)
			px, ok := prices[key]
			if !ok {
				continue
			}
			out[l.DisplayKey] = PriceRow{
				DisplayKey:       l.DisplayKey,
				Kind:             l.Kind,
				Source:           "tcgplayer",
				MarketPriceCents: usdToCents(px.MarketPrice),
				LowestPriceCents: usdToCents(px.LowPrice),
				LowestLegitCents: usdToCents(px.DirectLowPrice),
				MedianPriceCents: usdToCents(px.MidPrice),
			}
		}
	}
	return out, nil
}

// setFromDisplayKey pulls the set abbreviation out of an mtg-style
// display_key (mtg-<setlower>-<num>-<finish>) and uppercases it. Returns
// "" if it can't parse — caller will skip the lookup.
func setFromDisplayKey(dk string) string {
	// "mtg-drc-4-f" -> "DRC"
	const prefix = "mtg-"
	if len(dk) <= len(prefix) || dk[:len(prefix)] != prefix {
		return ""
	}
	rest := dk[len(prefix):]
	// find next '-'
	for i := 0; i < len(rest); i++ {
		if rest[i] == '-' {
			s := rest[:i]
			b := make([]byte, len(s))
			for j := range s {
				c := s[j]
				if c >= 'a' && c <= 'z' {
					c -= 32
				}
				b[j] = c
			}
			return string(b)
		}
	}
	return ""
}
