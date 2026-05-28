// api serves the EV report over HTTP for the Hugo frontend.
//
//	GET /v1/ev/displays              -> index of available displays
//	GET /v1/ev/displays/{display_key} -> full report for one display
//
// Reads YAML from disk on every request (cheap; tens of files). Add a
// load-time cache + filewatcher when that hurts.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/FG-CollectLabs/ev-calculator/internal/config"
	"github.com/FG-CollectLabs/ev-calculator/internal/decks"
	"github.com/FG-CollectLabs/ev-calculator/internal/ev"
	"github.com/FG-CollectLabs/ev-calculator/internal/listings"
	"github.com/FG-CollectLabs/ev-calculator/internal/pricing"
)

type displayIndexEntry struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Game        string `json:"game"`
	SetCode     string `json:"set_code"`
	ProductType string `json:"product_type,omitempty"`
	DeckCount   int    `json:"deck_count"`
	TotalCopies int    `json:"total_copies"`
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	dataDir := envOr("EV_DATA_DIR", "data/decks")
	corsOrigin := envOr("EV_CORS_ORIGIN", "https://fg-collectlabs.github.io,https://futuregadgetlabs.com,https://ev-calculator.futuregadgetlabs.com,https://inventory.futuregadgetlabs.com,http://localhost:1313,http://localhost:5173,http://localhost:5174")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /docs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(swaggerHTML))
	})

	auth := requireAuth(cfg.APIToken)

	mux.Handle("GET /v1/ev/displays", auth(func(w http.ResponseWriter, r *http.Request) {
		entries, err := indexDisplays(dataDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"displays": entries})
	}))

	// Build listing fetchers once at startup when EV_LIVE_DEPTH=true.
	var listingFetchers map[string]listings.Fetcher
	if cfg.LiveDepth {
		listingFetchers = map[string]listings.Fetcher{
			"tcgplayer": listings.NewTCGPlayerScraper(),
			"manapool":  listings.NewManapoolFetcher(cfg.ManapoolToken),
		}
		slog.Info("live depth enabled", "platforms", []string{"tcgplayer", "manapool"})
	}

	// /v1/ev/displays/{key} and /v1/ev/cases/{key} are the same handler —
	// "cases" is the preferred term for commander precon cases; "displays"
	// is kept for backward compatibility.
	buildReport := func(w http.ResponseWriter, r *http.Request, key string) {
		path := findDisplayYAML(dataDir, key)
		if path == "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		disp, err := decks.LoadDisplay(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		deckMap, err := decks.LoadAllDecks(dataDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var pricer pricing.Pricer
		switch cfg.PriceSource {
		case "tcgcsv":
			pricer = pricing.NewTCGCSV()
		default:
			mt := pricing.NewMarketTracker(cfg.MarketTrackerBaseURL, cfg.MarketTrackerToken, "tcgplayer")
			pricer = &pricing.FallbackPricer{Primary: mt, Fallback: pricing.NewTCGCSV()}
		}
		b := &ev.Builder{
			Pricer:          pricer,
			Decks:           deckMap,
			ListingFetchers: listingFetchers,
			Opts: ev.Options{
				LowValueFloorCents:    cfg.LowValueFloorCents,
				TargetSellthroughDays: cfg.TargetSellthroughDays,
				FeeProfile:            cfg.FeeProfile,
				PriceSource:           "tcgplayer",
				PriceColumn:           cfg.PriceColumn,
			},
		}
		rep, err := b.BuildDisplay(r.Context(), disp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, rep)
	}

	mux.Handle("GET /v1/ev/displays/{key}", auth(func(w http.ResponseWriter, r *http.Request) {
		buildReport(w, r, r.PathValue("key"))
	}))

	mux.Handle("GET /v1/ev/cases/{key}", auth(func(w http.ResponseWriter, r *http.Request) {
		buildReport(w, r, r.PathValue("key"))
	}))

	// Deck manifest endpoint — no auth, returns static component list for a single deck.
	// Used by card-inventory-frontend to auto-populate the break form.
	mux.HandleFunc("GET /v1/decks/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		deckMap, err := decks.LoadAllDecks(dataDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		dk, ok := deckMap[key]
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		type compResp struct {
			DisplayKey         string `json:"display_key"`
			Qty                int    `json:"qty"`
			Name               string `json:"name,omitempty"`
			TCGPlayerProductID string `json:"tcgplayer_product_id,omitempty"`
			Finish             string `json:"finish,omitempty"`
		}
		type deckResp struct {
			Key               string      `json:"key"`
			Name              string      `json:"name"`
			Game              string      `json:"game"`
			SetCode           string      `json:"set_code"`
			TCGSetName        string      `json:"tcg_set_name,omitempty"`
			ProductDisplayKey string      `json:"product_display_key"`
			ProductTCGPlayerID string     `json:"product_tcgplayer_id,omitempty"`
			Image             string      `json:"image,omitempty"`
			Components        []compResp  `json:"components"`
		}
		comps := make([]compResp, len(dk.Components))
		for i, c := range dk.Components {
			comps[i] = compResp{
				DisplayKey:         c.DisplayKey,
				Qty:                c.Quantity,
				Name:               c.Name,
				TCGPlayerProductID: c.TCGPlayerProductID,
				Finish:             c.Finish,
			}
		}
		writeJSON(w, deckResp{
			Key:               dk.Key,
			Name:              dk.Name,
			Game:              dk.Game,
			SetCode:           dk.SetCode,
			TCGSetName:        dk.TCGSetName,
			ProductDisplayKey: dk.ProductDisplayKey,
			ProductTCGPlayerID: dk.ProductTCGPlayerID,
			Image:             dk.Image,
			Components:        comps,
		})
	})

	// Card identifier proxy — keeps the auth token server-side.
	cardIDURL := envOr("CARD_IDENTIFIER_URL", "")
	cardIDToken := envOr("CARD_IDENTIFIER_TOKEN", "")
	cardClient := &http.Client{Timeout: 30 * time.Second}

	proxyToCardID := func(w http.ResponseWriter, r *http.Request, path string) {
		if cardIDURL == "" {
			http.Error(w, "card identifier not configured", http.StatusServiceUnavailable)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, cardIDURL+path, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
		if cardIDToken != "" {
			req.Header.Set("Authorization", "Bearer "+cardIDToken)
		}
		resp, err := cardClient.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}

	mux.Handle("POST /v1/scan/identify", auth(func(w http.ResponseWriter, r *http.Request) {
		proxyToCardID(w, r, "/identify")
	}))
	mux.Handle("POST /v1/scan/back", auth(func(w http.ResponseWriter, r *http.Request) {
		proxyToCardID(w, r, "/identify/back")
	}))
	mux.HandleFunc("DELETE /v1/scan/scans", func(w http.ResponseWriter, r *http.Request) {
		if cardIDURL == "" {
			http.Error(w, "card identifier not configured", http.StatusServiceUnavailable)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodDelete, cardIDURL+"/identify/scans", nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if cardIDToken != "" {
			req.Header.Set("Authorization", "Bearer "+cardIDToken)
		}
		resp, err := cardClient.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})

	// Catalog search — GET proxy (passes query string through).
	mux.HandleFunc("GET /v1/scan/catalog", func(w http.ResponseWriter, r *http.Request) {
		if cardIDURL == "" {
			http.Error(w, "card identifier not configured", http.StatusServiceUnavailable)
			return
		}
		upstream := cardIDURL + "/catalog/search?" + r.URL.RawQuery
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if cardIDToken != "" {
			req.Header.Set("Authorization", "Bearer "+cardIDToken)
		}
		resp, err := cardClient.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})

	// Image proxy — serves TCGPlayer product images through our domain so
	// GitHub Pages (cross-origin) can load them without hotlink blocks.
	// Images are cached in memory after the first fetch.
	var (
		imgCache sync.Map        // productID → []byte
		imgMu    sync.Map        // productID → *sync.Mutex (in-flight dedup)
	)
	imgClient := &http.Client{Timeout: 15 * time.Second}

	// Build a tcgID → display_key index from deck manifests at startup so the
	// image proxy can fall back to Scryfall by set+collector-number when
	// TCGPlayer and Scryfall's tcgplayer index both miss (common for newly
	// released sets like TMC).
	tcgIDIndex := buildTCGIDIndex(dataDir)
	slog.Info("tcg image index built", "entries", len(tcgIDIndex))
	mux.HandleFunc("GET /v1/images/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if cached, ok := imgCache.Load(id); ok {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = w.Write(cached.([]byte))
			return
		}
		// Per-ID mutex prevents duplicate in-flight fetches.
		mu, _ := imgMu.LoadOrStore(id, &sync.Mutex{})
		mu.(*sync.Mutex).Lock()
		defer mu.(*sync.Mutex).Unlock()
		if cached, ok := imgCache.Load(id); ok {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = w.Write(cached.([]byte))
			return
		}
		// Try TCGPlayer's CDN first.
		url := "https://product-images.tcgplayer.com/fit-in/400x550/" + id + ".jpg"
		if data, ok := fetchJPEG(imgClient, url); ok {
			imgCache.Store(id, data)
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = w.Write(data)
			return
		}
		// Fallback 1: ask Scryfall for the card by TCGPlayer id.
		if scryURL := scryfallImageByTCGPlayerID(imgClient, id); scryURL != "" {
			if data, ok := fetchJPEG(imgClient, scryURL); ok {
				imgCache.Store(id, data)
				w.Header().Set("Content-Type", "image/jpeg")
				w.Header().Set("Cache-Control", "public, max-age=86400")
				_, _ = w.Write(data)
				return
			}
		}
		// Fallback 2: look up tcgID → display_key in our deck manifests, parse
		// out set+collector-number, and query Scryfall by set/number. Covers
		// newly listed cards (e.g. TMC foil borderless commanders) that aren't
		// in Scryfall's tcgplayer index yet.
		if setCode, number, ok := lookupSetNumber(tcgIDIndex, id); ok {
			if scryURL := scryfallImageBySetNumber(imgClient, setCode, number); scryURL != "" {
				if data, ok := fetchJPEG(imgClient, scryURL); ok {
					imgCache.Store(id, data)
					w.Header().Set("Content-Type", "image/jpeg")
					w.Header().Set("Cache-Control", "public, max-age=86400")
					_, _ = w.Write(data)
					return
				}
			}
		}
		http.Error(w, "image not found", http.StatusNotFound)
	})

	srv := &http.Server{
		Addr:              cfg.APIAddr,
		Handler:           cors(corsOrigin, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		slog.Info("ev-calculator api listening", "addr", cfg.APIAddr, "data_dir", dataDir, "price_source", cfg.PriceSource, "price_column", cfg.PriceColumn, "fee_profile", cfg.FeeProfile)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)
}

const swaggerHTML = `<!DOCTYPE html>
<html><head><title>EV Calculator API</title>
<meta charset="utf-8"/>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({
  spec: {
    openapi:"3.0.0",
    info:{title:"EV Calculator API",version:"1.0.0",description:"Sealed product EV calculator. Pulls live prices from market-tracker."},
    servers:[{url:"https://ev-api.futuregadgetlabs.com",description:"Production"},{url:"http://localhost:8081",description:"Local"}],
    paths:{
      "/healthz":{get:{summary:"Health check",responses:{"200":{description:"ok"}}}},
      "/v1/ev/displays":{get:{summary:"List all displays",responses:{"200":{description:"Array of display index entries"}}}},
      "/v1/ev/displays/{key}":{get:{summary:"Full EV report for one display",parameters:[{name:"key",in:"path",required:true,schema:{type:"string"},example:"blc-commander-display"}],responses:{"200":{description:"EV report with deck breakdown and pricing"},"404":{description:"Display not found"}}}},
      "/v1/images/{id}":{get:{summary:"Proxied TCGPlayer product image",parameters:[{name:"id",in:"path",required:true,schema:{type:"string"},example:"558382.jpg"}],responses:{"200":{description:"JPEG image","content":{"image/jpeg":{}}},"404":{description:"Image not found"}}}},
      "/v1/scan/identify":{post:{summary:"Identify a card from a front scan image",requestBody:{content:{"multipart/form-data":{schema:{type:"object",properties:{image:{type:"string",format:"binary"},restrict_set:{type:"string",description:"Set name hint for OCR lookup"}}}}}},responses:{"200":{description:"Identification result with candidates and confidence"}}}},
      "/v1/scan/back":{post:{summary:"Submit back scan for an existing scan_id",requestBody:{content:{"multipart/form-data":{schema:{type:"object",properties:{scan_id:{type:"string"},image:{type:"string",format:"binary"}}}}}},responses:{"200":{description:"Back image URL"}}}}
    }
  },
  dom_id:"#swagger-ui",
  presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],
  layout:"BaseLayout"
});
</script></body></html>`

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func cors(allowedOrigins string, next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range strings.Split(allowedOrigins, ",") {
		if s := strings.TrimSpace(o); s != "" {
			allowed[s] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed[origin] || allowedOrigins == "*" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Vary", "Origin")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// findDisplayYAML resolves a display key to its yaml file.
//
// Tries filename-based lookups first (fast), then falls back to scanning
// all YAMLs and matching the `key:` field inside (handles files like
// data/decks/aetherdrift/display.yaml whose internal key ≠ filename).
func findDisplayYAML(dataDir, key string) string {
	// Fast path: key matches filename.
	flat := filepath.Join(dataDir, key+".yaml")
	if _, err := os.Stat(flat); err == nil {
		return flat
	}
	nested, _ := filepath.Glob(filepath.Join(dataDir, "*", key+".yaml"))
	if len(nested) > 0 {
		return nested[0]
	}
	// Slow path: walk all YAMLs and find the one with a matching key field.
	var found string
	_ = filepath.Walk(dataDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".yaml") {
			return err
		}
		d, err := decks.LoadDisplay(path)
		if err == nil && d.Key == key {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// indexDisplays scans dataDir for *.yaml files whose top-level YAML
// includes a `decks:` array (i.e. is a display, not an individual deck).
func indexDisplays(dataDir string) ([]displayIndexEntry, error) {
	var entries []displayIndexEntry
	err := filepath.Walk(dataDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if !strings.HasSuffix(path, ".yaml") {
			return nil
		}
		d, err := decks.LoadDisplay(path)
		if err != nil || len(d.Decks) == 0 {
			return nil // not a display
		}
		total := 0
		for _, dc := range d.Decks {
			total += dc.Copies
		}
		entries = append(entries, displayIndexEntry{
			Key:         d.Key,
			Name:        d.Name,
			Game:        d.Game,
			SetCode:     d.SetCode,
			DeckCount:   len(d.Decks),
			TotalCopies: total,
		})
		return nil
	})
	return entries, err
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// requireAuth returns a middleware that enforces Bearer token auth when token
// is non-empty. Pass the result of requireAuth(cfg.APIToken) as `auth` and
// wrap protected handlers with auth(handler). When EV_API_TOKEN is unset the
// middleware is a no-op so local dev works without configuration.
func requireAuth(token string) func(http.HandlerFunc) http.Handler {
	return func(next http.HandlerFunc) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if got != token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next(w, r)
		})
	}
}

// fetchJPEG GETs a URL and returns the body when the response is a 200 OK.
// Used by the image proxy for both TCGPlayer and Scryfall sources.
func fetchJPEG(client *http.Client, url string) ([]byte, bool) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, false
	}
	return data, true
}

// buildTCGIDIndex scans every deck YAML under dataDir and returns a map of
// tcgplayer_product_id → display_key so the image proxy can recover
// set+collector-number when TCGPlayer and Scryfall's tcgplayer index miss.
func buildTCGIDIndex(dataDir string) map[string]string {
	idx := map[string]string{}
	deckMap, err := decks.LoadAllDecks(dataDir)
	if err != nil {
		slog.Warn("buildTCGIDIndex: LoadAllDecks failed", "err", err)
		return idx
	}
	for _, d := range deckMap {
		for _, c := range d.Components {
			if c.TCGPlayerProductID != "" && c.DisplayKey != "" {
				idx[c.TCGPlayerProductID] = c.DisplayKey
			}
		}
	}
	return idx
}

// lookupSetNumber parses a display_key like "mtg-tmc-6-f" into set code and
// collector number. Returns ok=false when the id isn't in the index or the
// key doesn't have the expected shape.
func lookupSetNumber(idx map[string]string, tcgID string) (string, string, bool) {
	key, ok := idx[tcgID]
	if !ok {
		return "", "", false
	}
	parts := strings.Split(key, "-")
	if len(parts) < 4 {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// scryfallImageBySetNumber queries Scryfall by set code + collector number
// and returns a normal-size image URL, or "" if not found.
func scryfallImageBySetNumber(client *http.Client, setCode, number string) string {
	return scryfallGetImage(client, "https://api.scryfall.com/cards/"+setCode+"/"+number)
}

// scryfallGetImage issues a Scryfall API GET with the headers Scryfall
// requires (without User-Agent + Accept, the API returns 400) and decodes
// the image URL from the card-object response.
func scryfallGetImage(client *http.Client, url string) string {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "fg-ev-calculator/1.0 (https://futuregadgetlabs.com)")
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	return decodeScryfallImage(resp.Body)
}

// scryfallImageByTCGPlayerID looks up a card on Scryfall by its TCGPlayer
// product id and returns a normal-size image URL, or "" if not found.
func scryfallImageByTCGPlayerID(client *http.Client, tcgID string) string {
	return scryfallGetImage(client, "https://api.scryfall.com/cards/tcgplayer/"+tcgID)
}

// decodeScryfallImage extracts a card image URL from a Scryfall card-object
// JSON response. Prefers top-level image_uris (single-face cards) and falls
// back to the front face for dual-face cards.
func decodeScryfallImage(body io.Reader) string {
	var card struct {
		ImageURIs struct {
			Normal string `json:"normal"`
			Large  string `json:"large"`
		} `json:"image_uris"`
		CardFaces []struct {
			ImageURIs struct {
				Normal string `json:"normal"`
				Large  string `json:"large"`
			} `json:"image_uris"`
		} `json:"card_faces"`
	}
	if err := json.NewDecoder(body).Decode(&card); err != nil {
		return ""
	}
	if card.ImageURIs.Normal != "" {
		return card.ImageURIs.Normal
	}
	if card.ImageURIs.Large != "" {
		return card.ImageURIs.Large
	}
	if len(card.CardFaces) > 0 {
		if u := card.CardFaces[0].ImageURIs.Normal; u != "" {
			return u
		}
		if u := card.CardFaces[0].ImageURIs.Large; u != "" {
			return u
		}
	}
	return ""
}
