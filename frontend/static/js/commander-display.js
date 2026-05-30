// Commander display page: per-deck and per-card EV breakdown.
(async function () {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (!key) { document.querySelector("#display-name").textContent = "Missing key"; return; }

  let report;
  try {
    const r = await fetch(EV.api("/v1/ev/displays/" + encodeURIComponent(key)));
    if (!r.ok) throw new Error("status " + r.status);
    report = await r.json();
  } catch (e) {
    document.querySelector("#display-name").textContent = "Error: " + e.message;
    return;
  }

  document.title = report.name + " — EV Calculator";
  document.querySelector("#display-name").textContent = report.name;

  const ebaySetName = report.name.replace(/\s+commander.*$/i, "").trim();

  // ── LocalStorage keys ──────────────────────────────────────────────────────
  const LS = {
    plat:          "ev_plat",
    ebayMode:      "ev_ebay_mode",
    sort:          "ev_sort",
    skipRarities:  "ev_skip_rarities",
    tcgOffsetType:    "ev_tcg_offset_type",
    tcgOffsetVal:     "ev_tcg_offset_val",
    tcgPricingMode:   "ev_tcg_pricing_mode",   // "simple"|"tiered"|"beat-lowest"|"capture-pct"
    tcgCapturePct:    "ev_tcg_capture_pct",    // 50–100, target net % of market
    tcgTieredHighC:   "ev_tcg_tier_high_cents",
    tcgTieredLowC:    "ev_tcg_tier_low_cents",
    tcgTieredLowPct:  "ev_tcg_tier_low_pct",
    tcgTieredFloor:   "ev_tcg_tier_floor",
    tcgBeatFloor:     "ev_tcg_beat_floor",   // cents minimum listing price
    sift:          "ev_sift_threshold",
    // Packaging settings (stored as JSON objects keyed by platform)
    pkgSupplies:   "ev_pkg_supplies",   // { tcgplayer: {stamp,envelope,...}, manapool: {...}, ebay: {...} }
    pkgShipping:   "ev_pkg_shipping",   // { tcgplayer: "free"|"fixed"|"buyer", manapool: ..., ebay: ... }
    pkgShipFixed:  "ev_pkg_ship_fixed", // { tcgplayer: cents }
    pkgEnv:        "ev_pkg_env",        // { tcgplayer: "no-window"|"window" }
  };

  // Default supply costs in cents per platform. Same defaults across all platforms.
  const PKG_DEFAULT_SUPPLIES = { stamp:73, envelope:3, "card-saver":8, "penny-sleeve":1, label:1, "packing-slip":2, sticker:1 };
  // Per-envelope-type cost defaults (cents): no-window $15/500, window $18.50/250
  const ENV_COST = { "no-window": 3, window: 7 };
  // Supply input ids per platform (id → supply key)
  const PKG_SUPPLY_IDS = {
    tcgplayer: { stamp:"tcg-s-stamp", envelope:"tcg-s-envelope", "card-saver":"tcg-s-card-saver", "penny-sleeve":"tcg-s-penny-sleeve", label:"tcg-s-label", "packing-slip":"tcg-s-packing-slip", sticker:"tcg-s-sticker" },
    manapool:  { stamp:"mp-s-stamp",  envelope:"mp-s-envelope",  "card-saver":"mp-s-card-saver",  "penny-sleeve":"mp-s-penny-sleeve",  label:"mp-s-label",  "packing-slip":"mp-s-packing-slip",  sticker:"mp-s-sticker"  },
    ebay:      { stamp:"ebay-s-stamp",envelope:"ebay-s-envelope","card-saver":"ebay-s-card-saver","penny-sleeve":"ebay-s-penny-sleeve",label:"ebay-s-label","packing-slip":"ebay-s-packing-slip",sticker:"ebay-s-sticker" },
  };
  const PKG_TOTAL_IDS = { tcgplayer:"tcg-supply-total", manapool:"mp-supply-total", ebay:"ebay-supply-total" };

  function lsGet(k, def) { try { return localStorage.getItem(k) ?? def; } catch { return def; } }
  function lsSet(k, v)   { try { localStorage.setItem(k, String(v)); } catch {} }
  function lsGetJSON(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
  function lsSetJSON(k, v)   { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  // ── State ──────────────────────────────────────────────────────────────────
  let activePlat   = lsGet(LS.plat, "tcgplayer");
  let ebayMode     = lsGet(LS.ebayMode, "freeship");
  let csvSort      = lsGet(LS.sort, "name");
  const skipRarities  = new Set(lsGetJSON(LS.skipRarities, []));
  const userExcluded  = new Map();
  const userIncluded  = new Map();
  const collapsedDecks = new Set();

  // ── Apply saved settings to DOM ────────────────────────────────────────────
  function applySavedSettings() {
    // Platform
    document.querySelectorAll("#platform-toggle .plat-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.plat === activePlat));

    // Sort
    document.querySelectorAll("#sort-toggle .plat-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.sort === csvSort));

    // Rarity skip buttons
    document.querySelectorAll(".rarity-skip-btn").forEach(b =>
      b.classList.toggle("active", skipRarities.has(b.dataset.rarity)));

    // TCG offset
    const savedType = lsGet(LS.tcgOffsetType, "pct");
    const savedVal  = lsGet(LS.tcgOffsetVal, "0");
    const $type = document.getElementById("tcg-offset-type");
    const $val  = document.getElementById("tcg-offset-value");
    if ($type) $type.value = savedType;
    if ($val)  $val.value  = savedVal;

    // TCG tiered pricing
    const tcgMode = lsGet(LS.tcgPricingMode, "simple");
    document.querySelectorAll("#tcg-pricing-mode-toggle .plat-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === tcgMode));
    document.getElementById("tcg-capture-row")?.classList.toggle("hidden", tcgMode !== "capture-pct");
    document.getElementById("tcg-simple-row")?.classList.toggle("hidden", tcgMode !== "simple");
    document.getElementById("tcg-tiered-rows")?.classList.toggle("hidden", tcgMode !== "tiered");
    const $capturePct = document.getElementById("tcg-capture-pct");
    if ($capturePct) $capturePct.value = lsGet(LS.tcgCapturePct, "90");
    document.querySelectorAll("#tcg-capture-preset .plat-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.pct === lsGet(LS.tcgCapturePct, "90")));
    const $highC  = document.getElementById("tcg-tier-high-cents");
    const $lowC   = document.getElementById("tcg-tier-low-cents");
    const $lowPct = document.getElementById("tcg-tier-low-pct");
    const $floor  = document.getElementById("tcg-tier-floor");
    if ($highC)  $highC.value  = (lsGet(LS.tcgTieredHighC,  "30"));
    if ($lowC)   $lowC.value   = (lsGet(LS.tcgTieredLowC,   "15"));
    if ($lowPct) $lowPct.value = (lsGet(LS.tcgTieredLowPct, "10"));
    if ($floor)  $floor.value  = (parseFloat(lsGet(LS.tcgTieredFloor, "35")) / 100).toFixed(2);
    // Beat Lowest inputs
    const $beatFloor = document.getElementById("tcg-beat-floor");
    if ($beatFloor) $beatFloor.value = (parseFloat(lsGet(LS.tcgBeatFloor, "35"))  / 100).toFixed(2);
    document.getElementById("tcg-beat-lowest-rows")?.classList.toggle("hidden", tcgMode !== "beat-lowest");

    // Sift threshold
    const $sift = document.getElementById("sift-threshold");
    if ($sift) $sift.value = lsGet(LS.sift, "0.25");

    // eBay mode
    document.querySelectorAll(".ebay-mode-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === ebayMode));

    updateStrategyPanel();
  }

  // ── Settings event handlers ───────────────────────────────────────────────

  // Sell-on toggle
  document.querySelectorAll("#platform-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePlat = btn.dataset.plat;
      lsSet(LS.plat, activePlat);
      document.querySelectorAll("#platform-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      updateStrategyPanel();
      updateTargetNetHint();
      renderDecks();
    });
  });

  // TCGPlayer pricing mode toggle
  document.querySelectorAll("#tcg-pricing-mode-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      lsSet(LS.tcgPricingMode, mode);
      document.querySelectorAll("#tcg-pricing-mode-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      document.getElementById("tcg-capture-row")?.classList.toggle("hidden",     mode !== "capture-pct");
      document.getElementById("tcg-simple-row")?.classList.toggle("hidden",       mode !== "simple");
      document.getElementById("tcg-tiered-rows")?.classList.toggle("hidden",      mode !== "tiered");
      document.getElementById("tcg-beat-lowest-rows")?.classList.toggle("hidden", mode !== "beat-lowest");
      renderDecks();
    });
  });

  // Capture % input + presets
  document.getElementById("tcg-capture-pct")?.addEventListener("input", function() {
    lsSet(LS.tcgCapturePct, this.value);
    document.querySelectorAll("#tcg-capture-preset .plat-btn")
      .forEach(b => b.classList.toggle("active", b.dataset.pct === this.value));
    renderDecks();
  });
  document.querySelectorAll("#tcg-capture-preset .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      lsSet(LS.tcgCapturePct, btn.dataset.pct);
      const el = document.getElementById("tcg-capture-pct");
      if (el) el.value = btn.dataset.pct;
      document.querySelectorAll("#tcg-capture-preset .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  // TCGPlayer offset inputs (simple mode)
  document.getElementById("tcg-offset-type").addEventListener("change", function() {
    lsSet(LS.tcgOffsetType, this.value);
    renderDecks();
  });
  document.getElementById("tcg-offset-value").addEventListener("input", function() {
    lsSet(LS.tcgOffsetVal, this.value);
    renderDecks();
  });

  // TCGPlayer tiered pricing inputs
  [
    ["tcg-tier-high-cents", LS.tcgTieredHighC,  v => Math.round(parseFloat(v) || 0)],
    ["tcg-tier-low-cents",  LS.tcgTieredLowC,   v => Math.round(parseFloat(v) || 0)],
    ["tcg-tier-low-pct",    LS.tcgTieredLowPct, v => Math.round(parseFloat(v) || 0)],
    ["tcg-tier-floor",      LS.tcgTieredFloor,  v => Math.round((parseFloat(v) || 0) * 100)],
    ["tcg-beat-floor",      LS.tcgBeatFloor,    v => Math.round((parseFloat(v) || 0) * 100)],
  ].forEach(([id, key, parse]) => {
    document.getElementById(id)?.addEventListener("input", function() {
      lsSet(key, String(parse(this.value)));
      renderDecks();
    });
  });

  // eBay mode toggle
  document.querySelectorAll("#ebay-mode-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ebayMode = btn.dataset.mode;
      lsSet(LS.ebayMode, ebayMode);
      document.querySelectorAll("#ebay-mode-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  // Sort
  document.querySelectorAll("#sort-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      csvSort = btn.dataset.sort;
      lsSet(LS.sort, csvSort);
      document.querySelectorAll("#sort-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  // Rarity skip
  document.querySelectorAll(".rarity-skip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      if (btn.classList.contains("active")) skipRarities.add(btn.dataset.rarity);
      else skipRarities.delete(btn.dataset.rarity);
      lsSetJSON(LS.skipRarities, [...skipRarities]);
    });
  });

  // Sift threshold
  document.getElementById("sift-threshold").addEventListener("input", function() {
    lsSet(LS.sift, this.value);
  });

  // Case cost
  document.getElementById("case-cost").addEventListener("input", renderDecks);

  function updateStrategyPanel() {
    document.getElementById("strategy-tcgplayer").classList.toggle("hidden", activePlat !== "tcgplayer");
    document.getElementById("strategy-ebay").classList.toggle("hidden", activePlat !== "ebay");
  }

  applySavedSettings();

  // ── Packaging & Fees state + helpers ──────────────────────────────────────

  // Returns total supply cost in cents for the given platform, reading live input values.
  function packagingSupplyCents(plat) {
    const ids = PKG_SUPPLY_IDS[plat] || {};
    return Object.values(ids).reduce((sum, id) => {
      const el = document.getElementById(id);
      const v  = el ? parseFloat(el.value) : 0;
      return sum + (isNaN(v) ? 0 : Math.round(v * 100));
    }, 0);
  }

  // Returns postage-only cents (stamp input for the platform).
  function postageCents(plat) {
    const ids = PKG_SUPPLY_IDS[plat] || {};
    const el  = document.getElementById(ids.stamp);
    const v   = el ? parseFloat(el.value) : 0;
    return isNaN(v) ? 0 : Math.round(v * 100);
  }

  function currentShipMode(plat) {
    const saved = lsGetJSON(LS.pkgShipping, {})[plat] || "free";
    // Beat Lowest pricing implies fixed-rate shipping — buyer always pays the fixed ship charge
    if (saved === "free" && plat === "tcgplayer" && tcgPricingMode() === "beat-lowest") return "fixed";
    return saved;
  }

  function currentFixedShipCents(plat) {
    if (plat !== "tcgplayer") return 0;
    const el = document.getElementById("tcg-ship-fixed-val");
    const v  = el ? parseFloat(el.value) : 0;
    return isNaN(v) ? 0 : Math.round(v * 100);
  }

  function avgCardsPerOrder(plat) {
    const idMap = { tcgplayer: "tcg-avg-cards" };
    const el = idMap[plat] ? document.getElementById(idMap[plat]) : null;
    const v  = el ? parseFloat(el.value) : 1;
    return (!isNaN(v) && v >= 1) ? v : 1;
  }

  // Corrected per-card packaging cost that accounts for:
  //   free ship    → seller pays stamp amortized by avg order size
  //   fixed rate   → shipping revenue (after TCG fees) offsets stamp cost
  // TCGPlayer fee structure (per TCGPlayer docs):
  //   Marketplace commission: 10.75% of item price only (not shipping)
  //   Transaction fee:        2.5% of (items + shipping) + $0.30 flat per order
  //   Total on item:          10.75% + 2.5% = 13.25%  → keepRate 0.8675
  //   On shipping:            2.5% only               → shipKeepRate 0.975
  //   Flat per order:         $0.30 amortized by avg cards/order
  //
  //   free ship    → seller eats full postage + $0.30 flat amortized
  //   fixed rate   → seller collects ship charge; net ship rev = ship × 0.975/avg, minus flat
  //   buyer pays   → seller collects stamp-equivalent; net = stamp × 0.975/avg, minus flat
  //   ESE (eBay)   → same as free ship; ESE cost is $0.89 built into listing

  // Keep rate on the item listing price (commission + payment processing).
  function keepRate(plat) {
    switch (plat) {
      case "tcgplayer": return 0.8675; // 1 - 10.75% - 2.5%
      case "manapool":  return 0.92;   // 1 - 8%
      case "ebay":      return 0.8675; // 1 - 13.25%
      default:          return 0.8675;
    }
  }

  // Keep rate on the shipping amount (payment processing only — no marketplace commission on shipping).
  function shipKeepRate(plat) {
    switch (plat) {
      case "tcgplayer": return 0.975;  // 1 - 2.5% only
      case "manapool":  return 0.92;
      case "ebay":      return 0.8675;
      default:          return 0.8675;
    }
  }

  // Per-order flat fee amortized per card.
  function perOrderFlatPerCard(plat) {
    const avg = avgCardsPerOrder(plat);
    switch (plat) {
      case "tcgplayer": return Math.round(30 / avg);  // $0.30/order
      case "ebay":      return Math.round(30 / avg);  // $0.30/order
      default:          return 0;
    }
  }

  function packagingCostCents(plat) {
    const stamp         = postageCents(plat);
    const otherSupplies = packagingSupplyCents(plat) - stamp;
    const avg           = avgCardsPerOrder(plat);
    const mode          = currentShipMode(plat);
    const skr           = shipKeepRate(plat);
    const flat          = perOrderFlatPerCard(plat);

    switch (mode) {
      case "free":
      case "ese":
        return otherSupplies + Math.round(stamp / avg) + flat;

      case "fixed": {
        // Shipping revenue (after payment-processing fee only) offsets postage cost
        const shipRevNet = Math.round(currentFixedShipCents(plat) * skr / avg);
        return otherSupplies + Math.round(stamp / avg) - shipRevNet + flat;
      }

      case "buyer": {
        // Buyer pays ~stamp cost in shipping; seller keeps (stamp × shipKeepRate / avg)
        const shipRevNet = Math.round(stamp * skr / avg);
        return otherSupplies + Math.round(stamp / avg) - shipRevNet + flat;
      }

      default:
        return otherSupplies + Math.round(stamp / avg) + flat;
    }
  }

  // Net from listing price after item commission only (flat and packaging handled separately).
  function netFromListing(listingCents, plat) {
    return Math.round(listingCents * keepRate(plat));
  }

  // Ship charge collected from the buyer, amortized per card.
  function buyerShipCentsPerCard(plat) {
    const mode = currentShipMode(plat);
    const isBeatLowest = plat === "tcgplayer" && tcgPricingMode() === "beat-lowest";
    if (mode === "fixed" || isBeatLowest) {
      return Math.round(currentFixedShipCents(plat) / avgCardsPerOrder(plat));
    }
    if (mode === "buyer") return Math.round(postageCents(plat) / avgCardsPerOrder(plat));
    return 0;
  }

  // Buyer's total cost per card = listing + ship charge.
  function salePriceCents(listing, plat) {
    if (listing == null) return null;
    return listing + buyerShipCentsPerCard(plat);
  }

  // Revenue after all marketplace fees, per card.
  // Item: listing × keepRate. Shipping: ship × shipKeepRate. Minus flat.
  function revenueAfterFeesCents(listing, plat) {
    if (listing == null) return null;
    const ship = buyerShipCentsPerCard(plat);
    return Math.round(listing * keepRate(plat)) + Math.round(ship * shipKeepRate(plat)) - perOrderFlatPerCard(plat);
  }

  // Physical supply cost per card (stamp amortized by avg cards/order, no shipping revenue offset).
  function physicalSuppliesCents(plat) {
    const stamp = postageCents(plat);
    const avg   = avgCardsPerOrder(plat);
    return packagingSupplyCents(plat) - stamp + Math.round(stamp / avg);
  }

  // Minimum listing price to achieve targetNetCents after fees AND packaging.
  function requiredListingCents(plat) {
    const tn  = targetNetCents();
    if (tn <= 0) return 0;
    const pkg = packagingCostCents(plat); // already includes flat fee
    return Math.ceil((tn + pkg) / keepRate(plat));
  }

  function targetNetCents() {
    const v = parseFloat(document.getElementById("target-net-value")?.value || "");
    return isNaN(v) || v <= 0 ? 0 : Math.round(v * 100);
  }

  function updateTargetNetHint() {
    const hint = document.getElementById("target-net-hint");
    if (!hint) return;
    const req = requiredListingCents(activePlat);
    hint.textContent = req > 0
      ? `→ list ≥ ${EV.fmtUSD(req)} on ${({tcgplayer:"TCGPlayer",manapool:"Manapool",ebay:"eBay"})[activePlat]}`
      : "";
  }

  // Update live supply total display for a platform.
  function updateSupplyTotal(plat) {
    const rawEl = document.getElementById(PKG_TOTAL_IDS[plat]);
    if (rawEl) rawEl.textContent = EV.fmtUSD(packagingSupplyCents(plat));
    const note = document.getElementById("pkg-summary-note");
    if (note) note.textContent = `${EV.fmtUSD(packagingCostCents(activePlat))}/card effective`;
  }

  // Persist supply values for a platform.
  function saveSupplies(plat) {
    const ids     = PKG_SUPPLY_IDS[plat] || {};
    const saved   = lsGetJSON(LS.pkgSupplies, {});
    saved[plat]   = {};
    for (const [key, id] of Object.entries(ids)) {
      const el = document.getElementById(id);
      if (el) saved[plat][key] = parseFloat(el.value) || 0;
    }
    lsSetJSON(LS.pkgSupplies, saved);
  }

  // Load saved supply values into inputs.
  function loadSupplies() {
    const saved = lsGetJSON(LS.pkgSupplies, {});
    for (const plat of ["tcgplayer", "manapool", "ebay"]) {
      const vals = saved[plat] || {};
      const ids  = PKG_SUPPLY_IDS[plat] || {};
      for (const [key, id] of Object.entries(ids)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const def = PKG_DEFAULT_SUPPLIES[key] ?? 0;
        el.value = ((vals[key] != null ? vals[key] : def / 100)).toFixed(2);
      }
    }
    // Load shipping mode
    const shipSaved = lsGetJSON(LS.pkgShipping, {});
    setShipToggle("tcg-ship-toggle",      shipSaved.tcgplayer || "free");
    setShipToggle("mp-ship-toggle",       shipSaved.manapool  || "free");
    setShipToggle("ebay-pkg-ship-toggle", shipSaved.ebay      || "free");
    // Load envelope toggle
    const envSaved = lsGetJSON(LS.pkgEnv, {});
    setEnvToggle("tcg-env-toggle", envSaved.tcgplayer || "no-window");
    // Show/hide fixed rate row
    document.getElementById("tcg-ship-fixed-row")
      ?.classList.toggle("hidden", (shipSaved.tcgplayer || "free") !== "fixed");
    const fixedSaved = lsGetJSON(LS.pkgShipFixed, {});
    const fixedEl = document.getElementById("tcg-ship-fixed-val");
    if (fixedEl && fixedSaved.tcgplayer != null) fixedEl.value = (fixedSaved.tcgplayer / 100).toFixed(2);
    // Load avg cards per order
    const avgSaved = lsGetJSON("ev_pkg_avg_cards", {});
    const avgEl = document.getElementById("tcg-avg-cards");
    if (avgEl && avgSaved.tcgplayer != null) avgEl.value = avgSaved.tcgplayer;
    // Update totals
    for (const plat of ["tcgplayer", "manapool", "ebay"]) updateSupplyTotal(plat);
  }

  function setShipToggle(toggleId, val) {
    document.querySelectorAll(`#${toggleId} .plat-btn`).forEach(b => {
      b.classList.toggle("active", b.dataset.ship === val);
    });
  }
  function setEnvToggle(toggleId, val) {
    document.querySelectorAll(`#${toggleId} .plat-btn`).forEach(b => {
      b.classList.toggle("active", b.dataset.env === val);
    });
  }

  // Active packaging config tab
  let pkgActiveTab = "tcgplayer";

  function setPkgTab(tab) {
    pkgActiveTab = tab;
    document.querySelectorAll("#pkg-tab-toggle .plat-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.pkgTab === tab));
    document.querySelectorAll(".pkg-pane").forEach(p =>
      p.classList.toggle("hidden", p.id !== `pkg-pane-${tab}`));
  }

  // Wire up packaging event handlers
  document.querySelectorAll("#pkg-tab-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => setPkgTab(btn.dataset.pkgTab));
  });

  // Supply inputs: update total + persist on change
  for (const plat of ["tcgplayer", "manapool", "ebay"]) {
    const ids = PKG_SUPPLY_IDS[plat] || {};
    for (const id of Object.values(ids)) {
      document.getElementById(id)?.addEventListener("input", () => {
        saveSupplies(plat);
        updateSupplyTotal(plat);
        updateTargetNetHint();
        renderDecks();
      });
    }
  }

  // Shipping toggles
  document.querySelectorAll("#tcg-ship-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const ship = btn.dataset.ship;
      const saved = lsGetJSON(LS.pkgShipping, {}); saved.tcgplayer = ship; lsSetJSON(LS.pkgShipping, saved);
      setShipToggle("tcg-ship-toggle", ship);
      document.getElementById("tcg-ship-fixed-row")?.classList.toggle("hidden", ship !== "fixed");
      updateSupplyTotal("tcgplayer");
      renderDecks();
    });
  });
  document.getElementById("tcg-ship-fixed-val")?.addEventListener("input", function() {
    const saved = lsGetJSON(LS.pkgShipFixed, {}); saved.tcgplayer = Math.round(parseFloat(this.value || "0") * 100);
    lsSetJSON(LS.pkgShipFixed, saved); renderDecks();
  });
  document.querySelectorAll("#mp-ship-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const saved = lsGetJSON(LS.pkgShipping, {}); saved.manapool = btn.dataset.ship; lsSetJSON(LS.pkgShipping, saved);
      setShipToggle("mp-ship-toggle", btn.dataset.ship);
      updateSupplyTotal("manapool"); renderDecks();
    });
  });
  document.querySelectorAll("#ebay-pkg-ship-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const ship = btn.dataset.ship;
      const saved = lsGetJSON(LS.pkgShipping, {}); saved.ebay = ship; lsSetJSON(LS.pkgShipping, saved);
      setShipToggle("ebay-pkg-ship-toggle", ship);
      // ESE and free ship both mean seller covers postage; buyer-pays hides the stamp
      document.getElementById("ebay-postage-row")?.classList.toggle("hidden", ship === "buyer");
      updateSupplyTotal("ebay"); renderDecks();
    });
  });
  document.querySelectorAll("#tcg-env-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const envType = btn.dataset.env;
      const saved = lsGetJSON(LS.pkgEnv, {}); saved.tcgplayer = envType; lsSetJSON(LS.pkgEnv, saved);
      setEnvToggle("tcg-env-toggle", envType);
      // Auto-populate envelope cost with canonical default for this type
      const envEl = document.getElementById("tcg-s-envelope");
      if (envEl) { envEl.value = (ENV_COST[envType] / 100).toFixed(2); saveSupplies("tcgplayer"); }
      updateSupplyTotal("tcgplayer"); renderDecks();
    });
  });

  loadSupplies();

  // Avg cards per order
  document.getElementById("tcg-avg-cards")?.addEventListener("input", function() {
    const saved = lsGetJSON("ev_pkg_avg_cards", {}); saved.tcgplayer = parseFloat(this.value) || 1;
    lsSetJSON("ev_pkg_avg_cards", saved);
    updateSupplyTotal("tcgplayer"); updateTargetNetHint(); renderDecks();
  });

  // Target net input
  const $targetNet = document.getElementById("target-net-value");
  if ($targetNet) {
    $targetNet.value = lsGet("ev_target_net", "");
    $targetNet.addEventListener("input", function() {
      lsSet("ev_target_net", this.value);
      updateTargetNetHint();
      renderDecks();
    });
  }
  updateTargetNetHint();

  // ── Value floor + land filter ──────────────────────────────────────────────

  let skipLands = lsGet("ev_skip_lands", "0") === "1";

  const $skipLandsBtn = document.getElementById("skip-lands-btn");
  if ($skipLandsBtn) {
    $skipLandsBtn.classList.toggle("active", skipLands);
    $skipLandsBtn.addEventListener("click", () => {
      skipLands = !skipLands;
      $skipLandsBtn.classList.toggle("active", skipLands);
      lsSet("ev_skip_lands", skipLands ? "1" : "0");
      renderDecks();
    });
  }

  const $minList = document.getElementById("min-list-value");
  if ($minList) {
    $minList.value = lsGet("ev_min_list", "");
    $minList.addEventListener("input", function() {
      lsSet("ev_min_list", this.value);
      renderDecks();
    });
  }

  function minListCents() {
    const v = parseFloat(document.getElementById("min-list-value")?.value || "");
    return isNaN(v) || v <= 0 ? 0 : Math.round(v * 100);
  }

  function isLand(li) {
    const sf = scryfallCache.get(li.display_key) || {};
    return (sf.type_line || "").toLowerCase().includes("land");
  }

  // Returns true if the card should be excluded from EV totals and exports.
  // min-list-$ is now a PRICE FLOOR (applied in platformListingPrice), not a filter.
  // Only lands (when skip-lands is on) and cards with no market data are excluded here.
  function autoFiltered(li, listing) {
    if (listing == null) return true;
    if (skipLands && isLand(li)) return true;
    return false;
  }

  // ── Pricing helpers ────────────────────────────────────────────────────────

  function tcgOffsetType()  { return document.getElementById("tcg-offset-type").value; }
  function tcgOffsetValue() { return parseFloat(document.getElementById("tcg-offset-value").value) || 0; }

  function tcgPricingMode()   { return lsGet(LS.tcgPricingMode, "simple"); }
  function tcgCapturePct()    { return Math.min(100, Math.max(50, parseFloat(lsGet(LS.tcgCapturePct, "90")) || 90)); }

  function tcgBeatLowestListing(market, lowestLegit) {
    // Ship charge = the Fixed Rate from Packaging & Fees (one source of truth)
    const shipCharge = currentFixedShipCents("tcgplayer");
    const floor      = parseInt(lsGet(LS.tcgBeatFloor, "35"), 10) || 0;
    // If no Direct listing data, fall back to market price
    const base = (lowestLegit > 0) ? lowestLegit - shipCharge : market;
    return Math.max(base, floor);
  }

  function tcgTieredListing(market) {
    const HIGH_THRESHOLD = 500; // $5
    const highC  = parseInt(lsGet(LS.tcgTieredHighC,  "30"), 10)  || 0;
    const lowC   = parseInt(lsGet(LS.tcgTieredLowC,   "15"), 10)  || 0;
    const lowPct = parseInt(lsGet(LS.tcgTieredLowPct, "10"), 10)  || 0;
    const floor  = parseInt(lsGet(LS.tcgTieredFloor,  "35"), 10)  || 0;

    let listing;
    if (market >= HIGH_THRESHOLD) {
      listing = market + highC;
    } else {
      const pctAdd  = Math.round(market * lowPct / 100);
      listing = market + Math.min(lowC, pctAdd);
    }
    if (floor > 0) listing = Math.max(listing, floor);
    return listing;
  }

  function platformListingPrice(li) {
    if (!li.market_price_cents) return null;
    const market = li.market_price_cents;
    let listing;
    switch (activePlat) {
      case "tcgplayer": {
        if (tcgPricingMode() === "capture-pct") {
          const capListing = tierListingCents(market, tcgCapturePct() / 100, "tcgplayer");
          // If back-calculated listing exceeds 2× market, supplies dominate the card value —
          // fall back to market price so the listing is realistic (net will be negative).
          listing = capListing > market * 2 ? market : capListing;
        } else if (tcgPricingMode() === "tiered") {
          listing = tcgTieredListing(market);
        } else if (tcgPricingMode() === "beat-lowest") {
          listing = tcgBeatLowestListing(market, li.price?.lowest_legit_cents || 0);
        } else {
          const ov = tcgOffsetValue();
          listing = tcgOffsetType() === "pct"
            ? Math.round(market * (1 + ov / 100))
            : market + Math.round(ov * 100);
        }
        break;
      }
      case "manapool": listing = market; break;
      case "ebay":     listing = ebayListingPrice(market, ebayMode); break;
      default:         listing = market;
    }
    // Apply floors: min-list-$ is an absolute floor; target-net derives a per-platform floor.
    // Both are MAX operations — they raise the price, never lower it.
    const minList = minListCents();
    if (minList > 0 && listing != null) listing = Math.max(listing, minList);
    const targetFloor = requiredListingCents(activePlat);
    if (targetFloor > 0 && listing != null) listing = Math.max(listing, targetFloor);
    return listing;
  }

  function platformNetBeforePkg(li) {
    if (!li.market_price_cents) return null;
    switch (activePlat) {
      case "tcgplayer": {
        const tcgNet = li.tcgplayer_net?.net_per_copy_cents;
        if (tcgNet == null) return null;
        const ov = tcgOffsetValue();
        if (tcgOffsetType() === "pct") {
          return Math.round(tcgNet * (1 + ov / 100));
        } else {
          const keepRate = tcgNet / li.market_price_cents;
          return Math.round(tcgNet + Math.round(ov * 100) * keepRate);
        }
      }
      case "manapool": return li.manapool_net_cents ?? null;
      case "ebay":     return li.ebay_net_cents ?? null;
      default:         return li.tcgplayer_net?.net_per_copy_cents ?? null;
    }
  }

  function platformNet(li) {
    const listing = platformListingPrice(li);
    if (listing == null) return null;
    // revenue = (listing × keepRate) + (ship × shipKeepRate) − flat/card
    // net     = revenue − physical supplies (stamp + packaging, no shipping revenue offset)
    return revenueAfterFeesCents(listing, activePlat) - physicalSuppliesCents(activePlat);
  }

  function siftThresholdCents() {
    const v = parseFloat(document.getElementById("sift-threshold")?.value || "0.25");
    return Math.round((isNaN(v) ? 25 : v) * 100);
  }

  function ebayListingPrice(marketCents, mode) {
    if (marketCents == null || marketCents < siftThresholdCents()) return null;
    const ENVELOPE = 130;
    if (mode === "freeship") return marketCents < 500 ? marketCents + ENVELOPE : marketCents;
    if (marketCents < 100) return marketCents + ENVELOPE;
    return marketCents;
  }

  function computeDeckNet(d) {
    let total = 0;
    for (const li of d.line_items || []) {
      if (userExcluded.get(String(li.tcgplayer_product_id || ""))) continue;
      const listing = platformListingPrice(li);
      const net     = platformNet(li);
      if (net == null) continue;
      // Respect manual include override; otherwise apply auto-filters
      if (!userIncluded.get(String(li.tcgplayer_product_id || "")) && autoFiltered(li, listing)) continue;
      total += net * li.qty;
    }
    return total;
  }

  function totalSinglesNet() {
    return (report.decks || []).reduce((s, d) => s + computeDeckNet(d), 0);
  }

  // Configurable capture tiers (% of market value as net profit target).
  const CAPTURE_TIERS = [0.90, 0.85, 0.80];

  // Listing price required to net exactly (market × captureRate) after all fees and supplies.
  // Formula: listing = ceil((market×rate + supplies + flat − ship×shipKeepRate) / keepRate)
  function tierListingCents(market, captureRate, plat) {
    const supplies = physicalSuppliesCents(plat);
    const flat     = perOrderFlatPerCard(plat);
    const ship     = buyerShipCentsPerCard(plat);
    const numerator = Math.round(market * captureRate) + supplies + flat - Math.round(ship * shipKeepRate(plat));
    return Math.ceil(numerator / keepRate(plat));
  }

  // Case-level net at a given capture rate using the same inclusion/filter logic as computeDeckNet.
  // Net per card = market × captureRate (the exact target by definition of tierListingCents).
  function computeTierCaseNet(captureRate) {
    let total = 0;
    for (const d of report.decks || []) {
      for (const li of d.line_items || []) {
        const pid = String(li.tcgplayer_product_id || "");
        if (userExcluded.get(pid)) continue;
        if (!li.market_price_cents) continue;
        const tierListing = tierListingCents(li.market_price_cents, captureRate, activePlat);
        if (!userIncluded.get(pid) && autoFiltered(li, tierListing)) continue;
        total += Math.round(li.market_price_cents * captureRate) * li.qty;
      }
    }
    return total;
  }

  function caseCostCents() {
    const v = parseFloat(document.getElementById("case-cost")?.value || "0");
    return Math.round((isNaN(v) ? 0 : v) * 100);
  }

  function totalCardsPerCase() {
    return (report.decks || []).reduce((s, d) => {
      const copies = d.copies || 1;
      return s + (d.line_items || []).reduce((ls, li) => ls + Math.round(li.qty / copies), 0);
    }, 0);
  }

  // ── Sellthrough helpers ───────────────────────────────────────────────────

  const tierColors = { "market": "#6a9a6a", "+10%": "#4a7fcf", "+25%": "#c8932a", "+50%": "#c84a4a", "lowest_legit": "#888" };

  function sellthroughBadge(st) {
    if (!st || st.confidence === "unknown") return `<span class="st-badge st-unknown" title="No velocity data yet">—</span>`;
    const color = tierColors[st.target_tier] || "#888";
    const tip = `${st.target_tier} of market · confidence: ${st.confidence}` +
      (st.note ? ` · ${st.note}` : "");
    return `<span class="st-badge" style="background:${color}" title="${escHtml(tip)}">${escHtml(st.target_tier)}</span>`;
  }

  function sellthroughVelCell(st, price) {
    // Show sales/day and refill/day from price row when available, fall back to sellthrough rec.
    const soldWeek  = price?.units_sold_week   ?? st?.weekly_velocity ?? null;
    const refillWk  = price?.add_back_units_week ?? st?.refill_rate_week ?? null;
    if (soldWeek == null) return `<td class="right muted st-col" data-cents="0">—</td>`;

    const soldDay   = (soldWeek / 7).toFixed(1);
    const refillDay = refillWk != null ? (refillWk / 7).toFixed(1) : null;
    const drain     = refillWk != null ? soldWeek - refillWk : null;
    const tip = [
      `Sold: ${soldWeek}/wk (${soldDay}/day)`,
      refillWk != null ? `Relisted: ${refillWk}/wk (${refillDay}/day)` : null,
      drain != null ? `Net drain: ${drain}/wk` : null,
    ].filter(Boolean).join(" · ");
    const cls = drain != null && drain < soldWeek && drain > 0 ? "warn" : "";
    return `<td class="right st-col ${cls}" data-cents="${Math.round(soldWeek * 10)}" title="${escHtml(tip)}">${soldDay}/d${refillDay ? `<span class="st-drain">↺${refillDay}</span>` : ""}</td>`;
  }

  function tierCell(li) {
    if (!li.market_price_cents) return `<td class="right tier-col muted">—</td>`;
    const market = li.market_price_cents;
    const parts  = CAPTURE_TIERS.map(r => {
      const lc  = tierListingCents(market, r, activePlat);
      const net = Math.round(market * r);
      return { r, lc, net };
    });
    const tip = parts.map(p =>
      `${Math.round(p.r*100)}%: list ${EV.fmtUSD(p.lc)} → net ${EV.fmtUSD(p.net)}`
    ).join(" | ");
    const display = parts.map(p => EV.fmtUSD(p.lc)).join(" / ");
    return `<td class="right tier-col" title="${tip}" style="font-size:0.73rem;white-space:nowrap">${display}</td>`;
  }

  function listedCell(price) {
    const cnt = price?.listing_count;
    if (cnt == null) return `<td class="right st-col muted" data-cents="0">—</td>`;
    return `<td class="right st-col" data-cents="${cnt}" title="${cnt} active listings">${cnt}</td>`;
  }

  // Days-to-sell at each depth tier, using price row depth fields.
  function daysDepthCell(st, price) {
    const soldWeek = price?.units_sold_week ?? st?.weekly_velocity ?? null;
    const refillWk = price?.add_back_units_week ?? st?.refill_rate_week ?? null;
    const velocity = soldWeek != null
      ? (refillWk != null ? Math.max(soldWeek - refillWk, 0) : soldWeek)
      : null;

    if (!velocity || velocity === 0) return `<td class="right st-col muted">—</td>`;

    const mkt  = price?.market_price_cents;
    const d10  = price?.depth_to_plus_10_units;
    const d25  = price?.depth_to_plus_25_units;
    const d50  = price?.depth_to_plus_50_units;

    const rows = [];
    if (mkt)  rows.push({ label: "mkt",  days: 0,                      price: mkt });
    if (d10 != null) rows.push({ label: "+10%", days: Math.round(d10  / velocity * 7), price: Math.round(mkt * 1.10) });
    if (d25 != null) rows.push({ label: "+25%", days: Math.round(d25  / velocity * 7), price: Math.round(mkt * 1.25) });
    if (d50 != null) rows.push({ label: "+50%", days: Math.round(d50  / velocity * 7), price: Math.round(mkt * 1.50) });

    if (!rows.length) return `<td class="right st-col muted" data-cents="0">—</td>`;

    const tip = rows.map(r =>
      `${r.label}: ${EV.fmtUSD(r.price)} → ${r.days === 0 ? "instant" : r.days + "d"}`
    ).join(" · ");

    // Display the recommended tier from sellthrough rec, with full tooltip.
    const rec   = st?.target_tier;
    const wks   = st?.expected_weeks;
    const label = wks != null && wks > 0
      ? `${wks.toFixed(1)}wk`
      : rows.length ? (rows[rows.length - 1].days > 0 ? rows[rows.length - 1].days + "d" : "instant") : "—";
    const cls   = wks != null ? (wks <= 1 ? "pos" : wks <= 3 ? "" : "warn") : "";

    const sortVal = wks != null ? Math.round(wks * 10) : 9999;
    return `<td class="right st-col ${cls}" data-cents="${sortVal}" title="${escHtml(tip)}">${label}${sellthroughBadge(st)}</td>`;
  }

  function sellthroughRecCell(st, caseCostPerCard) {
    if (!st || st.confidence === "unknown" || !st.target_price_cents) return `<td class="right muted">—</td>`;
    const recNet = Math.round(st.target_price_cents * 0.8715);
    const roi = caseCostPerCard > 0 ? ((recNet - caseCostPerCard) / caseCostPerCard * 100).toFixed(0) : null;
    const roiStr = roi != null ? ` <span class="st-roi ${+roi >= 0 ? "pos" : "neg"}">${+roi >= 0 ? "+" : ""}${roi}%</span>` : "";
    const tip = `Rec: ${st.target_tier} · ${st.depth_ahead_units} units ahead · ${st.weekly_velocity} sold/wk · exp ${st.expected_weeks?.toFixed(1)} wks`;
    return `<td class="right" title="${escHtml(tip)}">${EV.fmtUSD(st.target_price_cents)}${roiStr} ${sellthroughBadge(st)}</td>`;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const $grid = document.querySelector("#decks");
  const scryfallCache = new Map();
  const TCG_IMG_BASE = EV.api("/v1/images").replace(/\/$/, "");

  function renderDecks() {
    const singlesNet   = totalSinglesNet();
    const [net90, net85, net80] = CAPTURE_TIERS.map(r => computeTierCaseNet(r));
    const caseCost     = caseCostCents() || report.case_cost_cents || 0;
    const decksBuyCost = report.sealed_decks_gross_cents || 0;
    const sealedNet    = report.sealed_decks_net_cents   || 0;

    const singlesDeltaCase  = caseCost ? singlesNet - caseCost : null;
    const sealedDeltaCase   = caseCost ? sealedNet  - caseCost : null;
    const singlesDeltaDecks = decksBuyCost ? singlesNet - decksBuyCost : null;
    const decksSave         = caseCost && decksBuyCost ? caseCost - decksBuyCost : null;
    const decksCheaper      = decksSave != null && decksSave > 0;

    const platLabel = { tcgplayer: "TCGPlayer", manapool: "Manapool", ebay: "eBay" }[activePlat] || activePlat;
    const paidLine  = caseCost ? `<div class="card-sub muted">Paid: ${EV.fmtUSD(caseCost)}</div>` : "";
    const pctOf     = (delta) => EV.fmtPct(caseCost ? delta / caseCost : null);

    const sealedCard = caseCost
      ? `<div class="card ${EV.deltaClass(sealedDeltaCase)}">
           <label>Sell sealed today — profit</label>
           <value>${EV.fmtUSD(sealedDeltaCase)} <span style="font-size:0.85rem;font-weight:400">(${pctOf(sealedDeltaCase)})</span></value>
           <div class="card-sub">Net proceeds: ${EV.fmtUSD(sealedNet)}</div>
           ${paidLine}
         </div>`
      : `<div class="card">
           <label>Sell sealed decks (after fees)</label>
           <value>${EV.fmtUSD(sealedNet || null)}</value>
         </div>`;

    const tierRows = CAPTURE_TIERS.map((r, i) => {
      const nets   = [net90, net85, net80][i];
      const delta  = caseCost ? nets - caseCost : null;
      const cls    = EV.deltaClass(delta);
      const pct    = caseCost ? ` (${EV.fmtPct(delta / caseCost)})` : "";
      return `<div class="tier-row">
        <span class="tier-label">${Math.round(r*100)}% capture</span>
        <span class="tier-net ${cls}">${EV.fmtUSD(nets)}</span>
        ${delta != null ? `<span class="tier-delta ${cls}">${EV.fmtUSD(delta)} profit${pct}</span>` : ""}
      </div>`;
    }).join("");

    const singlesCard = caseCost
      ? `<div class="card ${EV.deltaClass(singlesDeltaCase)}">
           <label>Crack singles today — profit (${platLabel})</label>
           <value>${EV.fmtUSD(singlesDeltaCase)} <span style="font-size:0.85rem;font-weight:400">(${pctOf(singlesDeltaCase)})</span></value>
           <div class="card-sub">Net proceeds: ${EV.fmtUSD(singlesNet)}</div>
           ${paidLine}
           <div class="tier-breakdown">${tierRows}</div>
         </div>`
      : `<div class="card">
           <label>Crack &amp; sell singles — ${platLabel}</label>
           <value>${EV.fmtUSD(singlesNet)}</value>
           <div class="tier-breakdown">${tierRows}</div>
         </div>`;

    const decksCard = `
      <div class="card ${decksCheaper ? "pos" : ""}" title="Cost if you buy each deck individually.">
        <label>Buy decks individually</label>
        <value>${EV.fmtUSD(decksBuyCost || null)}</value>
        ${decksSave != null ? `<div class="card-sub ${EV.deltaClass(decksSave)}">${decksCheaper ? "Saves" : "Costs"} ${EV.fmtUSD(Math.abs(decksSave))} vs case</div>` : ""}
        ${singlesDeltaDecks != null ? `<div class="card-sub ${EV.deltaClass(singlesDeltaDecks)}">Singles profit: ${EV.fmtUSD(singlesDeltaDecks)}</div>` : ""}
      </div>`;

    document.querySelector("#totals").innerHTML = `
      <div class="totals-row">
        ${sealedCard}
        ${singlesCard}
        ${decksBuyCost ? decksCard : ""}
      </div>`;

    $grid.innerHTML = (report.decks || []).map(buildDeckCard).join("");

    collapsedDecks.forEach(key => {
      const card = $grid.querySelector(`.deck-card[data-deck-key="${key}"]`);
      if (!card) return;
      card.querySelector(".deck-singles")?.classList.add("hidden");
      const btn = card.querySelector(".deck-collapse-btn");
      if (btn) { btn.textContent = "▶ Cards"; btn.classList.add("collapsed"); }
    });

    $grid.querySelectorAll("table.cards").forEach(table => {
      table.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => sortTable(table, +th.cellIndex, th.dataset.sort));
      });
    });

    $grid.querySelectorAll(".ev-toggle").forEach(cell => {
      cell.addEventListener("click", () => {
        const pid = cell.dataset.pid;
        if (!pid) return;
        const on = !cell.classList.contains("ev-override-off") &&
          (cell.classList.contains("ev-override-on") || cell.textContent.trim() === "✓");
        if (on) { userExcluded.set(pid, true); userIncluded.delete(pid); }
        else    { userIncluded.set(pid, true); userExcluded.delete(pid); }
        renderDecks();
      });
    });
  }

  function buildDeckCard(d) {
    const copies     = d.copies || 1;
    const sealedMkt  = d.sealed_market_cents;
    const sealedNet  = d.sealed_net_cents;
    const singlesNet = computeDeckNet(d);

    const sealedTotal  = sealedNet  != null ? sealedNet  * copies : null;
    const singlesPerCopy = singlesNet != null && copies > 0 ? singlesNet / copies : null;
    const delta = sealedTotal != null && singlesNet != null ? singlesNet - sealedTotal : null;

    const verdictClass = delta == null ? "win-even" : delta > 0 ? "win-singles" : "win-sealed";
    const verdictText  = delta == null
      ? "No sealed price data"
      : delta > 0
        ? `Crack nets ${EV.fmtUSD(delta)} more than selling sealed`
        : `Sealed nets ${EV.fmtUSD(-delta)} more than cracking`;

    const thumbHtml = d.image
      ? `<img class="deck-thumb" src="${d.image}" alt="${escHtml(d.name)}" loading="lazy">`
      : `<div class="deck-thumb-placeholder"></div>`;

    return `
      <div class="deck-card" data-deck-key="${d.deck_key}">
        <div class="deck-header">
          ${thumbHtml}
          <div class="deck-header-info">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem">
              <h2 style="margin:0">${escHtml(d.name)}</h2>
              <button class="deck-collapse-btn" title="Collapse/expand card list">▼ Cards</button>
            </div>
            <div class="deck-copies">${copies} cop${copies === 1 ? "y" : "ies"} in case</div>
            <div class="deck-scenarios">
              <span>Sealed: ${EV.fmtUSD(sealedMkt)}/copy → <strong>${EV.fmtUSD(sealedNet)}</strong> net</span>
              <span class="deck-scenario-sep">·</span>
              <span>Crack: <strong class="${delta != null && delta > 0 ? "pos" : ""}">${EV.fmtUSD(singlesPerCopy)}</strong>/copy net</span>
            </div>
            <div class="deck-verdict-inline ${verdictClass}">${verdictText}</div>
          </div>
        </div>
        ${buildSinglesPanel(d)}
      </div>`;
  }

  function buildSinglesPanel(d) {
    const copies = d.copies || 1;
    const platLabel = { tcgplayer: "TCG Net", manapool: "MP Net", ebay: "eBay Net" }[activePlat] || "Net";

    const lines = (d.line_items || []).slice().sort((a, b) => {
      switch (csvSort) {
        case "price-asc":  return (a.market_price_cents||0) - (b.market_price_cents||0);
        case "price-desc": return (b.market_price_cents||0) - (a.market_price_cents||0);
        case "rarity": {
          const sa = scryfallCache.get(a.display_key) || {};
          const sb = scryfallCache.get(b.display_key) || {};
          const ra = rarityOrder[scryfallRarity(sa.rarity)] ?? 9;
          const rb = rarityOrder[scryfallRarity(sb.rarity)] ?? 9;
          return ra - rb || (a.name||"").localeCompare(b.name||"");
        }
        default: return (a.name||"").localeCompare(b.name||"");
      }
    });

    const caseCostCentsVal = caseCostCents() || report.case_cost_cents || 0;
    const totalCards = totalCardsPerCase();
    const costPerCard = caseCostCentsVal > 0 && totalCards > 0 ? caseCostCentsVal / totalCards : 0;

    const rows = lines.map(li => {
      const qtyPerCopy = Math.round(li.qty / copies);
      const net        = platformNet(li);
      const listing    = platformListingPrice(li);
      const caseTotal  = net != null ? net * li.qty : null;
      const pid        = String(li.tcgplayer_product_id || "");
      const stockSrc   = pid ? `${TCG_IMG_BASE}/${pid}.jpg` : "";
      const sf         = scryfallCache.get(li.display_key) || {};
      const rarity     = scryfallRarity(sf.rarity);
      const setCode    = (sf.set || "").toUpperCase();
      const collNum    = sf.collector_number || "";
      const price      = li.price || {};

      const forceExclude = userExcluded.get(pid);
      const forceInclude = userIncluded.get(pid);
      const filtered     = !forceInclude && autoFiltered(li, listing);
      const exportOn     = forceExclude ? false : forceInclude ? true : !filtered && listing != null;
      const evIcon  = forceInclude ? "✓" : filtered ? "⊘" : forceExclude ? "⊘" : exportOn ? "✓" : "—";
      const evClass = forceExclude ? "ev-override-off" : forceInclude ? "ev-override-on" : filtered ? "ev-filtered" : "";

      const st = li.sellthrough;

      // Low listed: lowest TCGPlayer Direct price (vetted sellers, free shipping)
      const lowListedCell = `<td class="right" data-cents="${price.lowest_legit_cents ?? 0}" title="Lowest TCGPlayer Direct listing${price.lowest_legit_cents ? '' : ' — no data'}">${EV.fmtUSD(price.lowest_legit_cents)}</td>`;

      // Sale $ = listing + ship charge to buyer
      const sale    = salePriceCents(listing, activePlat);
      const revenue = revenueAfterFeesCents(listing, activePlat);
      const shipAmt = buyerShipCentsPerCard(activePlat);

      // List $ tooltip: show derivation for beat-lowest and capture-pct modes
      let listTip = "";
      const tcgMode = activePlat === "tcgplayer" ? tcgPricingMode() : "";
      if (tcgMode === "beat-lowest" && listing != null) {
        const low  = price.lowest_legit_cents;
        const ship = currentFixedShipCents("tcgplayer");
        listTip = low
          ? `title="Low Direct ${EV.fmtUSD(low)} − Ship ${EV.fmtUSD(ship)} = ${EV.fmtUSD(listing)}"`
          : `title="No Direct data — using market price ${EV.fmtUSD(li.market_price_cents)}"`;
      } else if (tcgMode === "capture-pct" && listing != null) {
        const pct = tcgCapturePct();
        listTip = `title="Capture ${pct}% of market ${EV.fmtUSD(li.market_price_cents)} after fees & supplies → list ${EV.fmtUSD(listing)}"`;
      }

      const saleTip = shipAmt > 0
        ? `title="Buyer pays: List ${EV.fmtUSD(listing)} + Ship ${EV.fmtUSD(shipAmt)} = ${EV.fmtUSD(sale)}"`
        : `title="Buyer pays list price only (no fixed shipping charge)"`;
      const revTip = revenue != null
        ? `title="Sale ${EV.fmtUSD(sale)} × ${(keepRate(activePlat)*100).toFixed(2)}% keep = ${EV.fmtUSD(revenue)}"`
        : "";
      const netTip = net != null
        ? `title="Revenue ${EV.fmtUSD(revenue)} − supplies ${EV.fmtUSD(physicalSuppliesCents(activePlat))} = ${EV.fmtUSD(net)}"`
        : "";

      const rowClass = forceExclude ? "excluded" : filtered ? "filtered" : "";
      return `<tr class="${rowClass}" data-pid="${pid}">
        <td class="ev-toggle ${evClass}" data-pid="${pid}" title="Toggle inclusion" style="cursor:pointer;text-align:center">${evIcon}</td>
        <td class="img-cell center">${stockSrc ? `<img src="${stockSrc}" class="card-thumb" loading="lazy" alt="">` : "—"}</td>
        <td>${escHtml(li.name || li.display_key)}${cardLinks(li)}</td>
        <td class="muted" style="font-size:0.78rem">${escHtml(rarity)}</td>
        <td class="muted" style="font-size:0.78rem">${escHtml(setCode)}</td>
        <td class="muted right" style="font-size:0.78rem">${escHtml(collNum)}</td>
        <td class="right">${qtyPerCopy}</td>
        <td class="right" data-cents="${li.market_price_cents ?? 0}">${EV.fmtUSD(li.market_price_cents)}</td>
        ${lowListedCell}
        <td class="right" ${listTip}>${EV.fmtUSD(listing)}</td>
        <td class="right muted" data-cents="${sale ?? 0}" ${saleTip}>${EV.fmtUSD(sale)}</td>
        <td class="right muted" data-cents="${revenue ?? 0}" ${revTip}>${EV.fmtUSD(revenue)}</td>
        <td class="right ${net == null ? "muted" : ""}" data-cents="${net ?? 0}" ${netTip}>${EV.fmtUSD(net)}</td>
        <td class="right ${caseTotal == null ? "muted" : ""}" data-cents="${caseTotal ?? 0}">${EV.fmtUSD(caseTotal)}</td>
        ${tierCell(li)}
        ${listedCell(price)}
        ${sellthroughVelCell(st, price)}
        ${sellthroughRecCell(st, costPerCard)}
        ${daysDepthCell(st, price)}
      </tr>`;
    }).join("");

    const avgCards = avgCardsPerOrder(activePlat);
    const platFeeNote = {
      tcgplayer: `10.75% on item + 2.5% on item+ship + $0.30/order (÷${avgCards} cards) = 13.25% on item, 2.5% on ship, $${(0.30/avgCards).toFixed(2)} flat/card`,
      manapool:  "8% seller fee, minus packaging costs",
      ebay:      `13.25% FVF + $0.30/order (÷${avgCards} cards)`,
    }[activePlat] || "";
    const tnActive  = targetNetCents() > 0;
    const isBeatLow = activePlat === "tcgplayer" && tcgPricingMode() === "beat-lowest";
    const shipAmt   = buyerShipCentsPerCard(activePlat);
    const listingTh = `<th class="right" title="${
      isBeatLow
        ? `Beat Lowest: Low Direct − Ship rate (${EV.fmtUSD(currentFixedShipCents('tcgplayer'))}) = your list price. Hover a cell to see the exact derivation. Falls back to market price if no Direct data.`
        : tnActive
          ? `Target-net floor active — bumped up where needed to hit your target net after fees &amp; packaging.`
          : `Your listing price. Set via Market ± offset above.`
    }">List $</th>`;
    const saleTh    = `<th class="right muted" title="Total buyer cost = List + ${shipAmt > 0 ? `Ship (${EV.fmtUSD(shipAmt)})` : `no fixed ship charge`}. Hover a cell for the breakdown.">Sale $</th>`;
    const revTh     = `<th class="right muted" title="Revenue after ${(keepRate(activePlat)*100).toFixed(2)}% marketplace fees. Sale price × keep rate. Hover a cell to verify.">Revenue</th>`;

    return `
      <div class="deck-singles">
        <div class="singles-table-wrap">
          <table class="data cards">
            <thead><tr>
              <th title="Include / exclude this card from the EV totals. Click to override. ✓ = included, — = excluded." style="width:2rem">EV</th>
              <th style="width:3.5rem" title="Card image from TCGPlayer">Img</th>
              <th data-sort="text" title="Card name. T / M / e links open TCGPlayer, Manapool, and eBay sold listings.">Card</th>
              <th title="Card rarity from Scryfall (Mythic Rare / Rare / Uncommon / Common)">Rarity</th>
              <th title="Set code of this specific printing (from Scryfall)">Set</th>
              <th class="right" title="Collector number for this printing">№</th>
              <th class="right" data-sort="num" title="Copies of this card per deck (before multiplying by deck copies in case)">Qty</th>
              <th class="right" data-sort="num" title="TCGPlayer market price — weighted average of recent completed sales">Market</th>
              <th class="right" data-sort="num" title="Lowest active TCGPlayer Direct listing (vetted sellers, free shipping included). Generally the most reliable price floor.">Low</th>
              ${listingTh}
              ${saleTh}
              ${revTh}
              <th class="right" data-sort="num" title="Net profit per card = Revenue − physical supplies (${EV.fmtUSD(physicalSuppliesCents(activePlat))}/card). ${platFeeNote}. Hover a cell to verify.">${platLabel}</th>
              <th class="right" data-sort="num" title="Net profit × qty = total profit contribution of this card across all copies in the case">Case Total</th>
              <th class="right tier-col" title="Listing price required to capture 90% / 85% / 80% of market value as net profit after all fees and supplies. Hover a cell for the breakdown. Future: velocity estimate per tier.">Tiers 90/85/80</th>
              <th class="right st-col" data-sort="num" title="Active listings currently on TCGPlayer for this card. Lower = less competition.">Listed</th>
              <th class="right st-col" data-sort="num" title="Sales per day (units sold last 7 days ÷ 7). ↺ = re-list rate per day (new supply coming back to market). Net drain = sold − relisted.">Vel/d</th>
              <th class="right st-col" title="Recommended listing price based on sell-through velocity: the cheapest price tier where your copy sells within ~3 weeks. Badge shows tier. ROI shown vs case cost/card.">Rec Price</th>
              <th class="right st-col" data-sort="num" title="Weeks (or days) to sell at the recommended tier given current velocity. Hover for breakdown at each price tier: market, +10%, +25%, +50%.">Days@</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  renderDecks();

  // Deck collapse toggle (delegated).
  $grid.addEventListener("click", e => {
    const btn = e.target.closest(".deck-collapse-btn");
    if (!btn) return;
    const card = btn.closest(".deck-card");
    if (!card) return;
    const key = card.dataset.deckKey;
    const singles = card.querySelector(".deck-singles");
    const collapsed = collapsedDecks.has(key);
    if (collapsed) {
      collapsedDecks.delete(key);
      singles?.classList.remove("hidden");
      btn.textContent = "▼ Cards";
      btn.classList.remove("collapsed");
    } else {
      collapsedDecks.add(key);
      singles?.classList.add("hidden");
      btn.textContent = "▶ Cards";
      btn.classList.add("collapsed");
    }
  });

  // ── Scryfall metadata ──────────────────────────────────────────────────────

  const rarityOrder = { "Mythic Rare":0, "Rare":1, "Uncommon":2, "Common":3 };

  function parseDisplayKey(dk) {
    if (!dk) return null;
    const parts = dk.split("-");
    if (parts.length < 4 || parts[0] !== "mtg") return null;
    const finish = parts[parts.length - 1];
    if (!["nf", "f", "e"].includes(finish)) return null;
    const number = parts[parts.length - 2];
    if (!/^\d+[a-z★]?$/.test(number)) return null;
    return { set: parts.slice(1, -2).join("-"), number };
  }

  const scryfallReady = (async () => {
    await loadScryfallMeta();
    const allLineItems = (report.decks || [])
      .flatMap(d => d.line_items || [])
      .filter(li => li.display_key);
    await fetchScryfallMeta(allLineItems);
    renderDecks();
  })();

  async function loadScryfallMeta() {
    try {
      const res  = await fetch("/data/scryfall-meta.json");
      const data = await res.json();
      for (const [dk, meta] of Object.entries(data)) scryfallCache.set(dk, meta);
    } catch (_) {}
  }

  async function fetchScryfallMeta(lineItems) {
    const uncached = lineItems.filter(li => !scryfallCache.has(li.display_key));
    const parsed = uncached.map(li => {
      const p = parseDisplayKey(li.display_key);
      return p ? { display_key: li.display_key, ...p } : null;
    }).filter(Boolean);
    if (!parsed.length) return;
    for (let i = 0; i < parsed.length; i += 75) {
      const batch = parsed.slice(i, i + 75);
      try {
        const res  = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifiers: batch.map(({ set, number }) => ({ set, collector_number: number })),
          }),
        });
        const data = await res.json();
        const lookup = new Map(batch.map(({ set, number, display_key }) => [`${set}:${number}`, display_key]));
        (data.data || []).forEach(card => {
          const dk = lookup.get(`${card.set}:${card.collector_number}`);
          if (dk) scryfallCache.set(dk, card);
        });
      } catch (_) {}
    }
  }

  function scryfallCardType(typeLine) {
    if (!typeLine) return "";
    const base  = typeLine.split("—")[0].trim();
    const types = ["Land","Creature","Planeswalker","Artifact","Enchantment","Instant","Sorcery","Battle"];
    return types.find(t => base.includes(t)) || base.split(" ").pop();
  }

  function scryfallRarity(rarity) {
    const map = { common: "Common", uncommon: "Uncommon", rare: "Rare", mythic: "Mythic Rare", special: "Special/Bonus Card" };
    return map[rarity] || "";
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function cardLinks(li) {
    const name         = li.name || li.display_key;
    const encodedName  = encodeURIComponent(name);
    const ebayKW       = encodeURIComponent(name + " Commander " + ebaySetName + " ").replace(/%20/g, "+");
    const now          = Date.now();
    const ebayURL      = `https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=${ebayKW}&dayRange=30&endDate=${now}&startDate=${now - 30*24*60*60*1000}&categoryId=0&offset=0&limit=50&tabName=SOLD&tz=America%2FNew_York`;
    const tcgURL       = li.tcgplayer_product_id ? `https://www.tcgplayer.com/product/${li.tcgplayer_product_id}` : null;
    const mpURL        = `https://manapool.com/search?q=${encodedName}`;
    return `<span class="card-links">`
      + (tcgURL ? `<a class="card-link card-link-tcg" href="${tcgURL}" target="_blank" rel="noopener" title="TCGPlayer">T</a>` : "")
      + `<a class="card-link card-link-mp" href="${mpURL}" target="_blank" rel="noopener" title="Manapool">M</a>`
      + `<a class="card-link card-link-ebay" href="${ebayURL}" target="_blank" rel="noopener" title="eBay sold">e</a>`
      + `</span>`;
  }

  // ── Export helpers ────────────────────────────────────────────────────────

  function buildExportCSV(deckKeys) {
    const decksToExport = (report.decks || []).filter(d => deckKeys.includes(d.deck_key));
    const platLabel = { tcgplayer:"TCGPlayer", manapool:"Manapool", ebay:"eBay" }[activePlat] || activePlat;
    const supplyNote = `${EV.fmtUSD(packagingCostCents(activePlat))}/card supplies (${activePlat})`;

    const header = ["Deck","Card","Set","#","Rarity","Qty/Copy","Copies","Total Qty","Market","Low Listed","List Price","Net After Fees","Net After Pkg","Case Total Net"];
    const rows = [header];

    for (const d of decksToExport) {
      const copies = d.copies || 1;
      const lines = (d.line_items || []).slice().sort((a, b) => (a.name||"").localeCompare(b.name||""));
      for (const li of lines) {
        const sf         = scryfallCache.get(li.display_key) || {};
        const rarity     = scryfallRarity(sf.rarity) || "";
        const setCode    = (sf.set || "").toUpperCase();
        const collNum    = sf.collector_number || "";
        const qtyPerCopy = Math.round(li.qty / copies);
        const totalQty   = li.qty;
        const market     = li.market_price_cents ? (li.market_price_cents / 100).toFixed(2) : "";
        const low        = li.price?.lowest_legit_cents ? (li.price.lowest_legit_cents / 100).toFixed(2) : "";
        const listing    = platformListingPrice(li);
        const netFees    = platformNetBeforePkg(li);
        const netPkg     = platformNet(li);
        const caseTotal  = netPkg != null ? netPkg * li.qty : null;
        rows.push([
          d.name,
          li.name || li.display_key,
          setCode,
          collNum,
          rarity,
          qtyPerCopy,
          copies,
          totalQty,
          market,
          low,
          listing != null ? (listing / 100).toFixed(2) : "",
          netFees != null ? (netFees / 100).toFixed(2) : "",
          netPkg  != null ? (netPkg  / 100).toFixed(2) : "",
          caseTotal != null ? (caseTotal / 100).toFixed(2) : "",
        ]);
      }
    }

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const filename = `ev-${report.key || "case"}-${platLabel.toLowerCase()}.csv`;
    downloadText(csv, filename, "text/csv");
  }

  // Price list CSV: all cards with a computed price, no qty/filter logic.
  // Intended to feed listing prices into the Box Break App.
  function buildPriceListCSV() {
    const header = ["TCGplayer Id","Card Name","Listing Price"];
    const rows   = [];
    const seen   = new Set();

    for (const d of report.decks || []) {
      for (const li of d.line_items || []) {
        const pid = String(li.tcgplayer_product_id || "");
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        const listing = platformListingPrice(li);
        if (listing == null) continue;
        rows.push([pid, li.name || li.display_key, (listing / 100).toFixed(2)]);
      }
    }

    rows.sort((a, b) => a[1].localeCompare(b[1]));
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadText(csv, `price-list-${report.key || "case"}.csv`, "text/csv");
  }

  // TCGPlayer bulk-listing CSV: TCGplayer Id, Condition, Add to Quantity, TCG Marketplace Price
  function buildTCGPlayerCSV() {
    const header = ["TCGplayer Id","Condition","Add to Quantity","TCG Marketplace Price"];
    const rows   = [header];

    for (const d of report.decks || []) {
      for (const li of d.line_items || []) {
        const pid = String(li.tcgplayer_product_id || "");
        if (!pid) continue;
        if (userExcluded.get(pid)) continue;
        const listing = platformListingPrice(li);
        if (!userIncluded.get(pid) && autoFiltered(li, listing)) continue;
        if (listing == null) continue;
        rows.push([
          pid,
          "Near Mint",
          li.qty,
          (listing / 100).toFixed(2),
        ]);
      }
    }

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const filename = `tcgplayer-listing-${report.key || "case"}.csv`;
    downloadText(csv, filename, "text/csv");
  }

  function downloadText(content, filename, mime) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
  }

  function openPrintPricing(deckKeys) {
    const decksToExport = (report.decks || []).filter(d => deckKeys.includes(d.deck_key));
    const platLabel = { tcgplayer:"TCGPlayer", manapool:"Manapool", ebay:"eBay" }[activePlat] || activePlat;
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Pricing — ${escHtml(report.name)}</title>
<style>
  body { font: 11px/1.4 sans-serif; padding: 1rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  h2 { font-size: 0.95rem; margin: 1rem 0 0.3rem; border-bottom: 1px solid #ccc; padding-bottom: 0.2rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.2rem 0.4rem; text-align: left; }
  th { background: #f4f4f4; }
  .right { text-align: right; }
  .muted { color: #888; }
  input[type=checkbox] { margin-right: 0.3rem; }
  @media print { .no-print { display:none; } }
</style></head><body>
<h1>${escHtml(report.name)} — ${platLabel} Pricing Sheet</h1>
<p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">Supplies: ${EV.fmtUSD(packagingCostCents(activePlat))}/card · Generated ${new Date().toLocaleDateString()}</p>
<button class="no-print" onclick="window.print()">Print</button>`;

    for (const d of decksToExport) {
      const copies = d.copies || 1;
      const lines = (d.line_items || [])
        .filter(li => platformListingPrice(li) != null)
        .sort((a, b) => (a.name||"").localeCompare(b.name||""));
      html += `<h2>${escHtml(d.name)}</h2>
<table><thead><tr><th></th><th>Card</th><th>Rarity</th><th class="right">Qty</th><th class="right">List ${platLabel}</th><th class="right">Net/card</th><th class="right">Net Total</th></tr></thead><tbody>`;
      for (const li of lines) {
        const sf       = scryfallCache.get(li.display_key) || {};
        const rarity   = scryfallRarity(sf.rarity) || "";
        const qty      = Math.round(li.qty / copies);
        const listing  = platformListingPrice(li);
        const netPkg   = platformNet(li);
        html += `<tr>
          <td><input type="checkbox"></td>
          <td>${escHtml(li.name || li.display_key)}</td>
          <td class="muted">${escHtml(rarity)}</td>
          <td class="right">${qty}</td>
          <td class="right">${EV.fmtUSD(listing)}</td>
          <td class="right">${EV.fmtUSD(netPkg)}</td>
          <td class="right">${EV.fmtUSD(netPkg != null ? netPkg * qty : null)}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</body></html>`;
    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
  }

  // Export bar event wiring
  document.getElementById("export-case-btn")?.addEventListener("click", () => {
    buildExportCSV((report.decks || []).map(d => d.deck_key));
  });

  document.getElementById("print-pricing-btn")?.addEventListener("click", () => {
    openPrintPricing((report.decks || []).map(d => d.deck_key));
  });

  document.getElementById("export-deck-select-btn")?.addEventListener("click", () => {
    const modal = document.getElementById("deck-select-modal");
    const list  = document.getElementById("deck-select-list");
    list.innerHTML = (report.decks || []).map(d =>
      `<label style="display:block;padding:0.25rem 0">
        <input type="checkbox" value="${escHtml(d.deck_key)}" checked>
        ${escHtml(d.name)} (${d.copies} cop${d.copies === 1 ? "y":"ies"})
       </label>`
    ).join("");
    modal.classList.remove("hidden");
  });

  document.getElementById("deck-select-confirm")?.addEventListener("click", () => {
    const keys = Array.from(document.querySelectorAll("#deck-select-list input:checked"))
      .map(cb => cb.value);
    document.getElementById("deck-select-modal").classList.add("hidden");
    if (keys.length) buildExportCSV(keys);
  });
  document.getElementById("deck-select-cancel")?.addEventListener("click", () => {
    document.getElementById("deck-select-modal").classList.add("hidden");
  });

  document.getElementById("export-tcg-csv-btn")?.addEventListener("click", buildTCGPlayerCSV);
  document.getElementById("export-price-list-btn")?.addEventListener("click", buildPriceListCSV);

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  let sortState = { col: null, dir: 1 };
  function sortTable(table, colIdx, type) {
    const tbody = table.tBodies[0];
    const rows  = Array.from(tbody.rows);
    const dir   = sortState.col === colIdx ? -sortState.dir : 1;
    sortState   = { col: colIdx, dir };
    rows.sort((a, b) => {
      const av = type === "num" ? +a.cells[colIdx].dataset.cents : a.cells[colIdx].textContent;
      const bv = type === "num" ? +b.cells[colIdx].dataset.cents : b.cells[colIdx].textContent;
      return av < bv ? -1*dir : av > bv ? dir : 0;
    });
    rows.forEach(r => tbody.appendChild(r));
  }
})();
