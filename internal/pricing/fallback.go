package pricing

import (
	"context"
	"log/slog"
)

// FallbackPricer tries Primary first, then Fallback for any keys that
// Primary didn't return. Fallback errors are logged and silently dropped
// so a live-fetch failure never breaks the report.
type FallbackPricer struct {
	Primary  Pricer
	Fallback Pricer
}

func (f *FallbackPricer) Lookup(ctx context.Context, reqs []Lookup) (map[string]PriceRow, error) {
	out, err := f.Primary.Lookup(ctx, reqs)
	if err != nil {
		return nil, err
	}

	var missing []Lookup
	for _, r := range reqs {
		if _, ok := out[r.DisplayKey]; !ok {
			missing = append(missing, r)
		}
	}
	if len(missing) == 0 {
		return out, nil
	}

	slog.Debug("primary pricer missed keys; trying fallback", "missing", len(missing))
	fallback, err := f.Fallback.Lookup(ctx, missing)
	if err != nil {
		slog.Warn("fallback pricer failed; continuing with partial prices",
			"err", err, "missing_count", len(missing))
		return out, nil
	}
	for k, v := range fallback {
		out[k] = v
	}
	if len(fallback) > 0 {
		slog.Info("fallback pricer filled gaps", "filled", len(fallback), "still_missing", len(missing)-len(fallback))
	}
	return out, nil
}
