// Shared formatting helpers.
window.EV = window.EV || {};
EV.fmtUSD = function(cents) {
  if (cents == null) return "—";
  return "$" + (cents / 100).toFixed(2);
};
EV.fmtPct = function(frac) {
  if (frac == null) return "—";
  return (frac * 100).toFixed(1) + "%";
};
EV.deltaClass = function(cents) {
  if (cents == null) return "";
  return cents >= 0 ? "pos" : "neg";
};
EV.api = function(path) {
  return (window.EV_API_BASE || "").replace(/\/$/, "") + path;
};
