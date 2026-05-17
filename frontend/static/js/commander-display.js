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

  // ── State ──────────────────────────────────────────────────────────────────
  // Start all decks collapsed.
  let activePlat    = "tcgplayer";
  let ebayMode      = "freeship";
  let csvSort       = "name";
  const skipRarities  = new Set();
  const userExcluded  = new Map();
  const userIncluded  = new Map();
  const collapsedDecks = new Set((report.decks || []).map(d => d.deck_key));

  // ── Settings event handlers ───────────────────────────────────────────────

  // Sell-on toggle
  document.querySelectorAll("#platform-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePlat = btn.dataset.plat;
      document.querySelectorAll("#platform-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      updateStrategyPanel();
      renderDecks();
    });
  });

  // TCGPlayer offset inputs
  document.getElementById("tcg-offset-type").addEventListener("change", renderDecks);
  document.getElementById("tcg-offset-value").addEventListener("input", renderDecks);

  // eBay mode toggle
  document.querySelectorAll("#ebay-mode-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ebayMode = btn.dataset.mode;
      document.querySelectorAll("#ebay-mode-toggle .plat-btn")
        .forEach(b => b.classList.toggle("active", b === btn));
      renderDecks();
    });
  });

  // Sort
  document.querySelectorAll("#sort-toggle .plat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      csvSort = btn.dataset.sort;
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
    });
  });

  // Case cost
  document.getElementById("case-cost").addEventListener("input", renderDecks);

  function updateStrategyPanel() {
    document.getElementById("strategy-tcgplayer").classList.toggle("hidden", activePlat !== "tcgplayer");
    document.getElementById("strategy-ebay").classList.toggle("hidden", activePlat !== "ebay");
  }

  // ── Scan panel ─────────────────────────────────────────────────────────────
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

  // Card picker overlay
  const picker = document.createElement("div");
  picker.className = "card-picker hidden";
  picker.innerHTML = `
    <div class="card-picker-box">
      <div class="card-picker-header">
        <span>Select card</span>
        <button class="scan-close" id="picker-close">✕</button>
      </div>
      <div class="card-picker-body">
        <div class="card-picker-preview"><img id="picker-front" alt="front scan"></div>
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
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const pairs = [];
    for (let i = 0; i < files.length; i += 2) pairs.push({ front: files[i], back: files[i + 1] || null });

    scanProgress.classList.remove("hidden");
    scanResults.innerHTML = "";
    scanBar.style.width = "0%";

    for (let i = 0; i < pairs.length; i++) {
      const { front, back } = pairs[i];
      scanStatus.textContent = `Processing ${i + 1} of ${pairs.length}…`;
      scanBar.style.width = `${Math.round((i / pairs.length) * 100)}%`;

      try {
        const fd = new FormData();
        fd.append("image", front);
        if (scanRestrictSet) fd.append("restrict_set", scanRestrictSet);
        const r1 = await fetch(EV.api("/v1/scan/identify"), { method: "POST", body: fd });
        if (!r1.ok) throw new Error("identify failed");
        const d1 = await r1.json();

        const scanId    = d1.scan_id;
        const frontURL  = d1.front_image || "";
        const productId = d1.candidates?.[0]?.tcgplayer_product_id;
        const confidence = d1.confidence || "none";

        let backURL = "";
        if (back && scanId) {
          const fd2 = new FormData();
          fd2.append("scan_id", scanId);
          fd2.append("image", back);
          const r2 = await fetch(EV.api("/v1/scan/back"), { method: "POST", body: fd2 });
          if (r2.ok) { const d2 = await r2.json(); backURL = d2.back_image || ""; }
        }

        const cardName    = productId ? (displayCardMap.get(String(productId))?.name || `ID ${productId}`) : null;
        const needsReview = d1.needs_review;
        const ocrName     = d1.ocr_name || "";
        const nameOK      = d1.name_confirmed;

        if (productId) scanImageMap.set(String(productId), { front: frontURL, back: backURL });

        const statusClass  = !productId ? "unmatched" : needsReview ? "needs-review" : "matched";
        const reviewBadge  = needsReview ? `<div class="scan-card-warn">⚠️ OCR: "${ocrName}" — verify card</div>` : "";

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
    document.querySelectorAll("tr[data-pid]").forEach(row => {
      const pid  = row.dataset.pid;
      if (!pid) return;
      const cell = row.querySelector("td.scan-cell");
      if (!cell) return;
      const has = scanImageMap.get(pid)?.front || scanImageMap.get(pid)?.back;
      cell.title   = has ? "Scan linked" : "No scan";
      cell.textContent = has ? "📷" : "—";
    });
  }

  // ── Pricing helpers ────────────────────────────────────────────────────────

  function tcgOffsetType()  { return document.getElementById("tcg-offset-type").value; }
  function tcgOffsetValue() { return parseFloat(document.getElementById("tcg-offset-value").value) || 0; }

  // Listing price the user intends to put on the platform.
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

  // Net proceeds after platform fees.
  function platformNet(li) {
    if (!li.market_price_cents) return null;
    switch (activePlat) {
      case "tcgplayer": {
        if (li.tcgplayer_net_cents == null) return null;
        const ov = tcgOffsetValue();
        if (tcgOffsetType() === "pct") {
          // Listing scales up → net scales proportionally.
          return Math.round(li.tcgplayer_net_cents * (1 + ov / 100));
        } else {
          // Fixed $ offset: extra gross × fee-keep rate.
          const keepRate = li.tcgplayer_net_cents / li.market_price_cents;
          return Math.round(li.tcgplayer_net_cents + Math.round(ov * 100) * keepRate);
        }
      }
      case "manapool": return li.manapool_net_cents ?? null;
      case "ebay":     return li.ebay_net_cents ?? null;
      default:         return li.tcgplayer_net_cents ?? null;
    }
  }

  function computeDeckNet(d) {
    let total = 0;
    for (const li of d.line_items || []) {
      if (!li.included_in_ev) continue;
      const net = platformNet(li);
      if (net == null) continue;
      total += net * li.qty; // li.qty already scaled by copies
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

  function siftThresholdCents() {
    const v = parseFloat(document.getElementById("sift-threshold")?.value || "0.25");
    return Math.round((isNaN(v) ? 25 : v) * 100);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const $grid = document.querySelector("#decks");

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

    // When a case cost is entered, profit is the headline figure.
    // Otherwise just show net proceeds.
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

    // Restore collapsed state after re-render.
    collapsedDecks.forEach(key => {
      const card = $grid.querySelector(`.deck-card[data-deck-key="${key}"]`);
      if (!card) return;
      card.querySelector(".deck-singles")?.classList.add("hidden");
      const btn = card.querySelector(".deck-collapse-btn");
      if (btn) { btn.textContent = "▶ Cards"; btn.classList.add("collapsed"); }
    });

    // Sort on column header click.
    $grid.querySelectorAll("table.cards").forEach(table => {
      table.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => sortTable(table, +th.cellIndex, th.dataset.sort));
      });
    });

    // EV toggle (include/exclude from CSV export).
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
    const showListing = true; // always show export price preview

    const lines = (d.line_items || []).slice().sort((a, b) => {
      switch (csvSort) {
        case "price-asc":  return (a.market_price_cents||0) - (b.market_price_cents||0);
        case "price-desc": return (b.market_price_cents||0) - (a.market_price_cents||0);
        default:           return (a.name||"").localeCompare(b.name||"");
      }
    });

    const rows = lines.map(li => {
      const qtyPerCopy = Math.round(li.qty / copies);
      const net        = platformNet(li);
      const listing    = showListing ? platformListingPrice(li) : null;
      const caseTotal  = net != null ? net * li.qty : null;
      const pid        = String(li.tcgplayer_product_id || "");
      const hasPhoto   = pid && (scanImageMap.get(pid)?.front || scanImageMap.get(pid)?.back);

      const forceExclude = userExcluded.get(pid);
      const forceInclude = userIncluded.get(pid);
      const autoPrice    = platformListingPrice(li);
      const exportOn     = forceExclude ? false : forceInclude ? true : autoPrice != null;
      const evIcon  = exportOn ? "✓" : "—";
      const evClass = forceExclude ? "ev-override-off" : forceInclude ? "ev-override-on" : "";

      const listingCell = showListing ? `<td class="right">${EV.fmtUSD(listing)}</td>` : "";

      return `<tr class="${li.included_in_ev ? "" : "excluded"}" data-pid="${pid}">
        <td class="ev-toggle ${evClass}" data-pid="${pid}" title="Click to toggle CSV export" style="cursor:pointer;text-align:center">${evIcon}</td>
        <td class="scan-cell center" title="${hasPhoto ? "Scan linked" : "No scan"}">${hasPhoto ? "📷" : "—"}</td>
        <td>${escHtml(li.name || li.display_key)}${cardLinks(li)}</td>
        <td class="right">${qtyPerCopy}</td>
        <td class="right">${EV.fmtUSD(li.market_price_cents)}</td>
        ${listingCell}
        <td class="right ${net == null ? "muted" : ""}">${EV.fmtUSD(net)}</td>
        <td class="right ${caseTotal == null ? "muted" : ""}">${EV.fmtUSD(caseTotal)}</td>
      </tr>`;
    }).join("");

    const listingTh = `<th class="right" title="Price you would list at on ${activePlat} given your pricing strategy">Export $</th>`;

    return `
      <div class="deck-singles">
        <div class="export-bar">
          <span class="export-label">Export singles:</span>
          <button class="export-btn" data-export="tcgplayer" data-deck-key="${d.deck_key}">TCGPlayer CSV</button>
          <button class="export-btn" data-export="manapool"  data-deck-key="${d.deck_key}">Manapool CSV</button>
          <button class="export-btn" data-export="ebay"      data-deck-key="${d.deck_key}">eBay CSV</button>
        </div>
        <div class="singles-table-wrap">
          <table class="data cards">
            <thead><tr>
              <th title="Toggle CSV export inclusion" style="width:2rem">EV</th>
              <th title="Scan linked" style="width:2rem">📷</th>
              <th data-sort="text">Card</th>
              <th class="right" data-sort="num" title="Copies per deck">Qty</th>
              <th class="right" data-sort="num">Market</th>
              ${listingTh}
              <th class="right" data-sort="num">${platLabel}</th>
              <th class="right" data-sort="num" title="Net × qty × copies in case">Case Total</th>
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

  // Per-deck export buttons (delegated — grid content changes on re-render).
  $grid.addEventListener("click", async e => {
    const btn = e.target.closest(".export-btn");
    if (!btn) return;
    const deckKey = btn.dataset.deckKey;
    const d = (report.decks || []).find(x => x.deck_key === deckKey);
    if (!d) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Building…";
    try {
      await scryfallReady;
      if (btn.dataset.export === "ebay") {
        const files = buildEbayCSVMulti([d], null, ebayMode);
        files.forEach(([csv, name]) => downloadCSV(csv, name));
      } else {
        const [csv, name] = buildExportCSV(btn.dataset.export, d, report, ebayMode);
        downloadCSV(csv, name);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Whole-case eBay CSV export.
  document.getElementById("download-all-csv").addEventListener("click", async function () {
    if (this.disabled) return;
    this.disabled = true;
    this.textContent = "Building…";
    try {
      await scryfallReady;
      const slug  = (report.display_key || "set").replace(/[^a-z0-9-]/gi, "-");
      const files = buildEbayCSVMulti(report.decks, slug, ebayMode);
      files.forEach(([csv, name]) => downloadCSV(csv, name));
    } finally {
      this.disabled = false;
      this.textContent = "Download eBay CSV";
    }
  });

  // Reprice CSV.
  document.getElementById("download-reprice-csv").addEventListener("click", async function () {
    if (this.disabled) return;
    this.disabled = true;
    this.textContent = "Building…";
    try {
      await scryfallReady;
      const slug = (report.display_key || "set").replace(/[^a-z0-9-]/gi, "-");
      const rows = [["Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", "Custom label (SKU)", "StartPrice", "Quantity"]];
      for (const d of report.decks) {
        const copies  = d.copies || 1;
        const setCode = (report.set_code || "").toUpperCase();
        for (const li of d.line_items || []) {
          const name = li.name || li.display_key;
          if (!name) continue;
          const qty = Math.round(li.qty / copies);
          if (qty <= 0) continue;
          const sf      = scryfallCache.get(name) || {};
          const rarity  = scryfallRarity(sf.rarity);
          if (skipRarities.has(rarity)) continue;
          const priceCents = ebayListingPrice(li.market_price_cents, ebayMode);
          if (priceCents == null) continue;
          const numPadded = (sf.collector_number || "").padStart(4, "0");
          const finCode   = li.finish === "f" ? "F" : "N";
          const sku = setCode && numPadded ? `M-${setCode}-${numPadded}-${finCode}` : "";
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

  // ── Scryfall metadata ──────────────────────────────────────────────────────
  const scryfallCache = new Map();

  const scryfallReady = (async () => {
    await loadScryfallMeta();
    const allNames = (report.decks || [])
      .flatMap(d => (d.line_items || []).map(li => li.name || li.display_key))
      .filter(Boolean);
    await fetchScryfallMeta(allNames);
  })();

  async function loadScryfallMeta() {
    try {
      const res  = await fetch("/data/scryfall-meta.json");
      const data = await res.json();
      for (const [name, meta] of Object.entries(data)) scryfallCache.set(name, meta);
    } catch (_) {}
  }

  async function fetchScryfallMeta(names) {
    const uncached = [...new Set(names)].filter(n => !scryfallCache.has(n));
    if (!uncached.length) return;
    for (let i = 0; i < uncached.length; i += 75) {
      const batch = uncached.slice(i, i + 75);
      try {
        const res  = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: batch.map(name => ({ name })) }),
        });
        const data = await res.json();
        (data.data || []).forEach(card => scryfallCache.set(card.name, card));
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

  // ── CSV export ────────────────────────────────────────────────────────────

  const TCG_IMG_BASE = EV.api("/v1/images").replace(/\/$/, "");

  function buildExportCSV(type, d, rep, mode) {
    const slug = (d.deck_key || rep.display_key || "deck").replace(/[^a-z0-9-]/gi, "-");
    switch (type) {
      case "tcgplayer": return buildTCGPlayerCSV(d, slug);
      case "manapool":  return buildManapoolCSV(d, slug);
      case "ebay":      return buildEbayCSV(d, slug, mode);
      default: return ["", "export.csv"];
    }
  }

  function buildTCGPlayerCSV(d, slug) {
    const copies = d.copies || 1;
    const rows = [["TCGplayer Id","Quantity","Condition","Price"]];
    for (const li of d.line_items || []) {
      if (!li.tcgplayer_product_id) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;
      const priceCents = tcgplayerListingPrice(li.market_price_cents);
      if (priceCents == null) continue;
      rows.push([li.tcgplayer_product_id, qty, li.finish === "f" ? "Near Mint Foil" : "Near Mint", (priceCents/100).toFixed(2)]);
    }
    return [csvSerialize(rows), `tcgplayer-${slug}.csv`];
  }

  function buildManapoolCSV(d, slug) {
    const copies = d.copies || 1;
    const rows = [["Name","Edition","Quantity","Foil","Condition","Price (USD)"]];
    for (const li of d.line_items || []) {
      const name = li.name || li.display_key;
      if (!name) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;
      const priceCents = li.market_price_cents;
      if (priceCents == null) continue;
      const edition = d.deck_key ? d.deck_key.split("-")[0].toUpperCase() : "";
      rows.push([name, edition, qty, li.finish === "f" ? "Yes" : "No", "Near Mint", (priceCents/100).toFixed(2)]);
    }
    return [csvSerialize(rows), `manapool-${slug}.csv`];
  }

  function buildEbayCSV(d, slug, mode) {
    const free = [], bulk = [], remove = [];
    buildEbayRows(d, mode, free, bulk, remove);
    const infoLines = ebayInfoLines();
    const headers   = ebayHeaders();
    const files     = [];
    const df = dedupeRows(free);
    const db = dedupeRows(bulk);
    if (df.length) files.push([infoLines + "\r\n" + csvSerialize([headers, ...df]), `ebay-${slug}-freeship.csv`]);
    if (db.length) files.push([infoLines + "\r\n" + csvSerialize([headers, ...db]), `ebay-${slug}-bulk.csv`]);
    return files[0] || ["", `ebay-${slug}.csv`];
  }

  const ENVELOPE = 130;

  function ebayListingPrice(marketCents, mode) {
    if (marketCents == null || marketCents < siftThresholdCents()) return null;
    if (mode === "freeship") return marketCents < 500 ? marketCents + ENVELOPE : marketCents;
    if (marketCents < 100) return marketCents + ENVELOPE;
    return marketCents;
  }

  function tcgplayerListingPrice(marketCents) {
    if (marketCents == null || marketCents < 40) return null;
    // Apply user-configured offset.
    const ov = tcgOffsetValue();
    let gross = tcgOffsetType() === "pct"
      ? Math.round(marketCents * (1 + ov / 100))
      : marketCents + Math.round(ov * 100);
    if (gross >= 460 && gross <= 525) gross = 499; // gap avoidance
    return gross;
  }

  function ebayShippingPolicy(marketCents, mode) {
    if (mode === "freeship") return "FG Cards: Free Shipping";
    if (marketCents >= 100 && marketCents < 500) return "FG Cards: Bulk Shipping";
    return "FG Cards: Free Shipping";
  }

  function dedupeRows(rows) {
    const skuCol = 1, qtyCol = 6;
    const seen = new Map(), out = [];
    for (const row of rows) {
      const sku = row[skuCol];
      if (sku && seen.has(sku)) {
        seen.get(sku)[qtyCol] = (parseInt(seen.get(sku)[qtyCol])||0) + (parseInt(row[qtyCol])||0);
      } else {
        const copy = [...row];
        out.push(copy);
        if (sku) seen.set(sku, copy);
      }
    }
    return out;
  }

  function buildEbayCSVMulti(decks, slugOverride, mode) {
    const free = [], bulk = [], remove = [];
    for (const d of decks) buildEbayRows(d, mode, free, bulk, remove);
    const slug     = slugOverride || (decks[0]?.deck_key || "deck").replace(/[^a-z0-9-]/gi, "-");
    const info     = ebayInfoLines();
    const headers  = ebayHeaders();
    const files    = [];
    const df = dedupeRows(free), db = dedupeRows(bulk);
    if (df.length) files.push([info + "\r\n" + csvSerialize([headers, ...df]), `ebay-${slug}-freeship.csv`]);
    if (db.length) files.push([info + "\r\n" + csvSerialize([headers, ...db]), `ebay-${slug}-bulk.csv`]);
    if (remove.length) {
      const rh = ["Card Name","Set","Rarity","Collector #","Qty","Market Price","Reason"];
      const rd = remove.sort((a,b) => a.name.localeCompare(b.name))
        .map(r => [r.name, r.setName, r.rarity, r.sf?.collector_number||"", r.qty, `$${(r.market/100).toFixed(2)}`, r.reason]);
      files.push([csvSerialize([rh,...rd]), `${slug}-remove.csv`]);
    }
    return files;
  }

  const rarityOrder = { "Mythic Rare":0, "Rare":1, "Uncommon":2, "Common":3 };

  function buildEbayRows(d, mode, freeRows, bulkRows, removeRows) {
    const copies  = d.copies || 1;
    const setName = report.name.replace(/\s+(commander|collector|bonus|scene).*$/i,"").trim();
    const eligible = [];

    for (const li of d.line_items || []) {
      const name = li.name || li.display_key;
      if (!name) continue;
      const qty = Math.round(li.qty / copies);
      if (qty <= 0) continue;
      const sf     = scryfallCache.get(name) || {};
      const rarity = scryfallRarity(sf.rarity);
      const market = li.market_price_cents || 0;
      const pid    = String(li.tcgplayer_product_id || "");

      if (skipRarities.has(rarity) && !userIncluded.get(pid)) {
        removeRows?.push({ name, setName, rarity, qty, market, reason: `Skipped rarity: ${rarity||"unknown"}`, sf });
        continue;
      }
      if (userExcluded.get(pid)) {
        removeRows?.push({ name, setName, rarity, qty, market, reason: "Manually excluded", sf });
        continue;
      }
      const priceCents = ebayListingPrice(market, mode);
      if (priceCents == null && !userIncluded.get(pid)) {
        removeRows?.push({ name, setName, rarity, qty, market, reason: `Below threshold ($${(market/100).toFixed(2)})`, sf });
        continue;
      }
      const effectivePrice = priceCents ?? Math.max(market, siftThresholdCents());
      eligible.push({ li, name, qty, priceCents: effectivePrice, rarity, sf });
    }

    eligible.sort((a, b) => {
      switch (csvSort) {
        case "price-asc":  return a.priceCents - b.priceCents;
        case "price-desc": return b.priceCents - a.priceCents;
        case "rarity":     return (rarityOrder[a.rarity]??9) - (rarityOrder[b.rarity]??9) || a.name.localeCompare(b.name);
        default:           return a.name.localeCompare(b.name);
      }
    });

    for (const { li, name, qty, priceCents, rarity, sf } of eligible) {
      const shipPolicy  = ebayShippingPolicy(li.market_price_cents, mode);
      const foilTag     = li.finish === "f" ? " Foil" : "";
      const finish      = li.finish === "f" ? "Foil" : "Non-Foil";
      const stockURL    = li.tcgplayer_product_id ? `${TCG_IMG_BASE}/${li.tcgplayer_product_id}.jpg` : "";
      const scans       = scanImageMap.get(String(li.tcgplayer_product_id||"")) || {};
      const photoURL    = [scans.front, scans.back, stockURL].filter(Boolean).join("|");
      const price       = (priceCents/100).toFixed(2);
      const cardType    = scryfallCardType(sf.type_line);
      const isLegendary = (sf.type_line||"").includes("Legendary");
      const character   = isLegendary ? name : "";
      const rarityShort = { "Mythic Rare":"Mythic","Rare":"Rare","Uncommon":"Uncommon","Common":"Common" }[rarity]||"";
      const cardNumber  = sf.collector_number||"";
      const rarityNum   = [rarityShort, cardNumber?`#${cardNumber}`:""].filter(Boolean).join(" ");
      const rawTitle    = `${name} ${setName} NM${foilTag}${rarityNum?" "+rarityNum:""} MTG Magic`;
      const title       = rawTitle.length > 80 ? rawTitle.slice(0,79)+"…" : rawTitle;
      const desc        = `${name} | ${setName} | Near Mint${foilTag} | MTG Magic: The Gathering`;
      const sfColors    = sf.colors||[];
      const cardColor   = sfColors.length>1 ? "Multicolored"
        : sfColors.length===1 ? ({W:"White",U:"Blue",B:"Black",R:"Red",G:"Green"}[sfColors[0]]||"") : "Colorless";
      const yearMfg     = sf.released_at ? sf.released_at.slice(0,4) : "";
      const setCode     = (report.set_code||"").toUpperCase();
      const numPadded   = cardNumber ? cardNumber.padStart(4,"0") : "";
      const finishCode  = li.finish==="f" ? "F" : "N";
      const sku         = setCode && numPadded ? `M-${setCode}-${numPadded}-${finishCode}` : "";
      const row = [
        "Draft", sku, 183454, title, "", price, qty, photoURL,
        "UNGRADED", desc, "FixedPrice", shipPolicy, "30 Day Returns", "Immediate Payment", 48071,
        "Magic: The Gathering", name, setName, finish, "English", "No", "Near Mint or Better",
        cardType, rarity, character, cardColor, cardNumber, yearMfg, "Standard","13+","Wizards of the Coast",
      ];
      if (shipPolicy === "FG Cards: Bulk Shipping") bulkRows.push(row);
      else freeRows.push(row);
    }
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
      "Custom label (SKU)","Category ID","Title","UPC","Price","Quantity",
      "Item photo URL","Condition ID","Description","Format",
      "ShippingProfileName","ReturnProfileName","PaymentProfileName","Location",
      "C:Game","C:Card Name","C:Set","C:Finish","C:Language","C:Graded",
      "C:Card Condition","C:Card Type","C:Rarity","C:Character","C:Color",
      "C:Card Number","C:Year Manufactured","C:Card Size","C:Age Level","C:Manufacturer",
    ];
  }

  function csvSerialize(rows) {
    return rows.map(cols =>
      cols.map(v => {
        const s = String(v == null ? "" : v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
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
