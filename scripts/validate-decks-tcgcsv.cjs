#!/usr/bin/env node
// Validate every deck YAML's `tcgplayer_product_id` against the authoritative
// product catalog at tcgcsv.com. Catches the common bug where the importer
// stored TCGPlayer **SKU IDs** (printing+condition+lang composite) in the
// productId field. For each row that's wrong, suggests the correct productId
// looked up by (set group, collector number, name).
//
// Usage: node scripts/validate-decks-tcgcsv.cjs [--fix]
//   --fix   rewrite YAMLs in place with corrected productIds (only rows where
//           the lookup is unambiguous; leaves ambiguous rows untouched)

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', 'data', 'decks');
const CACHE_DIR = process.env.TCGCSV_CACHE || 'C:/tmp/tcgcsv';

// set_code (used in display_key) → TCGCSV groupId
const SET_GROUP = {
  drc: 23929, dft: 23874,
  blc: 23448, blb: 23447,
  eoc: 24236, eoe: 24233,
  fic: 24220, fin: 24219,
  lcc: 23316, lci: 23312,
  ltc: 23071, ltr: 23019,
  tdc: 24234, tdm: 24232,
  tmc: 24496, tmt: 24495,
};

const FIX = process.argv.includes('--fix');

function get(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'ev-calculator-deck-validator/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(url + ' HTTP ' + res.statusCode));
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

async function loadGroupProducts(groupId) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = path.join(CACHE_DIR, `g${groupId}.csv`);
  if (!fs.existsSync(p) || (Date.now() - fs.statSync(p).mtimeMs) > 24*3600*1000) {
    await get(`https://tcgcsv.com/tcgplayer/1/${groupId}/ProductsAndPrices.csv`, p);
  }
  return parseCSV(fs.readFileSync(p, 'utf8'));
}

function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1]==='"') { cell+='"'; i++; } else q = false; } else cell += c; }
    else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return { byId: new Map(), byNumber: new Map() };
  const h = rows.shift();
  const I = {
    productId: h.indexOf('productId'),
    name:      h.indexOf('name'),
    subType:   h.indexOf('subTypeName'),  // "Foil" / "Normal"
    rarity:    h.indexOf('extRarity'),
    number:    h.indexOf('extNumber'),
  };
  const byId = new Map();         // productId -> {name, number, finishes:Set}
  const byNumber = new Map();     // number -> Array<{productId,name,finish}>
  for (const r of rows) {
    const pid = r[I.productId];
    if (!pid) continue;
    const name = r[I.name];
    const number = (r[I.number] || '').trim();
    const finish = /foil/i.test(r[I.subType]) ? 'f' : 'nf';
    let rec = byId.get(pid);
    if (!rec) { rec = { name, number, finishes: new Set() }; byId.set(pid, rec); }
    rec.finishes.add(finish);
    if (number) {
      if (!byNumber.has(number)) byNumber.set(number, []);
      // collapse duplicate price rows for the same product
      const arr = byNumber.get(number);
      if (!arr.some(x => x.productId === pid && x.finish === finish)) {
        arr.push({ productId: pid, name, finish });
      }
    }
  }
  return { byId, byNumber };
}

function parseDeckYAML(p) {
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/);
  const rows = []; let cur = null;
  const unquote = (s) => { s = s.trim(); if ((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'"))) return s.slice(1,-1).replace(/\\"/g,'"'); return s; };
  for (let i=0;i<lines.length;i++) {
    const raw = lines[i];
    const m = raw.match(/^(\s*)-\s+display_key:\s*(.+?)\s*$/);
    if (m) {
      if (cur) rows.push(cur);
      cur = { display_key: unquote(m[2]), startLine: i };
      const dk = unquote(m[2]).match(/^mtg-([a-z0-9]+)-([^-]+)-([fn]f?)$/);
      if (dk) { cur.set = dk[1]; cur.number = dk[2]; cur.finish = dk[3] === 'f' ? 'f' : 'nf'; }
      continue;
    }
    if (!cur) continue;
    let mm;
    if ((mm = raw.match(/^\s+qty:\s*(.+)$/))) cur.qty = parseInt(unquote(mm[1]),10);
    else if ((mm = raw.match(/^\s+name:\s*(.+)$/))) cur.name = unquote(mm[1]);
    else if ((mm = raw.match(/^\s+tcgplayer_product_id:\s*(.+)$/))) { cur.tcgIdLine = i; cur.tcgIdRaw = mm[1]; cur.tcgId = unquote(mm[1]); }
    else if ((mm = raw.match(/^\s+finish:\s*(.+)$/))) cur.finishField = unquote(mm[1]);
  }
  if (cur) rows.push(cur);
  return { lines, rows };
}

function findDecks(root) {
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const dp = path.join(root, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const f of fs.readdirSync(dp)) {
      if (f.endsWith('.yaml') && f !== 'display.yaml') out.push(path.join(dp, f));
    }
  }
  return out;
}

(async function main() {
  const decks = findDecks(ROOT);
  console.log(`Loading TCGCSV catalogs for ${Object.keys(SET_GROUP).length} sets...`);
  const catalogs = {};
  for (const [code, gid] of Object.entries(SET_GROUP)) {
    try { catalogs[code] = await loadGroupProducts(gid); }
    catch (e) { console.error(`  ${code} (group ${gid}): ${e.message}`); catalogs[code] = null; }
  }
  console.log('');

  const summary = [];
  for (const deck of decks) {
    const { lines, rows } = parseDeckYAML(deck);
    const total = rows.length;
    let okIds = 0, missingPid = 0, wrongPid = 0, ambiguous = 0, fixedRows = 0;
    const issues = [];
    for (const r of rows) {
      if (!r.tcgId || !r.set) continue;
      const cat = catalogs[r.set];
      if (!cat) { issues.push({ row:r, kind:'no-catalog' }); missingPid++; continue; }
      if (cat.byId.has(r.tcgId)) {
        const cur = cat.byId.get(r.tcgId);
        if (cur.number && r.number && cur.number !== r.number) {
          issues.push({ row:r, kind:'number-mismatch', cur });
          wrongPid++;
        } else {
          okIds++;
        }
        continue;
      }
      // Not a productId in this group's catalog. Look up by (number, finish).
      let cands = (cat.byNumber.get(r.number) || []).filter(c => c.finish === r.finish);
      // Disambiguate by name when multiple candidates share the number (e.g.
      // regular printing + Boss-token both numbered 7 in TMC).
      if (cands.length > 1 && r.name) {
        const lc = r.name.toLowerCase();
        // Strip TCGCSV's parenthetical suffixes for comparison.
        const stripParens = (s) => { let x=s; while(true){const n=x.replace(/\s*\([^)]*\)\s*$/, ''); if(n===x) break; x=n;} return x.trim().toLowerCase(); };
        const byName = cands.filter(c => stripParens(c.name) === lc || c.name.toLowerCase().startsWith(lc));
        if (byName.length === 1) cands = byName;
      }
      if (cands.length === 1) {
        issues.push({ row:r, kind:'wrong-id', correct: cands[0] });
        wrongPid++;
      } else if (cands.length > 1) {
        issues.push({ row:r, kind:'ambiguous', cands });
        ambiguous++;
      } else {
        issues.push({ row:r, kind:'not-found' });
        missingPid++;
      }
    }

    const rel = path.relative(ROOT, deck).replace(/\\/g,'/');
    const verdict = (wrongPid + missingPid + ambiguous) === 0 ? 'OK' : 'FAIL';
    summary.push({ deck: rel, total, okIds, wrongPid, missingPid, ambiguous, verdict });

    if (verdict !== 'OK') {
      console.log(`── ${rel}  [${verdict}]  total=${total} ok=${okIds} wrong=${wrongPid} missing=${missingPid} ambiguous=${ambiguous}`);
      for (const x of issues.slice(0, 10)) {
        if (x.kind === 'wrong-id') console.log(`   wrong-id #${x.row.number} ${x.row.name}  yaml=${x.row.tcgId}  correct=${x.correct.productId} (${x.correct.name})`);
        else if (x.kind === 'number-mismatch') console.log(`   number-mismatch #${x.row.number} yaml=${x.row.tcgId} → catalog has it as #${x.cur.number} (${x.cur.name})`);
        else if (x.kind === 'ambiguous') console.log(`   ambiguous #${x.row.number} ${x.row.name}  cands=${x.cands.map(c=>c.productId).join(',')}`);
        else if (x.kind === 'not-found') console.log(`   not-found #${x.row.number} ${x.row.name}  (yaml id ${x.row.tcgId} not in ${r=>0,r=r=null,''}${x.row.set} catalog and no #${x.row.number}/${x.row.finish} match)`);
        else if (x.kind === 'no-catalog') console.log(`   no-catalog for set ${x.row.set}`);
      }
      if (issues.length > 10) console.log(`   ... +${issues.length-10} more`);
    }

    if (FIX && verdict !== 'OK') {
      const newLines = lines.slice();
      let n = 0;
      for (const x of issues) {
        if (x.kind === 'wrong-id') {
          const ln = x.row.tcgIdLine;
          newLines[ln] = newLines[ln].replace(/tcgplayer_product_id:\s*"?\d+"?/, `tcgplayer_product_id: "${x.correct.productId}"`);
          n++;
        }
      }
      if (n) {
        fs.writeFileSync(deck, newLines.join('\n'));
        fixedRows = n;
        console.log(`   --fix: rewrote ${n} productId(s) in ${rel}`);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  const w = (s,n) => String(s).padEnd(n);
  console.log(w('deck',55), w('total',6), w('ok',6), w('wrong',6), w('missing',8), w('ambig',6), 'verdict');
  for (const s of summary) {
    console.log(w(s.deck,55), w(s.total,6), w(s.okIds,6), w(s.wrongPid,6), w(s.missingPid,8), w(s.ambiguous,6), s.verdict);
  }
  const fails = summary.filter(s => s.verdict !== 'OK').length;
  console.log(`\n${summary.length - fails}/${summary.length} OK, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})();
