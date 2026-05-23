#!/usr/bin/env node
// Compare a TCGPlayer Inventory-export CSV against an existing deck YAML.
// Reports cards that are in one but not the other, qty mismatches, and
// name mismatches. Exits non-zero on any difference.
//
//   node scripts/validate-deck-csv.cjs \
//     --csv ~/Downloads/turtle-power-_cards_2026-05-22.csv \
//     --yaml data/decks/tmc/turtle-power.yaml

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else { q = false; } }
      else { cell += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function loadCSV(path) {
  const rows = parseCSV(fs.readFileSync(path, 'utf8')).filter(r => r.some(c => c.length));
  const header = rows.shift();
  const col = (n) => { const i = header.indexOf(n); if (i < 0) throw new Error('Missing column: ' + n); return i; };
  const I = {
    id: col('TCGplayer Id'),
    name: col('Product Name'),
    number: col('Number'),
    cond: col('Condition'),
    total: col('Total Quantity'),
    add: col('Add to Quantity'),
  };
  const out = new Map(); // tcgId -> { name, number, finish, qty }
  for (const r of rows) {
    const id = r[I.id];
    const finish = /foil/i.test(r[I.cond]) ? 'f' : 'nf';
    const qty = parseInt(r[I.total], 10) || parseInt(r[I.add], 10) || 1;
    let name = r[I.name];
    while (true) {
      const next = name.replace(/\s*\([^)]*\)\s*$/, '');
      if (next === name) break;
      name = next;
    }
    name = name.trim();
    if (out.has(id)) { out.get(id).qty += qty; }
    else out.set(id, { name, number: r[I.number].trim(), finish, qty });
  }
  return out;
}

// Crude YAML loader for our deck manifest shape (no deps).
function loadYAML(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = new Map(); // tcgId -> { name, finish, qty, display_key }
  let cur = null;
  let inComponents = false;
  const unquote = (s) => {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return s;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^components:\s*$/.test(line)) { inComponents = true; continue; }
    if (!inComponents) continue;
    const m = line.match(/^(\s*)-\s+display_key:\s*(.+)$/);
    if (m) {
      if (cur && cur.tcgId) out.set(cur.tcgId, cur);
      cur = { display_key: unquote(m[2]) };
      continue;
    }
    if (!cur) continue;
    let mm;
    if ((mm = line.match(/^\s+qty:\s*(.+)$/))) cur.qty = parseInt(unquote(mm[1]), 10);
    else if ((mm = line.match(/^\s+name:\s*(.+)$/))) cur.name = unquote(mm[1]);
    else if ((mm = line.match(/^\s+tcgplayer_product_id:\s*(.+)$/))) cur.tcgId = unquote(mm[1]);
    else if ((mm = line.match(/^\s+finish:\s*(.+)$/))) cur.finish = unquote(mm[1]);
  }
  if (cur && cur.tcgId) out.set(cur.tcgId, cur);
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.csv || !args.yaml) {
    console.error('Usage: validate-deck-csv.cjs --csv <path> --yaml <path>');
    process.exit(2);
  }
  const csv = loadCSV(args.csv);
  const yaml = loadYAML(args.yaml);

  const csvIds = new Set(csv.keys());
  const yamlIds = new Set(yaml.keys());
  const missingInYAML = [...csvIds].filter(id => !yamlIds.has(id));
  const extraInYAML = [...yamlIds].filter(id => !csvIds.has(id));
  const qtyMismatch = [];
  const finishMismatch = [];
  const nameMismatch = [];
  for (const id of csvIds) {
    if (!yamlIds.has(id)) continue;
    const a = csv.get(id), b = yaml.get(id);
    if (a.qty !== b.qty) qtyMismatch.push({ id, csv: a.qty, yaml: b.qty, name: a.name });
    if (a.finish !== b.finish) finishMismatch.push({ id, csv: a.finish, yaml: b.finish, name: a.name });
    if (a.name !== b.name) nameMismatch.push({ id, csv: a.name, yaml: b.name });
  }

  const ok = !missingInYAML.length && !extraInYAML.length && !qtyMismatch.length && !finishMismatch.length;

  console.log(`Deck:       ${args.yaml}`);
  console.log(`CSV:        ${args.csv}`);
  console.log(`CSV rows:   ${csv.size}    YAML rows: ${yaml.size}`);
  console.log('');

  if (missingInYAML.length) {
    console.log(`MISSING in YAML (${missingInYAML.length}) — present in CSV but not in deck manifest:`);
    for (const id of missingInYAML) {
      const c = csv.get(id);
      console.log(`  - [${id}] ${c.name}  (#${c.number}, ${c.finish}, qty=${c.qty})`);
    }
    console.log('');
  }
  if (extraInYAML.length) {
    console.log(`EXTRA in YAML (${extraInYAML.length}) — present in deck manifest but not in CSV:`);
    for (const id of extraInYAML) {
      const y = yaml.get(id);
      console.log(`  - [${id}] ${y.name}  (${y.finish}, qty=${y.qty}, ${y.display_key})`);
    }
    console.log('');
  }
  if (qtyMismatch.length) {
    console.log(`QTY mismatch (${qtyMismatch.length}):`);
    for (const m of qtyMismatch) console.log(`  - [${m.id}] ${m.name}: csv=${m.csv} yaml=${m.yaml}`);
    console.log('');
  }
  if (finishMismatch.length) {
    console.log(`FINISH mismatch (${finishMismatch.length}):`);
    for (const m of finishMismatch) console.log(`  - [${m.id}] ${m.name}: csv=${m.csv} yaml=${m.yaml}`);
    console.log('');
  }
  if (nameMismatch.length) {
    console.log(`NAME differences (${nameMismatch.length}) — informational, ID is authoritative:`);
    for (const m of nameMismatch) console.log(`  - [${m.id}] csv="${m.csv}"  yaml="${m.yaml}"`);
    console.log('');
  }

  console.log(ok ? 'RESULT: OK' : 'RESULT: DIFFERENCES FOUND');
  process.exit(ok ? 0 : 1);
}

main();
