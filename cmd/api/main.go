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
	corsOrigin := envOr("EV_CORS_ORIGIN", "https://fg-collectlabs.github.io,https://futuregadgetlabs.com,http://localhost:1313,http://localhost:5173")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /v1/ev/displays", func(w http.ResponseWriter, r *http.Request) {
		entries, err := indexDisplays(dataDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"displays": entries})
	})

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

	mux.HandleFunc("GET /v1/ev/displays/{key}", func(w http.ResponseWriter, r *http.Request) {
		buildReport(w, r, r.PathValue("key"))
	})

	mux.HandleFunc("GET /v1/ev/cases/{key}", func(w http.ResponseWriter, r *http.Request) {
		buildReport(w, r, r.PathValue("key"))
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

	mux.HandleFunc("POST /v1/scan/identify", func(w http.ResponseWriter, r *http.Request) {
		proxyToCardID(w, r, "/identify")
	})
	mux.HandleFunc("POST /v1/scan/back", func(w http.ResponseWriter, r *http.Request) {
		proxyToCardID(w, r, "/identify/back")
	})

	// Image proxy — serves TCGPlayer product images through our domain so
	// GitHub Pages (cross-origin) can load them without hotlink blocks.
	// Images are cached in memory after the first fetch.
	var (
		imgCache sync.Map        // productID → []byte
		imgMu    sync.Map        // productID → *sync.Mutex (in-flight dedup)
	)
	imgClient := &http.Client{Timeout: 15 * time.Second}
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
		url := "https://product-images.tcgplayer.com/fit-in/400x550/" + id + ".jpg"
		resp, err := imgClient.Get(url)
		if err != nil || resp.StatusCode != http.StatusOK {
			http.Error(w, "image not found", http.StatusNotFound)
			return
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		imgCache.Store(id, data)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(data)
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
