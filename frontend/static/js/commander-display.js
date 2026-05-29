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
    tcgOffsetType: "ev_tcg_offset_type",
    tcgOffsetVal:  "ev_tcg_offset_val",
    sift:          "ev_sift_threshold",
  };

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
      renderDecks();
    });
  });

  // TCGPlayer offset inputs
  document.getElementById("tcg-offset-type").addEventListener("change", function() {
    lsSet(LS.tcgOffsetType, this.value);
    renderDecks();
  });
  document.getElementById("tcg-offset-value").addEventListener("input", function() {
    lsSet(LS.tcgOffsetVal, this.value);
    renderDecks();
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

  // ── Pricing helpers ────────────────────────────────────────────────────────

  function tcgOffsetType()  { return document.getElementById("tcg-offset-type").value; }
  function tcgOffsetValue() { return parseFloat(document.getElementById("tcg-offset-value").value) || 0; }

  function platformListingPrice(li) {
    if (!li.market_price_cents) return null;
    const market = li.market_price_cents;
    switch (activePlat) {
      case "tcgplayer": {
        const ov = tcgOffsetValue();
        return tcgOffsetType() === "pct"
          ? Math.round(market * (1 + ov / 100))
          : market + Math.round(ov * 100);
      }
      case "manapool": return market;
      case "ebay":     return ebayListingPrice(market, ebayMode);
      default:         return market;
    }
  }

  function platformNet(li) {
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
      if (!li.included_in_ev) continue;
      const net = platformNet(li);
      if (net == null) continue;
      total += net * li.qty;
    }
    return total;
  }

  function totalSinglesNet() {
    return (report.decks || []).reduce((s, d) => s + computeDeckNet(d), 0);
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

    const singlesCard = caseCost
      ? `<div class="card ${EV.deltaClass(singlesDeltaCase)}">
           <label>Crack singles today — profit (${platLabel})</label>
           <value>${EV.fmtUSD(singlesDeltaCase)} <span style="font-size:0.85rem;font-weight:400">(${pctOf(singlesDeltaCase)})</span></value>
           <div class="card-sub">Net proceeds: ${EV.fmtUSD(singlesNet)}</div>
           ${paidLine}
         </div>`
      : `<div class="card">
           <label>Crack &amp; sell singles — ${platLabel}</label>
           <value>${EV.fmtUSD(singlesNet)}</value>
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
      const exportOn     = forceExclude ? false : forceInclude ? true : listing != null;
      const evIcon  = exportOn ? "✓" : "—";
      const evClass = forceExclude ? "ev-override-off" : forceInclude ? "ev-override-on" : "";

      const st = li.sellthrough;

      // Low listed: lowest TCGPlayer Direct price (vetted sellers, free shipping)
      const lowListedCell = `<td class="right" data-cents="${price.lowest_legit_cents ?? 0}" title="Lowest TCGPlayer Direct listing${price.lowest_legit_cents ? '' : ' — no data'}">${EV.fmtUSD(price.lowest_legit_cents)}</td>`;

      return `<tr class="${li.included_in_ev ? "" : "excluded"}" data-pid="${pid}">
        <td class="ev-toggle ${evClass}" data-pid="${pid}" title="Toggle inclusion" style="cursor:pointer;text-align:center">${evIcon}</td>
        <td class="img-cell center">${stockSrc ? `<img src="${stockSrc}" class="card-thumb" loading="lazy" alt="">` : "—"}</td>
        <td>${escHtml(li.name || li.display_key)}${cardLinks(li)}</td>
        <td class="muted" style="font-size:0.78rem">${escHtml(rarity)}</td>
        <td class="muted" style="font-size:0.78rem">${escHtml(setCode)}</td>
        <td class="muted right" style="font-size:0.78rem">${escHtml(collNum)}</td>
        <td class="right">${qtyPerCopy}</td>
        <td class="right" data-cents="${li.market_price_cents ?? 0}">${EV.fmtUSD(li.market_price_cents)}</td>
        ${lowListedCell}
        <td class="right">${EV.fmtUSD(listing)}</td>
        <td class="right ${net == null ? "muted" : ""}" data-cents="${net ?? 0}">${EV.fmtUSD(net)}</td>
        <td class="right ${caseTotal == null ? "muted" : ""}" data-cents="${caseTotal ?? 0}">${EV.fmtUSD(caseTotal)}</td>
        ${listedCell(price)}
        ${sellthroughVelCell(st, price)}
        ${sellthroughRecCell(st, costPerCard)}
        ${daysDepthCell(st, price)}
      </tr>`;
    }).join("");

    const listingTh = `<th class="right" title="Price you would list at on ${activePlat} given your pricing strategy">List $</th>`;

    return `
      <div class="deck-singles">
        <div class="singles-table-wrap">
          <table class="data cards">
            <thead><tr>
              <th title="Toggle inclusion" style="width:2rem">EV</th>
              <th style="width:3.5rem">Img</th>
              <th data-sort="text">Card</th>
              <th>Rarity</th>
              <th>Set</th>
              <th class="right">#</th>
              <th class="right" data-sort="num" title="Copies per deck">Qty</th>
              <th class="right" data-sort="num">Market</th>
              <th class="right" data-sort="num" title="Lowest TCGPlayer Direct listing (vetted sellers, typically includes free shipping)">Low</th>
              ${listingTh}
              <th class="right" data-sort="num">${platLabel}</th>
              <th class="right" data-sort="num" title="Net × qty × copies in case">Case Total</th>
              <th class="right st-col" data-sort="num" title="Active listings on TCGPlayer">Listed</th>
              <th class="right st-col" data-sort="num" title="Sales per day · ↺ refill rate per day">Vel/d</th>
              <th class="right st-col" title="Recommended listing price · tier relative to market · ROI vs case cost/card">Rec Price</th>
              <th class="right st-col" data-sort="num" title="Expected time to sell at recommended tier. Hover for days at all price tiers (+0% market, +10%, +25%, +50%).">Days@</th>
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
