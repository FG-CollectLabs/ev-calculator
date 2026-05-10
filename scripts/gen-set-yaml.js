#!/usr/bin/env node
// gen-set-yaml.js — generate ev-calculator deck YAMLs for any MTG commander set.
//
// Usage:
//   node scripts/gen-set-yaml.js <SETCODE> [options]
//
// Options:
//   --name "Display Name"   Human name for the display (e.g. "Bloomburrow Commander Case")
//   --case-product <id>     TCGPlayer product ID for the full case (if it exists)
//   --set-of-n-product <id> TCGPlayer product ID for a set-of-N product
//   --sets-of-n <count>     How many of that product make a case (default 1)
//   --copies <n>            Copies of each deck in a case (default: auto from MTGJSON)
//   --out <dir>             Parent output dir; writes to <dir>/<setcode_lower>/ (default: data/decks)
//   --dry-run               Print YAML to stdout, don't write files
//
// Data sources:
//   MTGJSON: https://mtgjson.com/api/v5/<SET>.json   (deck compositions)
//   TCGCSV:  https://tcgcsv.com/tcgplayer/1/<gid>/products  (TCGPlayer product IDs)
//
// The script downloads data files to c:/tmp/ev-gen/ for caching.

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: node scripts/gen-set-yaml.js <SETCODE> [--name "..."] [--case-product <id>] [--set-of-n-product <id>] [--sets-of-n <n>] [--out <dir>] [--dry-run]');
  process.exit(0);
}
const setCode = args[0].toUpperCase();
const opt = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    opt[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}

const displayName  = opt['name'] || `${setCode} Commander Case`;
const caseProductID = opt['case-product'] || '';
const setOfNProduct = opt['set-of-n-product'] || '';
const setsOfN       = parseInt(opt['sets-of-n'] || '1', 10);
const forceCopies   = opt['copies'] ? parseInt(opt['copies'], 10) : null;
const dryRun        = !!opt['dry-run'];
const outDir        = opt['out'] ? path.join(opt['out'], setCode.toLowerCase()) : path.join('data', 'decks', setCode.toLowerCase());

const cacheDir = 'c:/tmp/ev-gen';
fs.mkdirSync(cacheDir, { recursive: true });
if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ev-calculator-gen/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchCached(url, cacheKey) {
  const file = path.join(cacheDir, cacheKey);
  if (fs.existsSync(file)) {
    console.error(`[cache] ${cacheKey}`);
    return fs.readFileSync(file, 'utf8');
  }
  console.error(`[fetch] ${url}`);
  const body = await fetchURL(url);
  fs.writeFileSync(file, body);
  return body;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function yamlStr(s) {
  if (s == null) return '';
  if (/[:#&*!|>'"%@`{}\[\],?]|^\s|\s$|^-/.test(String(s))) return JSON.stringify(s);
  return String(s);
}

function emit(lines, indent, ...parts) {
  lines.push(indent + parts.join(''));
}

// ── Fetch MTGJSON set data ────────────────────────────────────────────────────
async function getMTGJSONDecks(setCode) {
  const url = `https://mtgjson.com/api/v5/${setCode}.json`;
  const raw = await fetchCached(url, `mtgjson-${setCode}.json`);
  const data = JSON.parse(raw).data;
  if (!data || !data.decks || !data.decks.length) {
    throw new Error(`No decks found in MTGJSON for ${setCode}`);
  }

  // Build uuid → card info map from the set's card list.
  const uuidMap = {};
  for (const card of (data.cards || [])) {
    uuidMap[card.uuid] = card;
  }

  // Resolve any missing UUIDs from sourceSetCodes (reprints from the base set).
  const sourceSets = new Set();
  for (const deck of data.decks) {
    for (const sc of (deck.sourceSetCodes || [])) sourceSets.add(sc.toUpperCase());
  }
  sourceSets.delete(setCode); // already loaded
  for (const sc of sourceSets) {
    try {
      const srcURL = `https://mtgjson.com/api/v5/${sc}.json`;
      const srcRaw = await fetchCached(srcURL, `mtgjson-${sc}.json`);
      const srcData = JSON.parse(srcRaw).data;
      for (const card of (srcData.cards || [])) {
        if (!uuidMap[card.uuid]) uuidMap[card.uuid] = card;
      }
    } catch (e) {
      console.error(`  [warn] Could not fetch sourceSet ${sc}: ${e.message}`);
    }
  }

  // MTGJSON deck cards are in mainBoard, commander, sideBoard sections.
  // Each entry: {uuid, count, isFoil}
  // Resolve to {name, number, setCode, count, finish}
  const decks = data.decks.map(deck => {
    const sections = [
      { cards: deck.commander || [], section: 'commander' },
      { cards: deck.mainBoard || [], section: 'main' },
      { cards: deck.sideBoard || [], section: 'side' },
    ];
    const resolvedCards = [];
    for (const { cards, section } of sections) {
      for (const entry of cards) {
        const info = uuidMap[entry.uuid];
        if (!info) {
          console.error(`  [warn] UUID not in any set card list: ${entry.uuid}`);
          continue;
        }
        // Determine finish: isFoil=true → foil; otherwise check available finishes
        let finish = 'nonfoil';
        if (entry.isFoil) finish = 'foil';
        else if (info.finishes && info.finishes.length === 1) finish = info.finishes[0];
        // Cards from a source set (e.g. BLB reprints in BLC) keep their original
        // set code and number for display_key, but are looked up in the primary
        // set's product list by name since they're physically printed in this set.
        resolvedCards.push({
          name:          info.name,
          number:        info.number,
          setCode:       info.setCode || setCode,
          primarySet:    setCode, // always search primary set's TCGCSV products first
          count:         entry.count || 1,
          finish,
          section,
          isCommander:   section === 'commander',
          isReprintFromSource: (info.setCode || setCode).toUpperCase() !== setCode.toUpperCase(),
        });
      }
    }
    return { name: deck.name, cards: resolvedCards };
  });

  return decks;
}

// ── Fetch TCGCSV group ID for a set ──────────────────────────────────────────
async function getGroupID(setAbbrev) {
  const raw = await fetchCached('https://tcgcsv.com/tcgplayer/1/groups', 'tcgcsv-groups.json');
  const groups = JSON.parse(raw).results;
  const match = groups.find(g => g.abbreviation === setAbbrev);
  if (!match) {
    // Try case-insensitive
    const ci = groups.find(g => g.abbreviation.toUpperCase() === setAbbrev.toUpperCase());
    if (!ci) {
      const nearby = groups.filter(g => g.name.toLowerCase().includes(setAbbrev.toLowerCase())).slice(0, 5);
      console.error(`No group found for ${setAbbrev}. Nearby matches:`);
      nearby.forEach(g => console.error(`  ${g.abbreviation}: ${g.name} (id=${g.groupId})`));
      throw new Error(`Unknown set abbreviation: ${setAbbrev}`);
    }
    return ci.groupId;
  }
  return match.groupId;
}

// ── Fetch TCGCSV products for a group ────────────────────────────────────────
async function getProducts(groupID) {
  const url = `https://tcgcsv.com/tcgplayer/1/${groupID}/products`;
  const raw = await fetchCached(url, `tcgcsv-products-${groupID}.json`);
  return JSON.parse(raw).results; // [{productId, name, number, ...}]
}

// ── Build a number→productId map from TCGCSV products ────────────────────────
// TCGCSV products store the collector number in extendedData, not as a top-level field.
// Foil treatments (Raised Foil, Etched Foil, etc.) are encoded in the product name.
function buildProductMap(products) {
  const byNum  = {}; // "num|foil?" -> productId  (foil? = true/false)
  const byName = {}; // "cleanname|foil?" -> productId

  for (const p of products) {
    // Extract number from extendedData
    let num = '';
    if (p.extendedData) {
      const nd = p.extendedData.find(e => e.name === 'Number');
      if (nd) num = String(nd.value || '').replace(/[★✦\s]/g, '').toLowerCase();
    }

    // Determine if foil by name patterns (TCGCSV doesn't have a separate Finish field in products)
    const isFoil = /foil|etched/i.test(p.name || '');
    const fKey   = isFoil ? '1' : '0';

    if (num) byNum[`${num}|${fKey}`] = String(p.productId);

    // Normalize card name: strip "(Borderless)", "(Showcase)", etc. for fallback matching.
    const baseName = (p.name || '').replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
    if (baseName) byName[`${baseName}|${fKey}`] = String(p.productId);
  }
  return { byNum, byName };
}

function lookupProductID(productMaps, collectorNum, finish, cardName) {
  const { byNum, byName } = productMaps;
  const isFoil = finish === 'f' || finish === 'e' ? '1' : '0';
  const num = String(collectorNum || '').replace(/[★✦\s]/g, '').toLowerCase();
  const name = (cardName || '').toLowerCase();

  // Priority: number-based always beats name-based to avoid wrong variant (e.g. raised foil #101 vs precon foil #1).
  // 1. Exact number + finish
  if (num && byNum[`${num}|${isFoil}`]) return byNum[`${num}|${isFoil}`];
  // 2. Number + nonfoil fallback (precon foils that aren't labeled "foil" on TCGPlayer)
  if (num && isFoil === '1' && byNum[`${num}|0`]) return byNum[`${num}|0`];
  // 3. Name + finish (only when no collector number available)
  if (name && byName[`${name}|${isFoil}`]) return byName[`${name}|${isFoil}`];
  // 4. Name + nonfoil fallback
  if (name && byName[`${name}|0`]) return byName[`${name}|0`];
  return '';
}

function findSealedProductID(products, deckName, setCode) {
  const patterns = [
    `${setCode} Commander Deck - ${deckName}`,
    `Commander Deck - ${deckName}`,
    deckName,
  ];
  for (const pat of patterns) {
    const hit = products.find(p => p.name && p.name.toLowerCase() === pat.toLowerCase());
    if (hit) return String(hit.productId);
  }
  // Partial match
  const lower = deckName.toLowerCase();
  const hit = products.find(p => p.name && p.name.toLowerCase().includes(lower) && p.name.toLowerCase().includes('commander deck'));
  return hit ? String(hit.productId) : '';
}

// ── MTGJSON finish -> our finish code ─────────────────────────────────────────
const FINISH_MAP = { nonfoil: 'nf', foil: 'f', etched: 'e' };

// ── Generate YAML for one deck ────────────────────────────────────────────────
function buildDeckYAML(deck, setCode, productMaps, products, seenSets) {
  const slug    = slugify(deck.name);
  const setLow  = setCode.toLowerCase();
  const key     = `${setLow}-commander-${slug}`;
  const prodKey = `mtg-${setLow}-commander-${slug}`;
  const sealedID = findSealedProductID(products, deck.name, setCode);

  const lines = [
    `key: ${key}`,
    `name: ${yamlStr(deck.name)}`,
    `game: mtg`,
    `set_code: ${setLow}`,
    `product_display_key: ${prodKey}`,
  ];
  if (sealedID) lines.push(`product_tcgplayer_id: "${sealedID}"`);
  lines.push(`channels: [tcgplayer, manapool]`);
  lines.push(`components:`);

  for (const card of (deck.cards || [])) {
    const finish   = FINISH_MAP[card.finish] || 'nf';
    const cardSet  = (card.setCode || setCode).toUpperCase();
    const num      = String(card.number || card.collectorNumber || '').replace(/\s+/g, '');
    if (!num) continue;

    const dk = `mtg-${cardSet.toLowerCase()}-${num}-${finish}`;
    let productID = '';

    // For reprints from a source set (e.g. BLB cards in a BLC deck): they're
    // physically printed in BLC with BLC product IDs, so look up by name in
    // the primary set's products first.
    productID = lookupProductID(productMaps, card.isReprintFromSource ? '' : num, finish, card.name);
    if (!productID && seenSets[cardSet]) {
      productID = lookupProductID(seenSets[cardSet], num, finish, card.name);
    }

    lines.push(`  - display_key: ${dk}`);
    lines.push(`    qty: ${card.count || 1}`);
    lines.push(`    name: ${yamlStr(card.name)}`);
    if (productID) lines.push(`    tcgplayer_product_id: "${productID}"`);
    lines.push(`    finish: ${finish}`);
    if (card.isCommander || card.section === 'commander') lines.push(`    note: commander`);
  }

  return { filename: `${slug}.yaml`, content: lines.join('\n') + '\n', key, deckName: deck.name };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.error(`Generating YAMLs for ${setCode}...`);

    // Fetch data
    const [mtgDecks, groupID] = await Promise.all([
      getMTGJSONDecks(setCode),
      getGroupID(setCode),
    ]);
    console.error(`MTGJSON: ${mtgDecks.length} decks | TCGCSV group: ${groupID}`);

    const products    = await getProducts(groupID);
    const productMaps = buildProductMap(products);

    // For reprints from other sets: fetch their products too if needed
    const seenSets = {};
    const allSets = new Set();
    for (const deck of mtgDecks) {
      for (const card of (deck.cards || [])) {
        if (card.setCode && card.setCode !== setCode) allSets.add(card.setCode.toUpperCase());
      }
    }
    for (const s of allSets) {
      try {
        const gid = await getGroupID(s);
        const prods = await getProducts(gid);
        seenSets[s] = buildProductMap(prods);
      } catch (e) {
        console.error(`  [warn] Could not fetch products for reprint set ${s}: ${e.message}`);
      }
    }

    // Generate deck YAMLs
    const deckEntries = [];
    for (const deck of mtgDecks) {
      const { filename, content, key, deckName } = buildDeckYAML(deck, setCode, productMaps, products, seenSets);
      deckEntries.push({ key, deckName, filename });
      if (dryRun) {
        console.log(`\n# === ${filename} ===`);
        console.log(content);
      } else {
        fs.writeFileSync(path.join(outDir, filename), content);
        console.log(`wrote ${filename}`);
      }
    }

    // Determine copies per deck (commander cases are usually 4 decks: 2 unique × 2 copies, or 4 unique × 1 copy)
    const deckCount = deckEntries.length;
    const copies = forceCopies || (deckCount === 2 ? 2 : 1);

    // Generate display.yaml
    const dispLines = [
      `key: ${setCode.toLowerCase()}-commander-display`,
      `name: ${yamlStr(displayName)}`,
      `game: mtg`,
      `set_code: ${setCode.toLowerCase()}`,
      `type: commander_case`,
      `product_display_key: mtg-${setCode.toLowerCase()}-commander-display`,
    ];
    if (caseProductID) {
      dispLines.push(`product_tcgplayer_id: "${caseProductID}"`);
    } else if (setOfNProduct) {
      dispLines.push(`product_set_of_n_tcgplayer_id: "${setOfNProduct}"`);
      dispLines.push(`sets_of_n_per_case: ${setsOfN}`);
    }
    dispLines.push('');
    dispLines.push('decks:');
    for (const { key } of deckEntries) {
      dispLines.push(`  - deck_key: ${key}`);
      dispLines.push(`    copies: ${copies}`);
    }
    dispLines.push('');
    dispLines.push('extra_components: []');

    if (dryRun) {
      console.log('\n# === display.yaml ===');
      console.log(dispLines.join('\n'));
    } else {
      fs.writeFileSync(path.join(outDir, 'display.yaml'), dispLines.join('\n') + '\n');
      console.log('wrote display.yaml');
    }

    console.error('\nDone. Review generated files and:');
    console.error('  1. Add product_manapool_slug to each deck YAML');
    console.error('  2. Add image: /img/decks/<filename>.jpg to each deck YAML');
    console.error('  3. Download deck images and place in frontend/static/img/decks/');
    console.error('  4. Update display.yaml with correct case/set-of-N product ID');
    if (!caseProductID && !setOfNProduct) {
      console.error('  NOTE: No case product ID was provided. Edit display.yaml to add one.');
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
