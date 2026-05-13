// Deck-detail page: one card per deck showing sealed vs. singles scenarios.
// Clicking a scenario tile expands its detail panel (depth or card table).
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

  // Derive base set name from display name for eBay search (strips " Commander Case" etc.)
  const ebaySetName = report.name.replace(/\s+commander.*$/i, "").trim();

  // ── Platform toggle ──
  let activePlat = "tcgplayer";
  const platLabels = {
    "tcgplayer": feeLabel(report.fee_profile),
    "manapool":  "Manapool (8%)",
  };
  document.querySelectorAll(".plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePlat = btn.dataset.plat;
      document.querySelectorAll(".plat-btn").forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  function feeLabel(profile) {
    const map = {
      "tcgplayer-marketplace-l4":  "TCGPlayer (10.75% + 2.5%)",
      "tcgplayer-marketplace-pro": "TCGPlayer Pro (11.75% + 2.5%)",
      "tcgplayer-direct":          "TCGPlayer Direct (8.95% + 2.5%)",
      "tcgplayer-marketplace":     "TCGPlayer Marketplace",
      "ebay":                      "eBay (13.25%)",
    };
    return map[profile] || ("TCGPlayer (" + (profile || "") + ")");
  }

  const $grid = document.querySelector("#decks");

  function singlesNetForPlat(d) {
    return activePlat === "manapool" ? d.manapool_included_net_cents : d.included_net_cents;
  }
  function singlesNetPerCopyForPlat(d) {
    const total = singlesNetForPlat(d);
    return total != null ? total / (d.copies || 1) : null;
  }
  function totalSinglesNetForReport() {
    return (report.decks || []).reduce((sum, d) => sum + (singlesNetForPlat(d) || 0), 0);
  }

  function renderDecks() {
    // ── Case-level totals bar ──
    const singlesNet   = totalSinglesNetForReport();
    const caseCost     = report.case_cost_cents || 0;
    const decksBuyCost = report.sealed_decks_gross_cents || 0; // buy decks individually
    const sealedNet    = report.sealed_decks_net_cents || 0;

    const singlesDeltaCase  = caseCost      ? singlesNet - caseCost      : null;
    const sealedDeltaCase   = caseCost      ? sealedNet  - caseCost      : null;
    const singlesDeltaDecks = decksBuyCost  ? singlesNet - decksBuyCost  : null;

    const bestDelta = sealedNet >= singlesNet ? sealedDeltaCase : singlesDeltaCase;
    const bestLabel = sealedNet >= singlesNet ? "Sell sealed decks" : "Crack &amp; sell singles";

    // Which acquisition route is cheaper for cracking?
    const decksSaveVsCase = caseCost && decksBuyCost ? caseCost - decksBuyCost : null;
    const decksCheaper    = decksSaveVsCase != null && decksSaveVsCase > 0;

    document.querySelector("#totals").innerHTML = `
      <div class="totals-row">
        <div class="card" title="What you pay to buy the sealed case (market price). Buying the case is the default acquisition route.">
          <label>Buy: Case</label>
          <value>${EV.fmtUSD(caseCost || null)}</value>
          ${singlesDeltaCase != null ? `<div class="card-sub ${EV.deltaClass(singlesDeltaCase)}">Singles profit: ${EV.fmtUSD(singlesDeltaCase)} (${EV.fmtPct(caseCost ? singlesDeltaCase/caseCost : null)})</div>` : ""}
          ${sealedDeltaCase  != null ? `<div class="card-sub ${EV.deltaClass(sealedDeltaCase)}">Flip sealed: ${EV.fmtUSD(sealedDeltaCase)} (${EV.fmtPct(caseCost ? sealedDeltaCase/caseCost : null)})</div>` : ""}
        </div>
        <div class="card ${decksCheaper ? "pos" : ""}" title="What you'd pay buying each deck individually on the secondary market. ${decksCheaper ? "Cheaper than the case — better ROI for cracking." : "More expensive than the case."}">
          <label>Buy: Decks individually</label>
          <value>${EV.fmtUSD(decksBuyCost || null)}</value>
          ${decksSaveVsCase != null ? `<div class="card-sub ${EV.deltaClass(decksSaveVsCase)}">${decksCheaper ? "Saves" : "Costs"} ${EV.fmtUSD(Math.abs(decksSaveVsCase))} vs case</div>` : ""}
          ${singlesDeltaDecks != null ? `<div class="card-sub ${EV.deltaClass(singlesDeltaDecks)}">Singles profit: ${EV.fmtUSD(singlesDeltaDecks)} (${EV.fmtPct(decksBuyCost ? singlesDeltaDecks/decksBuyCost : null)})</div>` : ""}
        </div>
      </div>
      <div class="totals-row">
        <div class="card" title="Revenue from selling each deck sealed on the secondary market, after fees.">
          <label>Sell sealed decks (after fees)</label><value>${EV.fmtUSD(sealedNet)}</value>
        </div>
        <div class="card" title="Revenue from cracking every deck and selling individual cards on ${platLabels[activePlat]}, after fees. Excludes cards below the low-value floor.">
          <label>Crack &amp; sell singles (${platLabels[activePlat]})</label><value>${EV.fmtUSD(singlesNet)}</value>
        </div>
        <div class="card ${EV.deltaClass(bestDelta)}" title="Best scenario net revenue minus case cost.">
          <label>Best: ${bestLabel}</label>
          <value>${EV.fmtUSD(bestDelta)} <span style="font-size:0.85rem;opacity:0.7">(${bestDelta != null && caseCost ? EV.fmtPct(bestDelta / caseCost) : "—"})</span></value>
        </div>
      </div>`;

    // ── Deck cards ──
    $grid.innerHTML = (report.decks || []).map((d, i) => buildDeckCard(d, i)).join("");

    // Wire up tile click toggles.
    $grid.querySelectorAll(".scenario-tile").forEach(tile => {
      tile.addEventListener("click", () => {
        const card = tile.closest(".deck-card");
        const targetPanel = tile.dataset.panel;
        const panels = card.querySelectorAll(".deck-detail");
        const tiles  = card.querySelectorAll(".scenario-tile");

        panels.forEach(p => {
          const isTarget = p.dataset.panel === targetPanel;
          const wasOpen  = p.classList.contains("open");
          p.classList.toggle("open", isTarget && !wasOpen);
        });
        tiles.forEach(t => t.classList.toggle("active", t.dataset.panel === targetPanel && !tile.classList.contains("active")));
        tile.classList.toggle("active");
      });
    });

    // Sortable card tables.
    $grid.querySelectorAll("table.cards").forEach(table => {
      table.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => sortTable(table, +th.cellIndex, th.dataset.sort));
      });
    });

    // Export buttons.
    $grid.querySelectorAll(".export-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const d = report.decks[+btn.dataset.deck];
        const [csv, filename] = buildExportCSV(btn.dataset.export, d, report);
        downloadCSV(csv, filename);
      });
    });
  }

  renderDecks();

  // ── Builders ──

  function buildDeckCard(d, idx) {
    const imgHtml = d.image
      ? `<img class="deck-img" src="${d.image}" alt="${escHtml(d.name)}" loading="lazy">`
      : `<div class="deck-img-placeholder">${escHtml(d.name)}</div>`;

    const copies = d.copies || 1;

    // Sealed: per-copy from the report.
    const sealedMkt      = d.sealed_market_cents;
    const sealedNet      = d.sealed_net_cents;
    const sealedNetTotal = sealedNet != null ? sealedNet * copies : null;

    // Singles: use platform-selected total (already ×copies from backend).
    const singlesNetTotal = singlesNetForPlat(d);
    const singlesNetPer   = singlesNetTotal != null ? singlesNetTotal / copies : null;

    // Delta vs sealed (both ×copies).
    const sealedTotal  = sealedNetTotal;
    const delta        = sealedTotal != null && singlesNetTotal != null ? singlesNetTotal - sealedTotal : null;
    const deltaPct     = delta != null && sealedTotal > 0 ? delta / sealedTotal : null;
    const singlesBetter = delta != null && delta > 0;
    const verdictClass  = delta == null ? "win-even" : delta > 0 ? "win-singles" : "win-sealed";
    const verdictText   = delta == null
      ? "No sealed price data"
      : delta > 0
        ? `Singles net ${EV.fmtUSD(delta)} more (${EV.fmtPct(deltaPct)}) than selling sealed`
        : `Sealed nets ${EV.fmtUSD(-delta)} more (${EV.fmtPct(deltaPct != null ? -deltaPct : null)}) than singles`;

    return `
      <div class="deck-card">
        ${imgHtml}
        <div class="deck-header">
          <h2>${escHtml(d.name)}</h2>
          <div class="deck-copies">${copies} cop${copies === 1 ? "y" : "ies"} in case</div>
        </div>
        <div class="scenario-row">
          <div class="scenario-tile" data-panel="sealed-${idx}"
               title="Click to see live listing depth and sell-time estimates for this deck sealed.">
            <div class="tile-label">Sealed deck ↗ click for depth</div>
            <div class="tile-row"><span class="tile-side-label">Buy</span><span class="tile-gross">${EV.fmtUSD(sealedMkt)}<span style="font-size:0.8rem;font-weight:400;color:var(--muted)">/copy</span></span></div>
            <div class="tile-row"><span class="tile-side-label">Sell</span><span class="tile-net-highlight">${EV.fmtUSD(sealedNet)}<span style="font-size:0.8rem;font-weight:400;color:var(--muted)">/copy after fees</span></span></div>
            ${copies > 1 ? `<div class="tile-sub">Total ×${copies}: buy ${EV.fmtUSD(sealedMkt != null ? sealedMkt * copies : null)} → sell ${EV.fmtUSD(sealedNetTotal)}</div>` : ""}
          </div>
          <div class="scenario-tile" data-panel="singles-${idx}"
               title="Click to see every card in this deck, its market price, and your net after fees.">
            <div class="tile-label">Crack for singles ↗ click for cards</div>
            <div class="tile-gross">${EV.fmtUSD(singlesNetPer)} <span style="font-size:0.8rem;font-weight:400;color:var(--muted)">/ copy</span></div>
            <div class="tile-sub">After ${platLabels[activePlat]}</div>
            ${copies > 1 ? `<div class="tile-sub">Total ×${copies}: ${EV.fmtUSD(singlesNetTotal)}</div>` : ""}
          </div>
        </div>
        <div class="deck-verdict ${verdictClass}">
          <span class="verdict-label">${singlesBetter ? "✓ Better to crack" : delta != null ? "✓ Better to sell sealed" : ""}</span>
          <span class="verdict-value">${verdictText}</span>
        </div>
        ${buildSealedPanel(d, idx)}
        ${buildSinglesPanel(d, idx)}
      </div>`;
  }

  function buildSealedPanel(d, idx) {
    let rows = "<p class=\"subtle\">No live depth data available.</p>";
    if (d.sealed_live_depth && Object.keys(d.sealed_live_depth).length > 0) {
      rows = `<div class="depth-rows">` +
        Object.entries(d.sealed_live_depth).map(([platform, rec]) => {
          if (!rec) return "";
          const lowestLabel = `Lowest: ${EV.fmtUSD(rec.lowest_cents)} (${rec.units_at_lowest} @ floor)`;
          if (!rec.achievable) {
            return `<div class="depth-row">
              <span class="platform">${platform}</span>
              <span class="depth-stat">${rec.total_units} listings · ${lowestLabel}</span>
              <span class="depth-days subtle">No velocity data</span>
            </div>`;
          }
          return `<div class="depth-row">
            <span class="platform">${platform}</span>
            <span class="depth-stat">${rec.total_units} listings · ${lowestLabel}</span>
            <span class="depth-price">List at ${EV.fmtUSD(rec.target_cents)}</span>
            <span class="depth-days">~${Math.round(rec.expected_days)} days to sell</span>
          </div>`;
        }).join("") +
        `</div>`;
    }
    return `<div class="deck-detail" data-panel="sealed-${idx}">
      <div class="subtle" style="margin-bottom:0.25rem">Live listing depth — sealed deck</div>
      ${rows}
    </div>`;
  }

  function cardLinks(li) {
    const name = li.name || li.display_key;
    const encodedName = encodeURIComponent(name);
    const ebayKeywords = encodeURIComponent(name + " Commander " + ebaySetName + " ").replace(/%20/g, "+");
    const now = Date.now();
    const start = now - 30 * 24 * 60 * 60 * 1000;
    const ebayURL = `https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=${ebayKeywords}&dayRange=30&endDate=${now}&startDate=${start}&categoryId=0&offset=0&limit=50&tabName=SOLD&tz=America%2FNew_York`;
    const tcgURL  = li.tcgplayer_product_id ? `https://www.tcgplayer.com/product/${li.tcgplayer_product_id}` : null;
    const mpURL   = `https://manapool.com/search?q=${encodedName}`;
    return `<span class="card-links">`
      + (tcgURL ? `<a class="card-link card-link-tcg" href="${tcgURL}" target="_blank" rel="noopener" title="TCGPlayer listing">T</a>` : "")
      + `<a class="card-link card-link-mp" href="${mpURL}" target="_blank" rel="noopener" title="Manapool search">M</a>`
      + `<a class="card-link card-link-ebay" href="${ebayURL}" target="_blank" rel="noopener" title="eBay sold research">e</a>`
      + `</span>`;
  }

  function buildSinglesPanel(d, idx) {
    const lines = (d.line_items || []).slice().sort((a, b) => (b.market_price_cents || 0) - (a.market_price_cents || 0));
    const rows = lines.map(li => {
      const reason = li.exclude_reason || "";
      return `<tr class="${li.included_in_ev ? "" : "excluded"}">
        <td>${li.included_in_ev ? "✓" : "—"}</td>
        <td>${escHtml(li.name || li.display_key)}${cardLinks(li)}${reason ? `<div class="subtle">${escHtml(reason)}</div>` : ""}</td>
        <td class="right">${li.qty / (d.copies || 1)}</td>
        <td class="right" data-cents="${li.market_price_cents || 0}">${EV.fmtUSD(li.market_price_cents)}</td>
        <td class="right" data-cents="${li.tcgplayer_net_cents || 0}">${EV.fmtUSD(li.tcgplayer_net_cents)}</td>
        <td class="right" data-cents="${li.manapool_net_cents || 0}">${EV.fmtUSD(li.manapool_net_cents)}</td>
        <td class="right" data-cents="${li.ebay_net_cents || 0}">${EV.fmtUSD(li.ebay_net_cents)}</td>
        <td class="right" data-cents="${li.net_total_cents || 0}">${EV.fmtUSD(li.net_total_cents)}</td>
      </tr>`;
    }).join("");

    const copies = d.copies || 1;
    return `<div class="deck-detail" data-panel="singles-${idx}">
      <div class="export-bar">
        <span class="export-label">Export singles:</span>
        <button class="export-btn" data-export="tcgplayer" data-deck="${idx}">TCGPlayer CSV</button>
        <button class="export-btn" data-export="manapool" data-deck="${idx}">Manapool CSV</button>
        <button class="export-btn" data-export="ebay" data-deck="${idx}">eBay CSV</button>
      </div>
      <div class="singles-table-wrap">
        <table class="data cards">
          <thead><tr>
            <th title="Included in EV total. Cards below $0.25 are excluded (not worth shipping individually).">EV</th>
            <th data-sort="text">Card</th>
            <th class="right" data-sort="num" title="Copies of this card in one deck.">Qty</th>
            <th class="right" data-sort="num" title="TCGPlayer market price — midpoint of recent sales. Used as the EV basis.">TCG Market</th>
            <th class="right" data-sort="num" title="What you net per copy after TCGPlayer Direct fees (8.95% + 2.5% payment, no per-sale flat).">TCG Net</th>
            <th class="right" data-sort="num" title="What you net per copy after Manapool fees (8% flat). Manapool per-card prices use TCGPlayer market as a proxy — actual Manapool prices may differ.">Manapool Net</th>
            <th class="right" data-sort="num" title="What you net per copy on eBay after 13.25% fees and shipping (ESE $0.89 for &lt;$20, bubble mailer $3.75 for $20+). Assumes listing at market with free shipping.">eBay Net</th>
            <th class="right" data-sort="num" title="TCGPlayer net × qty × copies in case. This is what rolls up into the singles total.">Total (case)</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── CSV export ──

  // TCGPlayer CDN — stock card images, no auth required.
  // TODO: replace with GCS scan URLs once the upload flow is built.
  const TCG_IMG_BASE = "https://product-images.tcgplayer.com/fit-in/400x550";

  // ── Per-platform listing price functions ──

  // TCGPlayer: floor $0.40, skip below. < $5: market + 10%. ≥ $5: market as-is.
  // Any computed price landing in [$4.60, $5.25] is set to $4.99 so buyers
  // must add bulk to hit the $5 free-shipping threshold.
  function tcgplayerListingPrice(marketCents) {
    if (marketCents == null || marketCents < 40) return null;
    const tentative = marketCents < 500
      ? Math.round(marketCents * 1.10)
      : marketCents;
    if (tentative >= 460 && tentative <= 525) return 499;
    return tentative;
  }

  // Manapool: market price as-is, no adjustments.
  function manapoolListingPrice(marketCents) {
    return marketCents ?? null;
  }

  // eBay: < $0.25 skip. $0.25–$4.99: market + $1.25. ≥ $5: market as-is.

  function buildExportCSV(type, d, rep) {
    const slug = (d.deck_key || rep.display_key || "deck").replace(/[^a-z0-9-]/gi, "-");
    switch (type) {
      case "tcgplayer": return buildTCGPlayerCSV(d, slug);
      case "manapool":  return buildManapoolCSV(d, slug);
      case "ebay":      return buildEbayCSV(d, slug);
      default: return ["", "export.csv"];
    }
  }

  // TCGPlayer bulk price-upload CSV.
  // Format: TCGplayer Id, Quantity, Condition, Price
  // Pricing: floor $0.40, <$5 market+10% (gap avoidance at $4.60–$4.99), ≥$5 market.
  function buildTCGPlayerCSV(d, slug) {
    const copies = d.copies || 1;
    const rows = [["TCGplayer Id", "Quantity", "Condition", "Price"]];
    for (const li of d.line_items || []) {
      if (!li.tcgplayer_product_id) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;
      const priceCents = tcgplayerListingPrice(li.market_price_cents);
      if (priceCents == null) continue;
      const condition = li.finish === "f" ? "Near Mint Foil" : "Near Mint";
      rows.push([li.tcgplayer_product_id, qty, condition, (priceCents / 100).toFixed(2)]);
    }
    return [csvSerialize(rows), `tcgplayer-${slug}.csv`];
  }

  // Manapool bulk sell CSV.
  // Format: Name, Edition, Quantity, Foil, Condition, Price (USD)
  // Pricing: market price as-is.
  function buildManapoolCSV(d, slug) {
    const copies = d.copies || 1;
    const rows = [["Name", "Edition", "Quantity", "Foil", "Condition", "Price (USD)"]];
    for (const li of d.line_items || []) {
      const name = li.name || li.display_key;
      if (!name) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;
      const priceCents = manapoolListingPrice(li.market_price_cents);
      if (priceCents == null) continue;
      const foil = li.finish === "f" ? "Yes" : "No";
      const edition = d.deck_key ? d.deck_key.split("-")[0].toUpperCase() : "";
      rows.push([name, edition, qty, foil, "Near Mint", (priceCents / 100).toFixed(2)]);
    }
    return [csvSerialize(rows), `manapool-${slug}.csv`];
  }

  // eBay: < $0.25 skip. $0.25–$4.99: market + $1.25 (covers ESE cost). ≥ $5: market as-is.
  function ebayListingPrice(marketCents) {
    if (marketCents == null) return null;
    const SKIP      =  25;   // $0.25 — don't list below this
    const THRESHOLD = 500;   // $5.00 — above this, use market as-is
    const SHIP_ADD  = 125;   // $1.25 — covers eBay Standard Envelope
    if (marketCents < SKIP)      return null;
    if (marketCents < THRESHOLD) return marketCents + SHIP_ADD;
    return marketCents;
  }

  // eBay File Exchange format (category 183454 — MTG Individual Cards).
  //
  // Structure:
  //   Row 1: Info row (template metadata, not a data row)
  //   Row 2: Column headers (exact eBay field names, starred = required)
  //   Row 3+: Listing data rows
  //
  // Business policies must be created in Seller Hub → Account → Business Policies
  // before uploading. The three names below must match exactly.
  //
  // UPLOAD: use Seller Hub → Listings → Create Listing → Bulk for a preview
  // step. File Exchange (Action=Add) publishes immediately without review.
  function buildEbayCSV(d, slug) {
    const copies = d.copies || 1;
    const setName = report.name.replace(/\s+(commander|collector|bonus|scene).*$/i, "").trim();

    const headers = [
      "*Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)",
      "CustomLabel",                      // TCGPlayer product ID — our internal SKU
      "*Category",                        // 183454 = MTG Individual Cards
      "*Title",                           // max 80 chars
      "*ConditionID",                     // 2750 = only valid condition for cat 183454
      "CD:Card Condition - (ID: 40001)",  // Near Mint or Better
      "CD:Professional Grader - (ID: 27501)", // Not Applicable (ungraded)
      "CD:Grade - (ID: 27502)",           // Not Applicable (ungraded)
      "*C:Game",                          // required item specific
      "C:Card Name",
      "C:Set",
      "C:Finish",
      "C:Language",
      "C:Graded",
      "C:Card Condition",
      "PicURL",
      "*Description",
      "*Format",              // FixedPrice
      "*Duration",            // GTC
      "*StartPrice",
      "*Quantity",
      "ImmediatePayRequired",
      "*Location",            // zip code
      "*DispatchTimeMax",     // business days to ship
      "*ReturnsAcceptedOption",
      "ReturnsWithinOption",
      "RefundOption",
      "ShippingCostPaidByOption",
      "ShippingProfileName",
      "ReturnProfileName",
      "PaymentProfileName",
    ];
    const rows = [headers];

    for (const li of d.line_items || []) {
      const name = li.name || li.display_key;
      if (!name) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;

      const priceCents = ebayListingPrice(li.market_price_cents);
      if (priceCents == null) continue;

      const foilTag = li.finish === "f" ? " Foil" : "";
      const finish  = li.finish === "f" ? "Foil" : "Non-Foil";
      const rawTitle = `${name} ${setName} NM${foilTag} MTG Magic`;
      const title = rawTitle.length > 80 ? rawTitle.slice(0, 79) + "…" : rawTitle;
      const photoURL = li.tcgplayer_product_id ? `${TCG_IMG_BASE}/${li.tcgplayer_product_id}.jpg` : "";
      const price = (priceCents / 100).toFixed(2);
      const desc = `${name} | ${setName} | Near Mint${foilTag} | MTG Magic: The Gathering`;

      rows.push([
        "Add",
        li.tcgplayer_product_id || "",
        183454,
        title,
        2750,                     // only valid raw/graded condition for cat 183454
        "Near Mint or Better",    // CD:Card Condition
        "Not Applicable",         // CD:Professional Grader — raw card
        "Not Applicable",         // CD:Grade — raw card
        "Magic: The Gathering",
        name,
        setName,
        finish,
        "English",
        "No",
        "Near Mint or Better",
        photoURL,
        desc,
        "FixedPrice",
        "GTC",
        price,
        qty,
        1,
        48071,
        2,
        "ReturnsAccepted",
        "Days_30",
        "MoneyBack",
        "Buyer",
        "FG Cards - Free Shipping",
        "30 Day Returns",
        "Immediate Payment",
      ]);
    }

    const infoRow = "Info,Version=1.0.0,Template=fx_category_template_EBAY_US";
    return [infoRow + "\r\n" + csvSerialize(rows), `ebay-${slug}.csv`];
  }

  // Serialize a 2-D array to RFC 4180 CSV.
  function csvSerialize(rows) {
    return rows.map(cols =>
      cols.map(v => {
        const s = String(v == null ? "" : v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ).join("\r\n");
  }

  function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      return av < bv ? -1 * dir : av > bv ? dir : 0;
    });
    rows.forEach(r => tbody.appendChild(r));
  }
})();
