// TCGPlayer listing depth fetcher.
//
// Uses the TCGPlayer marketplace search API (mp-search-api.tcgplayer.com)
// which is the same endpoint their website calls when rendering a product
// detail page. No auth token is required — the endpoint is publicly
// accessible with browser-like headers.
//
// Request shape (POST /v1/search/request):
//
//	{
//	  "algorithm": "product_listings",
//	  "from": 0, "size": 100,
//	  "filters": {"term": {"productId": [<id>]}},
//	  "listingSearch": {"filters": {"term": {"sellerStatus":"Live","channelId":0},
//	                                "range": {"quantity":{"gte":1}}},
//	                    "context": {"shippingCountry":"US"}},
//	  "context": {"shippingCountry":"US"}
//	}
//
// Response listings carry `price` (float USD) and `quantity` (float).
package listings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

const (
	tcgSearchURL     = "https://mp-search-api.tcgplayer.com/v1/search/request"
	tcgListingSize   = 50 // max TCGPlayer allows per request
	tcgDefaultTimeout = 15 * time.Second
)

// TCGPlayerScraper fetches listing depth from TCGPlayer's search API.
type TCGPlayerScraper struct {
	client *http.Client
}

func NewTCGPlayerScraper() *TCGPlayerScraper {
	return &TCGPlayerScraper{
		client: &http.Client{Timeout: tcgDefaultTimeout},
	}
}

// FetchDepth retrieves all live NM/Unopened listings for the given TCGPlayer
// product ID and returns them sorted cheapest-first as a Depth.
func (s *TCGPlayerScraper) FetchDepth(ctx context.Context, productID string) (Depth, error) {
	id, err := strconv.Atoi(productID)
	if err != nil {
		return Depth{}, fmt.Errorf("tcgplayer: invalid product ID %q: %w", productID, err)
	}

	var allListings []Listing
	from := 0
	for {
		batch, total, err := s.fetchPage(ctx, id, from, tcgListingSize)
		if err != nil {
			return Depth{}, err
		}
		allListings = append(allListings, batch...)
		from += len(batch)
		if from >= total || len(batch) == 0 {
			break
		}
	}

	slog.Debug("tcgplayer fetch complete", "product_id", productID, "listings", len(allListings))
	return buildDepth(allListings), nil
}

func (s *TCGPlayerScraper) fetchPage(ctx context.Context, productID, from, size int) ([]Listing, int, error) {
	body := map[string]any{
		"algorithm": "product_listings",
		"from":      from,
		"size":      size,
		"filters": map[string]any{
			"term":  map[string]any{"productId": []int{productID}},
			"range": map[string]any{},
			"match": map[string]any{},
		},
		"listingSearch": map[string]any{
			"filters": map[string]any{
				"term":    map[string]any{"sellerStatus": "Live", "channelId": 0},
				"range":   map[string]any{"quantity": map[string]any{"gte": 1}},
				"exclude": map[string]any{"channelExclusion": 0},
			},
			"context": map[string]any{"shippingCountry": "US", "cart": map[string]any{}},
		},
		"context": map[string]any{"shippingCountry": "US"},
		"sort":    map[string]any{},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tcgSearchURL, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://www.tcgplayer.com")
	req.Header.Set("Referer", fmt.Sprintf("https://www.tcgplayer.com/product/%d", productID))

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("tcgplayer search: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, 0, fmt.Errorf("tcgplayer search %d: %s", resp.StatusCode, string(b))
	}

	var result struct {
		Results []struct {
			Results []struct {
				TotalListings float64 `json:"totalListings"`
				Listings      []struct {
					Price         float64 `json:"price"`
					ShippingPrice float64 `json:"shippingPrice"`
					Quantity      float64 `json:"quantity"`
					Condition     string  `json:"condition"`
					Printing      string  `json:"printing"`
					ChannelID     int     `json:"channelId"` // 1 = TCGPlayer Direct (free ship)
				} `json:"listings"`
			} `json:"results"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, 0, fmt.Errorf("tcgplayer search decode: %w", err)
	}

	if len(result.Results) == 0 || len(result.Results[0].Results) == 0 {
		return nil, 0, nil
	}

	inner := result.Results[0].Results[0]
	total := int(inner.TotalListings)
	listings := make([]Listing, 0, len(inner.Listings))
	for _, l := range inner.Listings {
		cents := int32(l.Price*100 + 0.5)
		qty := int(l.Quantity)
		if cents <= 0 || qty <= 0 {
			continue
		}
		shipCents := int32(l.ShippingPrice*100 + 0.5)
		isDirect := l.ChannelID == 1
		listings = append(listings, Listing{
			PriceCents:    cents,
			ShippingCents: shipCents,
			IsFreeship:    isDirect || shipCents == 0,
			Quantity:      qty,
			Condition:     l.Condition,
			Printing:      l.Printing,
		})
	}
	return listings, total, nil
}
