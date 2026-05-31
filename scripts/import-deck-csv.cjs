#!/usr/bin/env node
// Convert a TCGPlayer Inventory-export CSV into a deck manifest YAML
// matching the schema under data/decks/{set}/{deck}.yaml.
//
// IMPORTANT: The CSV's "TCGplayer Id" column is a **SKU ID** (encodes
// printing+condition+language), NOT the productId that market-tracker
// indexes on. This script resolves each row to the correct productId by
// looking up (set group, collector number, finish, name) against
// tcgcsv.com, then writing the productId into tcgplayer_product_id.
// See scripts/validate-decks-tcgcsv.cjs for the corresponding validator.
//
// Example:
//   node scripts/import-deck-csv.js \
//     --csv ~/Downloads/turtle-power-_cards_2026-05-22.csv \
//     --out data/decks/tmc/turtle-power.yaml \
//     --key tmc-commander-turtle-power \
//     --name "Turtle Power!" \
//     --set-code tmc \
//     --tcg-set-name "Commander: Teenage Mutant Ninja Turtles" \
//     --product-display-key mtg-tmc-commander-turtle-power \
//     --product-tcgplayer-id 657865 \
//     --image /img/decks/tmc-commander-turtle-power.jpg \
//     --channels tcgplayer,manapool \
//     --set-map "Commander: Teenage Mutant Ninja Turtles=tmc,Teenage Mutant Ninja Turtles=tmt"

const fs = require('fs');
const path = require('path');
const https = require('https');

// set_code (used in display_key) → TCGCSV groupId. The CSV's "TCGplayer Id"
// column is actually a **skuId** (printing+condition+lang composite), not the
// productId that market-tracker indexes on, so we look up the real productId
// from tcgcsv.com for each row by (number, finish, name).
const SET_GROUP = {
  drc: 23929, dft: 23874,
  blc: 23448, blb: 23447,
  eoc: 24236, eoe: 24233,
  fic: 24220, fin: 24219,
  lcc: 23316, lci: 23312,
  ltc: 23071, ltr: 23019,
  mkc: 23363, mkm: 23363,
  otc: 23440, otj: 23439,
  pip: 23337,
  tdc: 24234, tdm: 24232,
  tmc: 24496, tmt: 24495,
  who: 23165,
};
const CACHE_DIR = process.env.TCGCSV_CACHE || 'C:/tmp/tcgcsv';

function downloadSync(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'ev-calculator-deck-importer/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(url + ' HTTP ' + res.statusCode));
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

async function loadCatalog(setCode) {
  const gid = SET_GROUP[setCode];
  if (!gid) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = path.join(CACHE_DIR, `g${gid}.csv`);
  if (!fs.existsSync(p) || (Date.now() - fs.statSync(p).mtimeMs) > 24*3600*1000) {
    await downloadSync(`https://tcgcsv.com/tcgplayer/1/${gid}/ProductsAndPrices.csv`, p);
  }
  const text = fs.readFileSync(p, 'utf8');
  const rows = parseCSV(text).filter(r => r.some(c => c.length));
  const h = rows.shift();
  const I = {
    productId: h.indexOf('productId'),
    name:      h.indexOf('name'),
    subType:   h.indexOf('subTypeName'),
    number:    h.indexOf('extNumber'),
  };
  const byNumber = new Map(); // number -> Array<{productId,name,finish}>
  const seen = new Set();
  for (const r of rows) {
    const pid = r[I.productId]; if (!pid) continue;
    const number = (r[I.number] || '').trim();
    const finish = /foil/i.test(r[I.subType]) ? 'f' : 'nf';
    const k = pid + '|' + finish;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push({ productId: pid, name: r[I.name], finish });
  }
  return byNumber;
}

function lookupProductId(catalog, number, finish, name) {
  if (!catalog) return null;
  let cands = (catalog.get(number) || []).filter(c => c.finish === finish);
  if (cands.length > 1 && name) {
    const lc = name.toLowerCase();
    const strip = (s) => { let x=s; while(true){const n=x.replace(/\s*\([^)]*\)\s*$/, ''); if(n===x) break; x=n;} return x.trim().toLowerCase(); };
    const byName = cands.filter(c => strip(c.name) === lc || c.name.toLowerCase().startsWith(lc));
    if (byName.length === 1) cands = byName;
  }
  return cands.length === 1 ? cands[0].productId : null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// Minimal RFC-4180 CSV parser sufficient for TCGPlayer exports
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else { cell += c; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function quoteYAMLString(s) {
  // Match existing manifest style: quote when needed, otherwise bare.
  if (s === '') return '""';
  const needsQuote = /[:#,&*?{}\[\]|>!%@`'"]/.test(s)
    || /^\s|\s$/.test(s)
    || /^(true|false|null|yes|no|on|off|~)$/i.test(s)
    || /^-?\d/.test(s);
  if (!needsQuote) return s;
  // Prefer double quotes; escape backslash and double-quote
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function main() {
  const args = parseArgs(process.argv);
  const required = ['csv', 'out', 'key', 'name', 'set-code', 'tcg-set-name',
                    'product-display-key', 'product-tcgplayer-id', 'image'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error('Missing required flags: ' + missing.map(m => '--' + m).join(', '));
    process.exit(1);
  }

  const game = args.game || 'mtg';
  const channels = (args.channels || 'tcgplayer,manapool').split(',').map(s => s.trim());

  // Set-name → set-code map (used for the per-row display_key prefix).
  // The deck's primary set_code is the fallback when a row's Set Name isn't mapped.
  const setMap = { [args['tcg-set-name']]: args['set-code'] };
  if (args['set-map']) {
    for (const pair of args['set-map'].split(',')) {
      const [k, v] = pair.split('=').map(s => s.trim());
      if (k && v) setMap[k] = v;
    }
  }

  const raw = fs.readFileSync(args.csv, 'utf8');
  const rows = parseCSV(raw).filter(r => r.some(c => c.length));
  const header = rows.shift();
  const col = (name) => {
    const idx = header.indexOf(name);
    if (idx < 0) throw new Error('CSV missing column: ' + name);
    return idx;
  };
  const I = {
    id: col('TCGplayer Id'),
    setName: col('Set Name'),
    productName: col('Product Name'),
    number: col('Number'),
    condition: col('Condition'),
    total: col('Total Quantity'),
    add: col('Add to Quantity'),
  };

  const unmapped = new Set();
  const components = rows.map(r => {
    const setName = r[I.setName];
    const setCode = setMap[setName];
    if (!setCode) unmapped.add(setName);
    const finish = /foil/i.test(r[I.condition]) ? 'f' : 'nf';
    const number = r[I.number].trim();
    const qty = parseInt(r[I.total], 10) || parseInt(r[I.add], 10) || 1;
    // Strip TCGPlayer parenthetical suffixes from the printed name for the
    // manifest `name` field, e.g. "Heroes in a Half Shell (0006) (Borderless)"
    // → "Heroes in a Half Shell". Identification matches against this.
    // Strip *all* trailing parenthetical suffixes, e.g.
    // "Heroes in a Half Shell (0006) (Borderless)" → "Heroes in a Half Shell".
    let cleanName = r[I.productName];
    while (true) {
      const next = cleanName.replace(/\s*\([^)]*\)\s*$/, '');
      if (next === cleanName) break;
      cleanName = next;
    }
    cleanName = cleanName.trim();
    return {
      setName,
      setCode: setCode || args['set-code'],
      skuId: r[I.id], // CSV column is misnamed — it's the skuId, not productId
      number,
      finish,
      qty,
      name: cleanName,
      rawName: r[I.productName],
    };
  });

  // Resolve real productIds from TCGCSV per-row (CSV's "TCGplayer Id" is a skuId).
  const catalogs = {};
  for (const setCode of new Set(components.map(c => c.setCode))) {
    try { catalogs[setCode] = await loadCatalog(setCode); }
    catch (e) { console.error(`Warning: TCGCSV catalog for ${setCode} unavailable (${e.message}); rows in this set will fall back to skuId`); catalogs[setCode] = null; }
  }
  let unresolved = 0;
  for (const c of components) {
    const pid = lookupProductId(catalogs[c.setCode], c.number, c.finish, c.name);
    if (pid) c.tcgId = pid;
    else { c.tcgId = c.skuId; unresolved++; console.error(`  unresolved productId: ${c.setCode} #${c.number} (${c.finish}) "${c.name}" — kept skuId ${c.skuId}`); }
  }
  if (unresolved) console.error(`Warning: ${unresolved}/${components.length} rows kept skuId fallback (not a real TCGPlayer productId — pricing will miss).`);

  if (unmapped.size) {
    console.error('Warning: Set Name(s) not in --set-map (using deck set_code as fallback):');
    for (const s of unmapped) console.error('  - ' + s);
  }

  // Order: foils first, then by set code, then by collector number ascending.
  components.sort((a, b) => {
    if (a.finish !== b.finish) return a.finish === 'f' ? -1 : 1;
    if (a.setCode !== b.setCode) return a.setCode.localeCompare(b.setCode);
    const an = parseInt(a.number, 10);
    const bn = parseInt(b.number, 10);
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
    return a.number.localeCompare(b.number);
  });

  const lines = [];
  lines.push(`key: ${args.key}`);
  lines.push(`name: ${quoteYAMLString(args.name)}`);
  lines.push(`game: ${game}`);
  lines.push(`set_code: ${args['set-code']}`);
  lines.push(`tcg_set_name: ${quoteYAMLString(args['tcg-set-name'])}`);
  lines.push(`product_display_key: ${args['product-display-key']}`);
  lines.push(`product_tcgplayer_id: "${args['product-tcgplayer-id']}"`);
  lines.push(`image: ${args.image}`);
  lines.push(`channels: [${channels.join(', ')}]`);
  lines.push(`components:`);
  lines.push(`  # Generated from ${path.basename(args.csv)} by scripts/import-deck-csv.js`);

  let lastGroup = null;
  for (const c of components) {
    const group = `${c.finish}/${c.setCode}`;
    if (group !== lastGroup) {
      const label = c.finish === 'f'
        ? `Foil — ${c.setCode.toUpperCase()}`
        : `Non-foil — ${c.setCode.toUpperCase()}`;
      lines.push(`  # ── ${label} ─────────────────────────────────────────────`);
      lastGroup = group;
    }
    const displayKey = `${game}-${c.setCode}-${c.number}-${c.finish}`;
    lines.push(`  - display_key: ${displayKey}`);
    lines.push(`    qty: ${c.qty}`);
    lines.push(`    name: ${quoteYAMLString(c.name)}`);
    lines.push(`    tcgplayer_product_id: "${c.tcgId}"`);
    lines.push(`    tcgplayer_sku_id: "${c.skuId}"`);
    lines.push(`    finish: ${c.finish}`);
  }

  const out = lines.join('\n') + '\n';
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, out, 'utf8');
  console.log(`Wrote ${components.length} components → ${args.out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
