// ev is a CLI for ad-hoc EV reports.
//
//	ev report aetherdrift-commander-display
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/FG-CollectLabs/ev-calculator/internal/config"
	"github.com/FG-CollectLabs/ev-calculator/internal/decks"
	"github.com/FG-CollectLabs/ev-calculator/internal/ev"
	"github.com/FG-CollectLabs/ev-calculator/internal/pricing"
)

func main() {
	dataDir := flag.String("data", "data/decks", "deck data directory")
	displayPath := flag.String("display", "", "path to display YAML to report on")
	flag.Parse()

	if *displayPath == "" {
		fmt.Fprintln(os.Stderr, "usage: ev -display data/decks/aetherdrift/display.yaml")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	deckMap, err := decks.LoadAllDecks(filepath.Clean(*dataDir))
	if err != nil {
		slog.Error("load decks", "err", err)
		os.Exit(1)
	}
	disp, err := decks.LoadDisplay(*displayPath)
	if err != nil {
		slog.Error("load display", "err", err)
		os.Exit(1)
	}

	var pricer pricing.Pricer
	switch cfg.PriceSource {
	case "tcgcsv":
		pricer = pricing.NewTCGCSV()
	default:
		pricer = pricing.NewMarketTracker(cfg.MarketTrackerBaseURL, cfg.MarketTrackerToken, "tcgplayer")
	}
	b := &ev.Builder{
		Pricer: pricer,
		Decks:  deckMap,
		Opts: ev.Options{
			LowValueFloorCents:    cfg.LowValueFloorCents,
			TargetSellthroughDays: cfg.TargetSellthroughDays,
			FeeProfile:            cfg.FeeProfile,
			PriceSource:           "tcgplayer",
			PriceColumn:           cfg.PriceColumn,
		},
	}

	rep, err := b.BuildDisplay(context.Background(), disp)
	if err != nil {
		slog.Error("build report", "err", err)
		os.Exit(1)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
}
