#!/usr/bin/env node
// Updates set_name + collector_number in card_phashes for BLC cards.
// Uses EV API for product IDs, scryfall-meta.json for collector numbers.
// Run: node scripts/update-blc-phash-meta.js

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const EV_API   = "http://localhost:8081";
const SET_NAME = "Commander: Bloomburrow"; // exact string stored in card_phashes
const DB_URL   = "postgres://fg_app:b^4J4X+1=6Vz@192.168.86.181:5432/card_identifier?sslmode=disable";

const __dir = dirname(fileURLToPath(import.meta.url));
const scryfallPath = join(__dir, "../frontend/static/data/scryfall-meta.json");

async function main() {
  // 1. Load Scryfall metadata (name → {collector_number})
  const sfRaw  = await readFile(scryfallPath, "utf8");
  const sfMeta = JSON.parse(sfRaw);

  // 2. Get all BLC line items from EV API
  const r = await fetch(`${EV_API}/v1/ev/displays/blc-commander-display`);
  const d = await r.json();
  const items = (d.decks || []).flatMap(deck => deck.line_items || []);

  // Build product_id → {name, collector_number}
  const updates = [];
  for (const li of items) {
    const pid = li.tcgplayer_product_id;
    if (!pid) continue;
    const sf = sfMeta[li.name];
    const collectorNumber = sf?.collector_number || "";
    updates.push({ pid: parseInt(pid), name: li.name, collectorNumber });
  }

  console.log(`Updating ${updates.length} BLC cards in card_phashes…`);

  // 3. Connect to DB and update
  const client = new pg.Client(DB_URL);
  await client.connect();

  let ok = 0, skipped = 0;
  for (const { pid, name, collectorNumber } of updates) {
    const res = await client.query(
      `UPDATE card_phashes
       SET set_name = $1, collector_number = $2
       WHERE tcgplayer_product_id = $3`,
      [SET_NAME, collectorNumber, pid]
    );
    if (res.rowCount > 0) { ok++; process.stdout.write(`\r  updated ${ok}…`); }
    else skipped++;
  }
  await client.end();

  console.log(`\nDone — ${ok} updated, ${skipped} not in index (no phash yet).`);
}

main().catch(e => { console.error(e); process.exit(1); });
