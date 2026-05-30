// Renders the index table of available displays with search, sort, and fee override.
(async function() {
  const $tbody   = document.querySelector("#displays tbody");
  const $search  = document.getElementById("list-search");
  const $fee     = document.getElementById("fee-override");
  const $headers = document.querySelectorAll("#displays thead th[data-sort]");

  const SCRYFALL_SETS  = "https://c2.scryfall.com/file/scryfall-symbols/sets/";
  const TCG_PROD_IMG   = "https://product-images.tcgplayer.com/fit-in/68x93/";

  // ── State ─────────────────────────────────────────────────────────────────
  let allData  = [];  // [{d, report, gross, error}]
  let sortCol  = null;
  let sortAsc  = true;

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadIndex() {
    const r = await fetch(EV.api("/v1/ev/displays"));
    if (!r.ok) throw new Error("displays index: " + r.status);
    return (await r.json()).displays || [];
  }

  async function loadReport(key) {
    const r = await fetch(EV.api("/v1/ev/displays/" + encodeURIComponent(key)));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  // Sum raw market value for all included line items across all decks.
  function computeGross(report) {
    let gross = 0;
    for (const deck of report?.decks || []) {
      for (const li of deck.line_items || []) {
        if (li.included_in_ev && li.market_price_cents) {
          gross += li.market_price_cents * (li.qty || 1);
        }
      }
    }
    return gross || null;
  }

  // ── Fee helpers ───────────────────────────────────────────────────────────
  function feeOverridePct() {
    const v = parseFloat($fee.value);
    return isFinite(v) && v >= 0 ? v : null;
  }

  function singlesNet(item) {
    const fee = feeOverridePct();
    if (fee !== null && item.gross !== null) {
      return Math.round(item.gross * (1 - fee / 100));
    }
    return item.report?.singles_net_cents ?? null;
  }

  // ── Sort helpers ──────────────────────────────────────────────────────────
  function rowValue(item, col) {
    const NONE = sortAsc ? Infinity : -Infinity;
    switch (col) {
      case "name":    return item.d.name.toLowerCase();
      case "copies":  return item.d.total_copies ?? NONE;
      case "case":    return item.report?.case_cost_cents ?? NONE;
      case "singles": return singlesNet(item) ?? NONE;
      case "sealed":  return item.report?.sealed_decks_net_cents ?? NONE;
      case "delta": {
        const sn = singlesNet(item), sd = item.report?.sealed_decks_net_cents, cc = item.report?.case_cost_cents;
        const best = Math.max(sn ?? -Infinity, sd ?? -Infinity);
        return (cc && best > -Infinity) ? best - cc : NONE;
      }
      case "pct": {
        const sn = singlesNet(item), sd = item.report?.sealed_decks_net_cents, cc = item.report?.case_cost_cents;
        const best = Math.max(sn ?? -Infinity, sd ?? -Infinity);
        return (cc && best > -Infinity) ? (best - cc) / cc : NONE;
      }
      default: return NONE;
    }
  }

  function updateSortHeaders() {
    $headers.forEach(th => {
      const col = th.dataset.sort;
      th.removeAttribute("aria-sort");
      if (col === sortCol) th.setAttribute("aria-sort", sortAsc ? "ascending" : "descending");
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function setImageCell(d) {
    if (d.product_tcgplayer_id) {
      const url = TCG_PROD_IMG + d.product_tcgplayer_id + ".jpg";
      const fallback = SCRYFALL_SETS + d.set_code + ".svg";
      return `<td class="set-img-cell">
        <img src="${url}" class="set-prod-img" alt="${d.set_code.toUpperCase()}" title="${d.name}"
             onerror="this.src='${fallback}';this.className='set-sym-img';this.style.opacity='0.8'">
      </td>`;
    }
    const url = SCRYFALL_SETS + d.set_code + ".svg";
    return `<td class="set-img-cell">
      <img src="${url}" class="set-sym-img" alt="${d.set_code.toUpperCase()}" title="${d.set_code.toUpperCase()}">
    </td>`;
  }

  function renderRow(item) {
    if (!item) return "";
    const {d, report, error} = item;
    const href      = "../commander/display/?key=" + encodeURIComponent(d.key);
    const caseCost  = report?.case_cost_cents ?? null;
    const sn        = singlesNet(item);
    const sd        = report?.sealed_decks_net_cents ?? null;

    // Error state: show the display name + error badge, dashes for data.
    if (error && !report) {
      return `<tr>
        ${setImageCell(d)}
        <td><a href="${href}">${d.name}</a>
          <div class="subtle">${d.game} · ${d.set_code.toUpperCase()}</div>
          <span class="fetch-error-badge" title="${error}">⚠ fetch failed</span>
        </td>
        <td class="right">${d.total_copies}</td>
        <td class="right muted">—</td>
        <td class="right muted">—</td>
        <td class="right muted">—</td>
        <td class="right muted">—</td>
        <td class="right muted">—</td>
        <td class="subtle muted">—</td>
      </tr>`;
    }

    // Recompute best scenario with current fee applied.
    let bestDelta = null, bestPct = null, bestLabel = "—";
    const snVal = sn ?? -Infinity;
    const sdVal = sd ?? -Infinity;
    if (snVal > -Infinity || sdVal > -Infinity) {
      const singlesWins = snVal >= sdVal;
      const bestNet     = singlesWins ? sn : sd;
      bestLabel         = singlesWins ? "Singles" : "Sealed decks";
      if (caseCost && bestNet !== null) {
        bestDelta = bestNet - caseCost;
        bestPct   = bestDelta / caseCost;
      }
    }

    const feeNote = feeOverridePct() !== null ? ` <span class="subtle fee-note">(${feeOverridePct()}% fee)</span>` : "";

    return `<tr>
      ${setImageCell(d)}
      <td><a href="${href}">${d.name}</a><div class="subtle">${d.game} · ${d.set_code.toUpperCase()}</div></td>
      <td class="right">${d.total_copies}</td>
      <td class="right">${EV.fmtUSD(caseCost)}</td>
      <td class="right">${EV.fmtUSD(sn)}${feeNote}</td>
      <td class="right">${EV.fmtUSD(sd)}</td>
      <td class="right ${EV.deltaClass(bestDelta)}">${EV.fmtUSD(bestDelta)}</td>
      <td class="right ${EV.deltaClass(bestDelta)}">${EV.fmtPct(bestPct)}</td>
      <td class="subtle">${bestLabel}</td>
    </tr>`;
  }

  function render() {
    const q = $search.value.trim().toLowerCase();
    let rows = q ? allData.filter(item => item.d.name.toLowerCase().includes(q)) : allData.slice();

    if (sortCol) {
      rows.sort((a, b) => {
        const av = rowValue(a, sortCol);
        const bv = rowValue(b, sortCol);
        if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortAsc ? av - bv : bv - av;
      });
    }

    $tbody.innerHTML = rows.length
      ? rows.map(renderRow).join("")
      : `<tr><td colspan="9" class="subtle" style="padding:1rem">No results.</td></tr>`;

    updateSortHeaders();
  }

  // ── Event wiring ──────────────────────────────────────────────────────────
  $search.addEventListener("input", render);
  $fee.addEventListener("input", render);

  $headers.forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = col === "name"; // text sorts A→Z first; numbers sort high→low first
      }
      render();
    });
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  let displays;
  try {
    displays = await loadIndex();
  } catch (e) {
    $tbody.innerHTML = `<tr><td colspan="9" class="error">Index failed: ${e.message}</td></tr>`;
    return;
  }
  if (displays.length === 0) {
    $tbody.innerHTML = `<tr><td colspan="9" class="loading">No displays defined.</td></tr>`;
    return;
  }

  // Render stub rows immediately, then fill in data as each report loads.
  allData = displays.map(d => ({ d, report: null, gross: null, error: null }));
  $tbody.innerHTML = allData.map(renderRow).join("");

  await Promise.all(allData.map(async (item) => {
    try {
      item.report = await loadReport(item.d.key);
      item.gross  = computeGross(item.report);
    } catch (e) {
      item.error = e.message;
    }
    // Re-render the whole table after each report arrives so sort/filter stay consistent.
    render();
  }));
})();
