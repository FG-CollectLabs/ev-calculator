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
  document.querySelectorAll("#platform-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePlat = btn.dataset.plat;
      document.querySelectorAll("#platform-toggle .plat-btn").forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  let ebayMode = "freeship";
  document.querySelectorAll("#ebay-mode-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ebayMode = btn.dataset.mode;
      document.querySelectorAll("#ebay-mode-toggle .plat-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });

  // Rarity skip set — active buttons = rarities to EXCLUDE from export.
  const skipRarities = new Set();
  document.querySelectorAll(".rarity-skip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      if (btn.classList.contains("active")) skipRarities.add(btn.dataset.rarity);
      else skipRarities.delete(btn.dataset.rarity);
    });
  });

  // CSV sort order.
  let csvSort = "name";
  document.querySelectorAll("#sort-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      csvSort = btn.dataset.sort;
      document.querySelectorAll("#sort-toggle .plat-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });

  // ── Scan panel ──
  // Maps tcgplayer_product_id → { front: url, back: url }
  const scanImageMap = new Map();

  const scanModal    = document.getElementById("scan-modal");
  const scanDropzone = document.getElementById("scan-dropzone");
  const scanInput    = document.getElementById("scan-input");
  const scanProgress = document.getElementById("scan-progress");
  const scanBar      = document.getElementById("scan-bar");
  const scanStatus   = document.getElementById("scan-status");
  const scanResults  = document.getElementById("scan-results");
  const scanFooter   = document.getElementById("scan-footer");
  const scanSummary  = document.getElementById("scan-summary");

  const openScanModal  = () => scanModal.classList.remove("hidden");
  const closeScanModal = () => scanModal.classList.add("hidden");

  document.getElementById("btn-upload-scans").addEventListener("click", openScanModal);
  document.getElementById("scan-close").addEventListener("click", closeScanModal);
  document.getElementById("scan-done").addEventListener("click", closeScanModal);
  scanModal.addEventListener("click", e => { if (e.target === scanModal) closeScanModal(); });
  scanDropzone.addEventListener("click", () => scanInput.click());

  let confirmedHidden = false;
  document.getElementById("scan-toggle-confirmed").addEventListener("click", function () {
    confirmedHidden = !confirmedHidden;
    this.textContent = confirmedHidden ? "Show All" : "Hide Confirmed";
    this.classList.toggle("active", confirmedHidden);
    scanResults.querySelectorAll(".scan-card.matched").forEach(el => {
      el.style.display = confirmedHidden ? "none" : "";
    });
  });
  document.getElementById("scan-browse").addEventListener("click", () => scanInput.click());
  scanInput.addEventListener("change", () => processScans([...scanInput.files]));

  scanDropzone.addEventListener("dragover", e => { e.preventDefault(); scanDropzone.classList.add("drag-over"); });
  scanDropzone.addEventListener("dragleave", () => scanDropzone.classList.remove("drag-over"));
  scanDropzone.addEventListener("drop", e => {
    e.preventDefault();
    scanDropzone.classList.remove("drag-over");
    processScans([...e.dataTransfer.files]);
  });

  // Derive TCGPlayer set name for restrict_set OCR lookup.
  // "Bloomburrow Commander Case" → "Commander: Bloomburrow"
  // "Final Fantasy Commander Display" → "Commander: Final Fantasy"
  function deriveRestrictSet(name) {
    const m = name.match(/^(.+?)\s+Commander(?:\s+(?:Case|Display|Box|Set))?$/i);
    return m ? `Commander: ${m[1].trim()}` : "";
  }
  const scanRestrictSet = deriveRestrictSet(report.name);

  // Flat map of all cards in the display: product_id → {name, finish}
  const displayCardMap = new Map();
  for (const d of report.decks || []) {
    for (const li of d.line_items || []) {
      if (li.tcgplayer_product_id) {
        displayCardMap.set(String(li.tcgplayer_product_id), {
          name:   li.name || li.display_key,
          finish: li.finish === "f" ? "Foil" : "Non-Foil",
          id:     String(li.tcgplayer_product_id),
        });
      }
    }
  }

  // ── Card picker overlay ──
  const picker = document.createElement("div");
  picker.className = "card-picker hidden";
  picker.innerHTML = `
    <div class="card-picker-box">
      <div class="card-picker-header">
        <span>Select card</span>
        <button class="scan-close" id="picker-close">✕</button>
      </div>
      <div class="card-picker-body">
        <div class="card-picker-preview">
          <img id="picker-front" alt="front scan">
        </div>
        <div class="card-picker-search-col">
          <input class="card-picker-input" id="picker-input" placeholder="Search card name…" autocomplete="off">
          <div class="card-picker-list" id="picker-list"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(picker);

  let pickerCallback = null;
  document.getElementById("picker-close").addEventListener("click", () => picker.classList.add("hidden"));
  picker.addEventListener("click", e => { if (e.target === picker) picker.classList.add("hidden"); });

  const pickerInput = document.getElementById("picker-input");
  const pickerList  = document.getElementById("picker-list");

  function renderPickerList(query) {
    const q = query.toLowerCase();
    const cards = [...displayCardMap.values()]
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    pickerList.innerHTML = cards.map(c =>
      `<div class="picker-item" data-id="${c.id}">${c.name} <span class="picker-finish">${c.finish}</span></div>`
    ).join("");
    pickerList.querySelectorAll(".picker-item").forEach(el => {
      el.addEventListener("click", () => {
        picker.classList.add("hidden");
        pickerCallback?.(el.dataset.id);
      });
    });
  }

  pickerInput.addEventListener("input", () => renderPickerList(pickerInput.value));

  function openCardPicker(cardEl, frontURL, backURL) {
    document.getElementById("picker-front").src = frontURL || "";
    pickerInput.value = "";
    renderPickerList("");
    picker.classList.remove("hidden");
    pickerInput.focus();
    pickerCallback = (productId) => {
      const info = displayCardMap.get(productId);
      scanImageMap.set(productId, { front: frontURL, back: backURL });
      cardEl.className = "scan-card matched";
      cardEl.querySelector(".scan-card-name").textContent = info?.name || `ID ${productId}`;
      cardEl.querySelector(".scan-card-meta").textContent = "manual match";
      const btn = cardEl.querySelector(".scan-pick-btn");
      if (btn) btn.remove();
    };
  }

  async function processScans(files) {
    if (!files.length) return;
    // Sort by name to preserve scanner order.
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const pairs = [];
    for (let i = 0; i < files.length; i += 2) {
      pairs.push({ front: files[i], back: files[i + 1] || null });
    }

    scanProgress.classList.remove("hidden");
    scanResults.innerHTML = "";
    scanBar.style.width = "0%";

    for (let i = 0; i < pairs.length; i++) {
      const { front, back } = pairs[i];
      scanStatus.textContent = `Processing ${i + 1} of ${pairs.length}…`;
      scanBar.style.width = `${Math.round(((i) / pairs.length) * 100)}%`;

      try {
        // Send front image — pass restrict_set so OCR collector-number lookup
        // is used as a tiebreaker over pHash for medium-confidence matches.
        const fd = new FormData();
        fd.append("image", front);
        if (scanRestrictSet) fd.append("restrict_set", scanRestrictSet);
        const r1 = await fetch(EV.api("/v1/scan/identify"), { method: "POST", body: fd });
        if (!r1.ok) throw new Error("identify failed");
        const d1 = await r1.json();

        const scanId     = d1.scan_id;
        const frontURL   = d1.front_image || "";
        const productId  = d1.candidates?.[0]?.tcgplayer_product_id;
        const confidence = d1.confidence || "none";

        let backURL = "";
        if (back && scanId) {
          const fd2 = new FormData();
          fd2.append("scan_id", scanId);
          fd2.append("image", back);
          const r2 = await fetch(EV.api("/v1/scan/back"), { method: "POST", body: fd2 });
          if (r2.ok) { const d2 = await r2.json(); backURL = d2.back_image || ""; }
        }

        const cardName   = productId
          ? (displayCardMap.get(String(productId))?.name || `ID ${productId}`)
          : null;
        const needsReview = d1.needs_review;
        const ocrName     = d1.ocr_name || "";
        const nameOK      = d1.name_confirmed;

        if (productId) scanImageMap.set(String(productId), { front: frontURL, back: backURL });

        const statusClass = !productId ? "unmatched"
          : needsReview ? "needs-review"
          : "matched";
        const reviewBadge = needsReview
          ? `<div class="scan-card-warn">⚠️ OCR: "${ocrName}" — verify card</div>` : "";

        const card = document.createElement("div");
        card.className = `scan-card ${statusClass}`;
        card.dataset.frontUrl = frontURL;
        card.dataset.backUrl  = backURL;
        card.innerHTML = `
          <div class="scan-card-imgs">
            ${frontURL ? `<img src="${frontURL}" alt="front">` : "<div style='width:50%'></div>"}
            ${backURL  ? `<img src="${backURL}"  alt="back">`  : ""}
          </div>
          <div class="scan-card-name">${cardName || "Unmatched"}</div>
          <div class="scan-card-meta">${confidence}${nameOK ? " ✓" : ""} · ${front.name}</div>
          ${reviewBadge}
          ${(!productId || needsReview) ? `<button class="scan-pick-btn" style="margin-top:0.3rem;width:100%">Select Card</button>` : ""}`;
        if (!productId || needsReview) {
          card.querySelector(".scan-pick-btn").addEventListener("click", () => openCardPicker(card, frontURL, backURL));
        }
        if (confirmedHidden && card.classList.contains("matched")) card.style.display = "none";
        scanResults.appendChild(card);
      } catch (e) {
        const card = document.createElement("div");
        card.className = "scan-card unmatched";
        card.innerHTML = `<div class="scan-card-name">Error</div><div class="scan-card-meta">${front.name}: ${e.message}</div>`;
        scanResults.appendChild(card);
      }
    }

    scanBar.style.width = "100%";
    scanStatus.textContent = `Done — ${scanImageMap.size} of ${pairs.length} cards matched.`;
    scanSummary.textContent = `${scanImageMap.size} cards linked — download CSV to use scan images.`;
    scanFooter.classList.remove("hidden");
    // Update photo indicator cells in the singles tables.
    document.querySelectorAll("tr[data-pid]").forEach(row => {
      const pid = row.dataset.pid;
      if (!pid) return;
      const cell = row.querySelector("td[title='Scan linked'], td[title='No scan']");
      if (!cell) return;
      const has = scanImageMap.get(pid)?.front || scanImageMap.get(pid)?.back;
      cell.title = has ? "Scan linked" : "No scan";
      cell.textContent = has ? "📷" : "—";
    });
  }

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

    async function runEbayExport(decks, slugOverride) {
      await scryfallReady;
      const files = buildEbayCSVMulti(decks, slugOverride, ebayMode);
      files.forEach(([csv, filename]) => downloadCSV(csv, filename));
    }

    // Per-deck export buttons.
    $grid.querySelectorAll(".export-btn").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const d = report.decks[+btn.dataset.deck];
        if (btn.dataset.export === "ebay") {
          btn.disabled = true;
          btn.textContent = "Loading…";
          await runEbayExport([d], null);
          btn.disabled = false;
          btn.textContent = "eBay CSV";
        } else {
          const [csv, filename] = buildExportCSV(btn.dataset.export, d, report, ebayMode);
          downloadCSV(csv, filename);
        }
      });
    });

    // Whole-set export — produces up to 3 files: freeship, bulk, remove.
    document.getElementById("download-all-csv").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      this.textContent = "Building…";
      try {
        await scryfallReady;
        const slug  = (report.display_key || "set").replace(/[^a-z0-9-]/gi, "-");
        const files = buildEbayCSVMulti(report.decks, slug, ebayMode);
        for (const [csv, filename] of files) downloadCSV(csv, filename);
      } finally {
        this.disabled = false;
        this.textContent = "Download CSV";
      }
    });

    document.getElementById("download-reprice-csv").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      this.textContent = "Building…";
      try {
        await scryfallReady;
        const slug = (report.display_key || "set").replace(/[^a-z0-9-]/gi, "-");
        const rows = [["Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", "Custom label (SKU)", "StartPrice", "Quantity"]];
        for (const d of report.decks) {
          const copies = d.copies || 1;
          const setCode = (report.set_code || "").toUpperCase();
          for (const li of d.line_items || []) {
            const name = li.name || li.display_key;
            if (!name) continue;
            const qty = Math.round(li.qty / copies);
            if (qty <= 0) continue;
            const sf = scryfallCache.get(name) || {};
            const rarity = scryfallRarity(sf.rarity);
            if (skipRarities.has(rarity)) continue;
            const priceCents = ebayListingPrice(li.market_price_cents, ebayMode);
            if (priceCents == null) continue;
            const cardNumber = sf.collector_number || "";
            const numPadded  = cardNumber ? cardNumber.padStart(4, "0") : "";
            const finishCode = li.finish === "f" ? "F" : "N";
            const sku = setCode && numPadded ? `M-${setCode}-${numPadded}-${finishCode}` : "";
            if (!sku) continue;
            rows.push(["Revise", sku, (priceCents / 100).toFixed(2), qty]);
          }
        }
        if (rows.length > 1) downloadCSV(csvSerialize(rows), `ebay-${slug}-reprice.csv`);
      } finally {
        this.disabled = false;
        this.textContent = "Download Reprice CSV";
      }
    });
  }

  renderDecks();

  // Load static metadata JSON then fall back to live Scryfall for any unknowns.
  const scryfallReady = (async () => {
    await loadScryfallMeta();
    const allNames = (report.decks || [])
      .flatMap(d => (d.line_items || []).map(li => li.name || li.display_key))
      .filter(Boolean);
    await fetchScryfallMeta(allNames); // no-op if all names already cached
  })();

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
    const copies = d.copies || 1;
    const lines  = (d.line_items || []).slice().sort((a, b) => (b.market_price_cents || 0) - (a.market_price_cents || 0));

    // Cost allocation — distribute caseCostCents() across included cards by market value.
    const caseCost = caseCostCents();
    const totalMarket = lines.reduce((s, li) => s + (li.included_in_ev ? (li.market_price_cents || 0) * (li.qty / copies) : 0), 0);
    function allocatedCostCents(li) {
      if (!caseCost || !totalMarket || !li.included_in_ev) return null;
      return Math.round((li.market_price_cents || 0) / (totalMarket / (li.qty / copies)) * caseCost / (li.qty / copies));
    }

    const rows = lines.map(li => {
      const reason   = li.exclude_reason || "";
      const pid      = String(li.tcgplayer_product_id || "");
      const hasPhoto = pid && (scanImageMap.get(pid)?.front || scanImageMap.get(pid)?.back);
      const photoCell = pid ? `<td class="center" title="${hasPhoto ? "Scan linked" : "No scan"}">${hasPhoto ? "📷" : "—"}</td>` : "<td></td>";
      const cost     = allocatedCostCents(li);
      const costCell = cost != null ? `<td class="right" data-cents="${cost}">${EV.fmtUSD(cost)}</td>` : `<td class="right muted">—</td>`;
      const profitCents = cost != null ? (li.ebay_net_cents || 0) - cost : null;
      const profitCell  = profitCents != null
        ? `<td class="right ${profitCents >= 0 ? "pos" : "neg"}" data-cents="${profitCents}">${EV.fmtUSD(profitCents)}</td>`
        : `<td class="right muted">—</td>`;
      return `<tr class="${li.included_in_ev ? "" : "excluded"}" data-pid="${pid}">
        <td>${li.included_in_ev ? "✓" : "—"}</td>
        ${photoCell}
        <td>${escHtml(li.name || li.display_key)}${cardLinks(li)}${reason ? `<div class="subtle">${escHtml(reason)}</div>` : ""}</td>
        <td class="right">${li.qty / copies}</td>
        <td class="right" data-cents="${li.market_price_cents || 0}">${EV.fmtUSD(li.market_price_cents)}</td>
        <td class="right" data-cents="${li.tcgplayer_net_cents || 0}">${EV.fmtUSD(li.tcgplayer_net_cents)}</td>
        <td class="right" data-cents="${li.manapool_net_cents || 0}">${EV.fmtUSD(li.manapool_net_cents)}</td>
        <td class="right" data-cents="${li.ebay_net_cents || 0}">${EV.fmtUSD(li.ebay_net_cents)}</td>
        <td class="right" data-cents="${li.net_total_cents || 0}">${EV.fmtUSD(li.net_total_cents)}</td>
        ${costCell}${profitCell}
      </tr>`;
    }).join("");

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
            <th title="Included in EV total. Cards below the sift threshold are excluded.">EV</th>
            <th title="Scan image linked">📷</th>
            <th data-sort="text">Card</th>
            <th class="right" data-sort="num" title="Copies of this card in one deck.">Qty</th>
            <th class="right" data-sort="num" title="TCGPlayer market price — midpoint of recent sales. Used as the EV basis.">TCG Market</th>
            <th class="right" data-sort="num" title="What you net per copy after TCGPlayer Direct fees (8.95% + 2.5% payment, no per-sale flat).">TCG Net</th>
            <th class="right" data-sort="num" title="What you net per copy after Manapool fees (8% flat). Manapool per-card prices use TCGPlayer market as a proxy — actual Manapool prices may differ.">Manapool Net</th>
            <th class="right" data-sort="num" title="What you net per copy on eBay after 13.25% fees and shipping (ESE $0.89 for &lt;$20, bubble mailer $3.75 for $20+). Assumes listing at market with free shipping.">eBay Net</th>
            <th class="right" data-sort="num" title="TCGPlayer net × qty × copies in case. This is what rolls up into the singles total.">Total (case)</th>
            <th class="right" data-sort="num" title="Your allocated cost per card based on case purchase price, weighted by market value.">My Cost</th>
            <th class="right" data-sort="num" title="eBay net minus your allocated cost per card.">eBay Profit</th>
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

  function buildExportCSV(type, d, rep, ebayMode) {
    const slug = (d.deck_key || rep.display_key || "deck").replace(/[^a-z0-9-]/gi, "-");
    switch (type) {
      case "tcgplayer": return buildTCGPlayerCSV(d, slug);
      case "manapool":  return buildManapoolCSV(d, slug);
      case "ebay":      return buildEbayCSV(d, slug, ebayMode);
      default: return ["", "export.csv"];
    }
  }

  // Static card metadata — loaded from pre-built JSON (run scripts/fetch-scryfall-meta.js
  // to regenerate when new sets are added). Falls back to live Scryfall for unknowns.
  const scryfallCache = new Map();

  async function loadScryfallMeta() {
    try {
      const res = await fetch(EV.api("").replace(/\/$/, "") === ""
        ? "/data/scryfall-meta.json"
        : "/data/scryfall-meta.json");
      const data = await res.json();
      for (const [name, meta] of Object.entries(data)) scryfallCache.set(name, meta);
    } catch (_) { /* fall through to live fetch */ }
  }

  async function fetchScryfallMeta(names) {
    const uncached = [...new Set(names)].filter(n => !scryfallCache.has(n));
    if (!uncached.length) return;
    for (let i = 0; i < uncached.length; i += 75) {
      const batch = uncached.slice(i, i + 75);
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: batch.map(name => ({ name })) }),
        });
        const data = await res.json();
        (data.data || []).forEach(card => scryfallCache.set(card.name, card));
      } catch (_) { /* leave uncached on network error */ }
    }
  }

  function scryfallCardType(typeLine) {
    if (!typeLine) return "";
    const base = typeLine.split("—")[0].trim();
    const types = ["Land", "Creature", "Planeswalker", "Artifact", "Enchantment", "Instant", "Sorcery", "Battle"];
    return types.find(t => base.includes(t)) || base.split(" ").pop();
  }

  function scryfallRarity(rarity) {
    const map = { common: "Common", uncommon: "Uncommon", rare: "Rare", mythic: "Mythic Rare", special: "Special/Bonus Card" };
    return map[rarity] || "";
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

  // eBay tiered pricing:
  //   < $0.25  → skip (not worth listing)
  //   < $1.00  → market + $1.30 baked in, free shipping (clears $0.99 floor)
  //   $1–$5    → market as-is, bulk shipping (buyer pays $1.30 + $0.10/additional)
  //   > $5     → market as-is, free shipping (absorb envelope cost, buyers expect it)
  //
  // Free ship mode overrides: always bake in $1.30 and use free shipping policy.
  const ENVELOPE = 130; // $1.30 — eBay Standard Envelope cost

  // Sift threshold — cards below this are skipped from eBay listing.
  // Driven by the #sift-threshold input; defaults to $0.25.
  function siftThresholdCents() {
    const v = parseFloat(document.getElementById("sift-threshold")?.value || "0.25");
    return Math.round((isNaN(v) ? 0.25 : v) * 100);
  }

  // Case cost in cents — user-entered purchase price for the whole case.
  function caseCostCents() {
    const v = parseFloat(document.getElementById("case-cost")?.value || "0");
    return Math.round((isNaN(v) ? 0 : v) * 100);
  }

  function ebayListingPrice(marketCents, mode) {
    if (marketCents == null || marketCents < siftThresholdCents()) return null;
    if (mode === "freeship") {
      return marketCents < 500 ? marketCents + ENVELOPE : marketCents;
    }
    // bulk mode: tiered
    if (marketCents < 100) return marketCents + ENVELOPE; // bake in for sub-$1
    return marketCents;                                    // $1+ at market
  }

  function ebayShippingPolicy(marketCents, mode) {
    if (mode === "freeship") return "FG Cards: Free Shipping";
    // bulk mode: mid-tier uses bulk shipping, low and high use free shipping
    if (marketCents >= 100 && marketCents < 500) return "FG Cards: Bulk Shipping";
    return "FG Cards: Free Shipping";
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
  // Build eBay CSVs for one or more decks, returning up to two files:
  // one for free-shipping cards, one for bulk-shipping cards.
  // slugOverride: used for whole-set exports; otherwise derived per-deck.
  function buildEbayCSVMulti(decks, slugOverride, mode) {
    const freeRows   = [];
    const bulkRows   = [];
    const removeRows = [];
    for (const d of decks) buildEbayRows(d, mode, freeRows, bulkRows, removeRows);

    const slug     = slugOverride || (decks[0]?.deck_key || "deck").replace(/[^a-z0-9-]/gi, "-");
    const infoLines = ebayInfoLines();
    const headers   = ebayHeaders();
    const files = [];
    if (freeRows.length)
      files.push([infoLines + "\r\n" + csvSerialize([headers, ...freeRows]), `ebay-${slug}-freeship.csv`]);
    if (bulkRows.length)
      files.push([infoLines + "\r\n" + csvSerialize([headers, ...bulkRows]), `ebay-${slug}-bulk.csv`]);
    if (removeRows.length) {
      const removeHeaders = ["Card Name", "Set", "Rarity", "Collector #", "Qty", "Market Price", "Reason"];
      const removeData = removeRows
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(r => [r.name, r.setName, r.rarity, r.sf?.collector_number || "", r.qty, `$${(r.market/100).toFixed(2)}`, r.reason]);
      files.push([csvSerialize([removeHeaders, ...removeData]), `${slug}-remove.csv`]);
    }
    return files;
  }

  function ebayInfoLines() {
    return [
      "#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,",
      "#INFO Action and Category ID are required fields. 1) Set Action to Draft 2) Please find the category ID for your listings here: https://pages.ebay.com/sellerinformation/news/categorychanges.html,,,,,,,,,,",
      "\"#INFO After you've successfully uploaded your draft from the Seller Hub Reports tab, complete your drafts to active listings here: https://www.ebay.com/sh/lst/drafts\",,,,,,,,,,",
      "#INFO,,,,,,,,,,",
    ].join("\r\n");
  }

  function ebayHeaders() {
    return [
      "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)",
      "Custom label (SKU)", "Category ID", "Title", "UPC", "Price", "Quantity",
      "Item photo URL", "Condition ID", "Description", "Format",
      "ShippingProfileName", "ReturnProfileName", "PaymentProfileName", "Location",
      "C:Game", "C:Card Name", "C:Set", "C:Finish", "C:Language", "C:Graded",
      "C:Card Condition", "C:Card Type", "C:Rarity", "C:Character", "C:Color",
      "C:Card Number", "C:Year Manufactured", "C:Card Size", "C:Age Level", "C:Manufacturer",
    ];
  }

  // Builds data rows for one deck, pushing into freeRows or bulkRows by shipping policy.
  const rarityOrder = { "Mythic Rare": 0, "Rare": 1, "Uncommon": 2, "Common": 3 };

  function buildEbayRows(d, mode, freeRows, bulkRows, removeRows) {
    const copies  = d.copies || 1;
    const setName = report.name.replace(/\s+(commander|collector|bonus|scene).*$/i, "").trim();

    // Collect eligible + removed items separately.
    const eligible = [];
    for (const li of d.line_items || []) {
      const name = li.name || li.display_key;
      if (!name) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;

      const sf     = scryfallCache.get(name) || {};
      const rarity = scryfallRarity(sf.rarity);
      const market = li.market_price_cents || 0;

      // Skipped by rarity toggle → goes to remove list.
      if (skipRarities.has(rarity)) {
        removeRows?.push({ name, setName, rarity, qty, market, reason: `Skipped rarity: ${rarity || "unknown"}`, sf });
        continue;
      }

      const priceCents = ebayListingPrice(market, mode);
      // Below sift threshold → goes to remove list.
      if (priceCents == null) {
        removeRows?.push({ name, setName, rarity, qty, market, reason: `Below threshold ($${(market/100).toFixed(2)})`, sf });
        continue;
      }

      eligible.push({ li, name, qty, priceCents, rarity, sf });
    }

    // Sort eligible items.
    eligible.sort((a, b) => {
      switch (csvSort) {
        case "price-asc":  return a.priceCents - b.priceCents;
        case "price-desc": return b.priceCents - a.priceCents;
        case "rarity":     return (rarityOrder[a.rarity] ?? 9) - (rarityOrder[b.rarity] ?? 9) || a.name.localeCompare(b.name);
        default:           return a.name.localeCompare(b.name); // name
      }
    });

    for (const { li, name, qty, priceCents, rarity, sf } of eligible) {
      const shipPolicy = ebayShippingPolicy(li.market_price_cents, mode);

      const foilTag   = li.finish === "f" ? " Foil" : "";
      const finish    = li.finish === "f" ? "Foil" : "Non-Foil";
      const stockURL = li.tcgplayer_product_id ? `${TCG_IMG_BASE}/${li.tcgplayer_product_id}.jpg` : "";
      const scans    = scanImageMap.get(String(li.tcgplayer_product_id || "")) || {};
      // eBay uses pipe-delimited URLs in a single column for multiple images.
      const photoURL = [scans.front, scans.back, stockURL].filter(Boolean).join("|");
      const price    = (priceCents / 100).toFixed(2);

      const cardType    = scryfallCardType(sf.type_line);
      const isLegendary = (sf.type_line || "").includes("Legendary");
      const character   = isLegendary ? name : "";
      const rarityShort = { "Mythic Rare": "Mythic", "Rare": "Rare", "Uncommon": "Uncommon", "Common": "Common" }[rarity] || "";
      const cardNumber  = sf.collector_number || "";
      const rarityNum   = [rarityShort, cardNumber ? `#${cardNumber}` : ""].filter(Boolean).join(" ");
      const rawTitle    = `${name} ${setName} NM${foilTag}${rarityNum ? " " + rarityNum : ""} MTG Magic`;
      const title       = rawTitle.length > 80 ? rawTitle.slice(0, 79) + "…" : rawTitle;
      const desc        = `${name} | ${setName} | Near Mint${foilTag} | MTG Magic: The Gathering`;
      const sfColors    = sf.colors || [];
      const cardColor   = sfColors.length > 1 ? "Multicolored"
        : sfColors.length === 1 ? ({ W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[sfColors[0]] || "")
        : "Colorless";
      const yearMfg     = sf.released_at ? sf.released_at.slice(0, 4) : "";
      const setCode     = (report.set_code || "").toUpperCase();
      const numPadded   = cardNumber ? cardNumber.padStart(4, "0") : "";
      const finishCode  = li.finish === "f" ? "F" : "N";
      const sku         = setCode && numPadded ? `M-${setCode}-${numPadded}-${finishCode}` : "";

      const row = [
        "Draft", sku, 183454, title, "", price, qty, photoURL,
        "UNGRADED", desc, "FixedPrice", shipPolicy, "30 Day Returns", "Immediate Payment", 48071,
        "Magic: The Gathering", name, setName, finish, "English", "No", "Near Mint or Better",
        cardType, rarity, character, cardColor, cardNumber, yearMfg,
        "Standard", "13+", "Wizards of the Coast",
      ];

      if (shipPolicy === "FG Cards: Bulk Shipping") bulkRows.push(row);
      else freeRows.push(row);
    }
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
