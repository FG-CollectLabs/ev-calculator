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

const EV_API  = "http://localhost:8081";
const OUT     = new URL("../frontend/static/data/scryfall-meta.json", import.meta.url);
const SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection";
const BATCH   = 75; // Scryfall collection endpoint max
const DELAY   = 120; // ms between batches — stay under 10 req/s rate limit

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchAllCardNames() {
  const res = await fetch(`${EV_API}/v1/ev/displays`);
  const { displays } = await res.json();

  const names = new Set();
  for (const { key } of displays) {
    const r = await fetch(`${EV_API}/v1/ev/displays/${encodeURIComponent(key)}`);
    const data = await r.json();
    for (const deck of data.decks || []) {
      for (const li of deck.line_items || []) {
        if (li.name) names.add(li.name);
      }
    }
    process.stdout.write(`  loaded ${key}\n`);
  }
  return [...names];
}

async function fetchScryfallBatch(names) {
  const res = await fetch(SCRYFALL_COLLECTION, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiers: names.map(name => ({ name })) }),
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
  console.log("Fetching card names from EV API…");
  const names = await fetchAllCardNames();
  console.log(`Found ${names.length} unique cards.\n`);

  const meta = {};
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    process.stdout.write(`Scryfall batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(names.length / BATCH)}… `);
    const cards = await fetchScryfallBatch(batch);
    for (const card of cards) meta[card.name] = pickFields(card);
    console.log(`got ${cards.length} cards.`);
    if (i + BATCH < names.length) await sleep(DELAY);
  }

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const outPath = fileURLToPath(OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(meta, null, 2));
  console.log(`\nWrote ${Object.keys(meta).length} cards to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
