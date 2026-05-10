package pricing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// MarketTrackerClient calls market-tracker-backend's POST /v1/prices/batch.
type MarketTrackerClient struct {
	BaseURL string
	Token   string
	Source  string // "tcgplayer" — pin a single source per request
	HTTP    *http.Client
}

func NewMarketTracker(baseURL, token, source string) *MarketTrackerClient {
	return &MarketTrackerClient{
		BaseURL: baseURL,
		Token:   token,
		Source:  source,
		HTTP:    &http.Client{Timeout: 10 * time.Second},
	}
}

type mtBatchReq struct {
	DisplayKeys []string `json:"display_keys"`
	Source      string   `json:"source,omitempty"`
}

type mtBatchResp struct {
	Prices   []PriceRow `json:"prices"`
	NotFound []string   `json:"not_found,omitempty"`
}

func (c *MarketTrackerClient) Lookup(ctx context.Context, reqs []Lookup) (map[string]PriceRow, error) {
	keys := make([]string, 0, len(reqs))
	for _, r := range reqs {
		keys = append(keys, r.DisplayKey)
	}
	body, _ := json.Marshal(mtBatchReq{DisplayKeys: keys, Source: c.Source})
	req, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/v1/prices/batch", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("market-tracker batch: status %d", resp.StatusCode)
	}
	var br mtBatchResp
	if err := json.NewDecoder(resp.Body).Decode(&br); err != nil {
		return nil, err
	}
	out := make(map[string]PriceRow, len(br.Prices))
	for _, p := range br.Prices {
		if c.Source != "" && p.Source != c.Source {
			continue
		}
		if _, exists := out[p.DisplayKey]; exists {
			continue
		}
		out[p.DisplayKey] = p
	}
	return out, nil
}
