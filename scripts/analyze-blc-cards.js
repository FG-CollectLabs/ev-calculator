#!/usr/bin/env node
// Analyzes Bloomburrow Commander cards for:
// 1. Commander-exclusive prints (not in draft/set boosters)
// 2. Cards legal in 60-card formats (potential 4-copy premium)
//
// Run: node scripts/analyze-blc-cards.js

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EV_API   = "http://localhost:8081";
const __dir    = dirname(fileURLToPath(import.meta.url));
const sfPath   = join(__dir, "../frontend/static/data/scryfall-meta.json");

const DRAFT_LEGAL_SET_TYPES = new Set(["expansion", "core", "draft_innovation"]);

async function fetchScryfallCard(name) {
  await new Promise(r => setTimeout(r, 80)); // stay under rate limit
  const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

async function main() {
  const sfMeta = JSON.parse(await readFile(sfPath, "utf8"));

  const r = await fetch(`${EV_API}/v1/ev/displays/blc-commander-display`);
  const d = await r.json();
  const allItems = (d.decks || []).flatMap(deck => deck.line_items || []);

  // Deduplicate by card name.
  const seen = new Set();
  const cards = allItems.filter(li => {
    const name = li.name || li.display_key;
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  console.log(`Analyzing ${cards.length} unique BLC cards…\n`);

  const cmdExclusive   = [];  // only in commander products
  const sixtyCardLegal = [];  // legal in modern/pioneer/standard
  const both           = [];  // commander-exclusive AND legal in 60-card (unusual)

  for (let i = 0; i < cards.length; i++) {
    const li   = cards[i];
    const name = li.name || li.display_key;
    process.stdout.write(`\r[${i+1}/${cards.length}] ${name.padEnd(50)}`);

    const sf = await fetchScryfallCard(name);
    if (!sf) continue;

    // Commander-exclusive: no printing in a draft-legal set.
    // Use prints_search_uri to get all printings and check set types.
    let isExclusive = true;
    if (sf.prints_search_uri) {
      const pr = await fetch(sf.prints_search_uri + "&order=released");
      if (pr.ok) {
        const pd = await pr.json();
        for (const print of (pd.data || [])) {
          if (DRAFT_LEGAL_SET_TYPES.has(print.set_type)) {
            isExclusive = false;
            break;
          }
        }
      }
      await new Promise(r => setTimeout(r, 80));
    }

    // 60-card legal: check legalities.
    const leg = sf.legalities || {};
    const formats60 = ["standard", "pioneer", "modern", "legacy", "vintage"].filter(f => leg[f] === "legal");
    const isLegal60 = formats60.length > 0;

    const entry = {
      name,
      rarity:          sfMeta[name]?.rarity || sf.rarity,
      collector_number: sfMeta[name]?.collector_number || sf.collector_number,
      market_cents:    li.market_price_cents || 0,
      is_exclusive:    isExclusive,
      formats_60:      formats60,
    };

    if (isExclusive && isLegal60) both.push(entry);
    else if (isExclusive)          cmdExclusive.push(entry);
    else if (isLegal60)            sixtyCardLegal.push(entry);
  }

  console.log("\n");
  console.log(`═══ BLC Card Analysis ═══`);
  console.log(`Commander-exclusive (not in draft boosters): ${cmdExclusive.length + both.length}`);
  console.log(`Legal in 60-card formats:                    ${sixtyCardLegal.length + both.length}`);
  console.log(`Both:                                        ${both.length}`);

  console.log(`\n── Commander-exclusive cards (top 20 by price) ──`);
  [...cmdExclusive, ...both].sort((a,b) => b.market_cents - a.market_cents).slice(0,20).forEach(c =>
    console.log(`  $${(c.market_cents/100).toFixed(2).padStart(6)}  ${c.rarity?.padEnd(12)}  ${c.name}`)
  );

  console.log(`\n── 60-card legal cards (potential 4-copy premium) ──`);
  [...sixtyCardLegal, ...both].sort((a,b) => b.market_cents - a.market_cents).forEach(c =>
    console.log(`  $${(c.market_cents/100).toFixed(2).padStart(6)}  [${c.formats_60.join(", ")}]  ${c.name}`)
  );

  // Write JSON report.
  const report = { cmd_exclusive: [...cmdExclusive, ...both], legal_60: [...sixtyCardLegal, ...both] };
  const outPath = join(__dir, "../frontend/static/data/blc-analysis.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to frontend/static/data/blc-analysis.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
