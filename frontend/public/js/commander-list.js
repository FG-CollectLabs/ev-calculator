// Renders the index table of available displays.
// Calls /v1/ev/displays for the list, then fans out one report fetch per
// row to populate case cost / singles net / best scenario delta columns.
(async function() {
  const $tbody = document.querySelector("#displays tbody");

  async function loadIndex() {
    const r = await fetch(EV.api("/v1/ev/displays"));
    if (!r.ok) throw new Error("displays index: " + r.status);
    return (await r.json()).displays || [];
  }

  async function loadReport(key) {
    const r = await fetch(EV.api("/v1/ev/displays/" + encodeURIComponent(key)));
    if (!r.ok) throw new Error("display " + key + ": " + r.status);
    return await r.json();
  }

  function renderRow(d, report) {
    const href = "../commander/display/?key=" + encodeURIComponent(d.key);
    const caseCost   = report ? report.case_cost_cents       : null;
    const singlesNet = report ? report.singles_net_cents      : null;
    const sealedNet  = report ? report.sealed_decks_net_cents : null;
    // Show whichever scenario is best (or singles if no case cost).
    const best        = report ? report.best_scenario : null;
    const bestDelta   = best === "sealed_decks" ? (report ? report.sealed_decks_delta_cents : null)
                                                : (report ? report.singles_delta_cents      : null);
    const bestPct     = best === "sealed_decks" ? (report ? report.sealed_decks_delta_pct  : null)
                                                : (report ? report.singles_delta_pct        : null);
    const bestLabel   = best === "sealed_decks" ? "Sealed decks" : best === "singles" ? "Singles" : "—";

    return `
      <tr>
        <td><a href="${href}">${d.name}</a><div class="subtle">${d.game} · ${d.set_code.toUpperCase()}</div></td>
        <td class="right">${d.total_copies}</td>
        <td class="right">${EV.fmtUSD(caseCost)}</td>
        <td class="right">${EV.fmtUSD(singlesNet)}</td>
        <td class="right">${EV.fmtUSD(sealedNet)}</td>
        <td class="right ${EV.deltaClass(bestDelta)}">${EV.fmtUSD(bestDelta)}</td>
        <td class="right ${EV.deltaClass(bestDelta)}">${EV.fmtPct(bestPct)}</td>
        <td class="subtle">${bestLabel}</td>
      </tr>`;
  }

  let displays;
  try {
    displays = await loadIndex();
  } catch (e) {
    $tbody.innerHTML = `<tr><td colspan="8" class="error">Index failed: ${e.message}</td></tr>`;
    return;
  }
  if (displays.length === 0) {
    $tbody.innerHTML = `<tr><td colspan="8" class="loading">No displays defined.</td></tr>`;
    return;
  }

  $tbody.innerHTML = displays.map(d => renderRow(d, null)).join("");
  await Promise.all(displays.map(async (d, i) => {
    try {
      const report = await loadReport(d.key);
      $tbody.children[i].outerHTML = renderRow(d, report);
    } catch (e) {
      const cols = $tbody.children[i].cells.length;
      $tbody.children[i].innerHTML = `<td class="error" colspan="${cols}">${e.message}</td>`;
    }
  }));
})();
