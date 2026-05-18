#!/usr/bin/env node
// Fetches static card metadata from Scryfall for all cards across all EV
// calculator displays and writes frontend/static/data/scryfall-meta.json.
//
// Run whenever new sets are added:
//   node scripts/fetch-scryfall-meta.js
//
// Requires the EV API to be running at http://localhost:8081.
// Only fetches fields that never change: type_line, rarity, colors,
// collector_number, released_at. Pricing stays in the live API.
//
// Keyed by display_key (e.g. "mtg-blc-186-nf") rather than card name so that
// reprints in different sets always resolve to the correct printing.

const EV_API  = "http://localhost:8081";
const OUT     = new URL("../frontend/static/data/scryfall-meta.json", import.meta.url);
const SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection";
const BATCH   = 75; // Scryfall collection endpoint max
const DELAY   = 120; // ms between batches — stay under 10 req/s rate limit

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Parse "mtg-{set}-{number}-{finish}" -> { set, number } or null.
function parseDisplayKey(dk) {
  const parts = dk.split("-");
  if (parts.length < 4 || parts[0] !== "mtg") return null;
  const finish = parts[parts.length - 1];
  if (!["nf", "f", "e"].includes(finish)) return null;
  const number = parts[parts.length - 2];
  if (!/^\d+[a-z★]?$/.test(number)) return null;
  const set = parts.slice(1, -2).join("-");
  return { set, number };
}

async function fetchAllLineItems() {
  const res = await fetch(`${EV_API}/v1/ev/displays`);
  const { displays } = await res.json();

  // Dedupe by display_key — same card can appear across decks.
  const byKey = new Map();
  for (const { key } of displays) {
    const r = await fetch(`${EV_API}/v1/ev/displays/${encodeURIComponent(key)}`);
    const data = await r.json();
    for (const deck of data.decks || []) {
      for (const li of deck.line_items || []) {
        if (!li.display_key) continue;
        const parsed = parseDisplayKey(li.display_key);
        if (!parsed) continue;
        byKey.set(li.display_key, { display_key: li.display_key, ...parsed });
      }
    }
    process.stdout.write(`  loaded ${key}\n`);
  }
  return [...byKey.values()];
}

async function fetchScryfallBatch(items) {
  const res = await fetch(SCRYFALL_COLLECTION, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifiers: items.map(({ set, number }) => ({ set, collector_number: number })),
    }),
  });
  const data = await res.json();
  if (data.object === "error") throw new Error(data.details);
  return data.data || [];
}

function pickFields(card) {
  return {
    type_line:        card.type_line        ?? "",
    rarity:           card.rarity           ?? "",
    colors:           card.colors           ?? [],
    collector_number: card.collector_number ?? "",
    released_at:      card.released_at      ?? "",
  };
}

async function main() {
  console.log("Fetching line items from EV API…");
  const items = await fetchAllLineItems();
  console.log(`Found ${items.length} unique display_keys.\n`);

  const meta = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    process.stdout.write(`Scryfall batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(items.length / BATCH)}… `);
    const cards = await fetchScryfallBatch(batch);
    // Match results back to display_key via set:collector_number
    const lookup = new Map(batch.map(({ set, number, display_key }) => [`${set}:${number}`, display_key]));
    for (const card of cards) {
      const dk = lookup.get(`${card.set}:${card.collector_number}`);
      if (dk) meta[dk] = pickFields(card);
    }
    console.log(`got ${cards.length} cards.`);
    if (i + BATCH < items.length) await sleep(DELAY);
  }

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const outPath = fileURLToPath(OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(meta, null, 2));
  console.log(`\nWrote ${Object.keys(meta).length} entries to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
