// Manapool listing depth fetcher.
//
// Manapool is a SvelteKit SSR marketplace. Product pages embed all listing
// data inline in the HTML as a JavaScript object literal (not JSON) inside
// a large push() call. The key section looks like:
//
//	data:[..., {type:"data", data:{..., listings:[
//	  {inventoryId:"...", quantityAvailable:1, priceCents:3950, country:"US", ...},
//	  ...
//	], related:__sveltekit_12y4aaa.defer(2), ...}}]
//
// Because the payload is JS (unquoted keys, new Date(...), placeholder refs)
// we cannot use json.Unmarshal. Instead we extract the listings:[...] block
// by bracket counting and then regex each listing's fields.
//
// Sealed product URL:  https://manapool.com/sealed/{set_code}/{slug}
//
// The productID passed to FetchDepth is the Manapool URL slug pair:
// "{set_code}/{slug}" — e.g. "drc/deck-eternal-might".
package listings

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	manapoolBase    = "https://manapool.com"
	manapoolTimeout = 15 * time.Second
)

// reListingBlock matches the start of the listings array in the SSR payload.
var reListingsStart = regexp.MustCompile(`listings:\[`)

// reListingItem matches a single listing entry's key fields.
// Fields appear in varying order so we use named per-field regexes.
var (
	rePriceCents        = regexp.MustCompile(`priceCents:(\d+)`)
	reQuantityAvailable = regexp.MustCompile(`quantityAvailable:(\d+)`)
	reCountry           = regexp.MustCompile(`country:"([^"]+)"`)
)

// ManapoolFetcher fetches listing depth from Manapool by scraping
// SvelteKit SSR pages.
type ManapoolFetcher struct {
	client *http.Client
	token  string // reserved for future authenticated endpoints
}

func NewManapoolFetcher(token string) *ManapoolFetcher {
	return &ManapoolFetcher{
		client: &http.Client{Timeout: manapoolTimeout},
		token:  token,
	}
}

// FetchDepth fetches live listings for a Manapool sealed product.
//
// productID must be the URL slug pair: "{set_code}/{slug}"
// e.g. "drc/deck-eternal-might"
func (f *ManapoolFetcher) FetchDepth(ctx context.Context, productID string) (Depth, error) {
	url := manapoolBase + "/sealed/" + productID

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Depth{}, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := f.client.Do(req)
	if err != nil {
		return Depth{}, fmt.Errorf("manapool get: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return Depth{}, fmt.Errorf("manapool: product %q not found (check slug)", productID)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return Depth{}, fmt.Errorf("manapool %d: %s", resp.StatusCode, string(b))
	}

	html, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return Depth{}, fmt.Errorf("manapool read: %w", err)
	}

	ls, err := parseManapoolPage(html)
	if err != nil {
		return Depth{}, fmt.Errorf("manapool parse %q: %w", productID, err)
	}

	slog.Debug("manapool fetch complete", "product_id", productID, "listings", len(ls))
	return buildDepth(ls), nil
}

// parseManapoolPage extracts listings from the SvelteKit SSR payload.
//
// The payload contains a JS object literal (not JSON) with an inline
// `listings:[...]` array. We locate the array using bracket counting and
// then extract per-listing fields with regex.
func parseManapoolPage(html []byte) ([]Listing, error) {
	page := string(html)

	loc := reListingsStart.FindStringIndex(page)
	if loc == nil {
		return nil, fmt.Errorf("listings:[ not found — page structure may have changed")
	}

	// Walk from the opening '[' counting brackets to find the closing ']'.
	start := loc[1] - 1 // index of '['
	depth := 0
	end := -1
	for i := start; i < len(page); i++ {
		switch page[i] {
		case '[', '{':
			depth++
		case ']', '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		return nil, fmt.Errorf("listings array bracket mismatch — page truncated?")
	}

	block := page[start : end+1] // the full [...] array as a JS string

	// Split on top-level listing objects. Each listing is {inventoryId:...}.
	// We split by walking the block and splitting at depth-1 commas between objects.
	listingStrs := splitTopLevel(block)

	var out []Listing
	for _, s := range listingStrs {
		s = strings.TrimSpace(s)
		if !strings.HasPrefix(s, "{") {
			continue
		}

		pCents, ok := extractInt(s, rePriceCents)
		if !ok || pCents <= 0 {
			continue
		}
		qty, ok := extractInt(s, reQuantityAvailable)
		if !ok || qty <= 0 {
			continue
		}
		// Skip non-US listings to match TCGPlayer context.
		if m := reCountry.FindStringSubmatch(s); m != nil && !strings.EqualFold(m[1], "US") {
			continue
		}

		out = append(out, Listing{
			PriceCents: int32(pCents),
			Quantity:   qty,
		})
	}

	if len(out) == 0 {
		return nil, fmt.Errorf("no valid listings parsed from listings block")
	}
	return out, nil
}

// splitTopLevel splits a "[{...},{...}]" string at top-level commas between
// elements, returning the individual element strings. The outer brackets are
// stripped so each returned string starts with '{'.
func splitTopLevel(block string) []string {
	// Strip the outer [ and ].
	s := strings.TrimSpace(block)
	if len(s) >= 2 && s[0] == '[' {
		s = s[1:]
	}
	if len(s) >= 1 && s[len(s)-1] == ']' {
		s = s[:len(s)-1]
	}

	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[', '{':
			depth++
		case ']', '}':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	if start < len(s) {
		parts = append(parts, s[start:])
	}
	return parts
}

func extractInt(s string, re *regexp.Regexp) (int, bool) {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
}

// ErrNotImplemented is returned by fetchers whose scraping logic hasn't
// been confirmed against live responses yet.
var ErrNotImplemented = fmt.Errorf("listing fetcher not yet implemented for this platform")
