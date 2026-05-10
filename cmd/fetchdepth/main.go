// fetchdepth is a debug CLI that hits the TCGPlayer and Manapool listing
// fetchers directly and prints the raw depth + sell recommendation as JSON.
//
// Usage:
//
//	go run ./cmd/fetchdepth -id 604259                    # TCGPlayer only
//	go run ./cmd/fetchdepth -id 604259 -platform manapool # Manapool
//	go run ./cmd/fetchdepth -id 604259 -days 14 -velocity 3
//
// Flags:
//
//	-id        TCGPlayer product ID (required)
//	-platform  "tcgplayer" (default) or "manapool"
//	-days      target sell window in days (default 30)
//	-velocity  weekly units sold to use for sell-time math (default 0 = unknown)
//	-token     bearer token for Manapool (or set MANAPOOL_TOKEN env var)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/FG-CollectLabs/ev-calculator/internal/listings"
)

func main() {
	id := flag.String("id", "", "platform product ID (required)")
	platform := flag.String("platform", "tcgplayer", "tcgplayer | manapool")
	days := flag.Int("days", 30, "target sell window in days")
	velocity := flag.Int("velocity", 0, "weekly units sold (0 = unknown)")
	token := flag.String("token", os.Getenv("MANAPOOL_TOKEN"), "Manapool bearer token")
	flag.Parse()

	if *id == "" {
		fmt.Fprintln(os.Stderr, "usage: fetchdepth -id <product_id> [-platform tcgplayer|manapool] [-days N] [-velocity N]")
		os.Exit(1)
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var fetcher listings.Fetcher
	switch *platform {
	case "manapool":
		fetcher = listings.NewManapoolFetcher(*token)
	default:
		fetcher = listings.NewTCGPlayerScraper()
	}

	depth, err := fetcher.FetchDepth(ctx, *id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch failed: %v\n", err)
		os.Exit(1)
	}

	rec := listings.Recommend(depth, *id, *platform, int32(*velocity), *days)

	out := struct {
		Depth struct {
			TotalUnits    int                `json:"total_units"`
			LowestCents   int32              `json:"lowest_cents"`
			UnitsAtLowest int                `json:"units_at_lowest"`
			Listings      []listings.Listing `json:"listings"`
		} `json:"depth"`
		Recommendation listings.SellRecommendation `json:"recommendation"`
	}{}
	out.Depth.TotalUnits = depth.TotalUnits
	out.Depth.LowestCents = depth.LowestCents
	out.Depth.UnitsAtLowest = depth.UnitsAtLowest
	out.Depth.Listings = depth.Listings
	out.Recommendation = rec

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}
