package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	APIAddr               string
	PriceSource           string // "market-tracker"|"tcgcsv"
	PriceColumn           string // "market"|"direct_low"|"mid"|"low"
	MarketTrackerBaseURL  string
	MarketTrackerToken    string
	LowValueFloorCents    int32
	TargetSellthroughDays int
	FeeProfile            string
	LiveDepth             bool   // EV_LIVE_DEPTH=true enables live listing scraping
	ManapoolToken         string // MANAPOOL_TOKEN for authenticated Manapool requests
}

func Load() (Config, error) {
	c := Config{
		APIAddr:               envOr("EV_API_ADDR", ":8081"),
		PriceSource:           envOr("EV_PRICE_SOURCE", "market-tracker"),
		PriceColumn:           envOr("EV_PRICE_COLUMN", "direct_low"),
		MarketTrackerBaseURL:  envOr("MARKET_TRACKER_BASE_URL", "http://localhost:8080"),
		MarketTrackerToken:    os.Getenv("MARKET_TRACKER_TOKEN"),
		LowValueFloorCents:    25,
		TargetSellthroughDays: 90,
		FeeProfile:            envOr("EV_FEE_PROFILE", "tcgplayer-marketplace-l4"),
	}
	if v := os.Getenv("EV_LOW_VALUE_FLOOR_CENTS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return c, fmt.Errorf("EV_LOW_VALUE_FLOOR_CENTS: %w", err)
		}
		c.LowValueFloorCents = int32(n)
	}
	if v := os.Getenv("EV_TARGET_SELLTHROUGH_DAYS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return c, fmt.Errorf("EV_TARGET_SELLTHROUGH_DAYS: %w", err)
		}
		c.TargetSellthroughDays = n
	}
	c.LiveDepth = os.Getenv("EV_LIVE_DEPTH") == "true"
	c.ManapoolToken = os.Getenv("MANAPOOL_TOKEN")
	return c, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
