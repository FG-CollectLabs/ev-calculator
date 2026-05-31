#!/usr/bin/env node
// Patches TMC deck YAML files from a TCGPlayer inventory export CSV.
//
// Writes two fields per matched component:
//   tcgplayer_sku_id     — raw "TCGplayer Id" from the inventory CSV (SKU ID,
//                          used for TCGPlayer mass import/export)
//   tcgplayer_product_id — resolved real productId via tcgcsv.com (correct
//                          for tcgplayer.com/product/XXXX URLs)
//
// Usage: node scripts/patch-tmc-product-ids.js <inventory.csv>

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dir  = dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2];
if (!csvPath) { console.error("Usage: node patch-tmc-product-ids.js <inventory.csv>"); process.exit(1); }

// set_code → TCGCSV groupId (keep in sync with import-deck-csv.cjs)
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
const CACHE_DIR = process.env.TCGCSV_CACHE || "C:/tmp/tcgcsv";

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const f = createWriteStream(dest);
    https.get(url, { headers: { "User-Agent": "ev-calculator-patch-ids/1.0" } }, res => {
      if (res.statusCode !== 200) return reject(new Error(url + " HTTP " + res.statusCode));
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
    }).on("error", reject);
  });
}

async function loadCatalogByName(setCode) {
  const gid = SET_GROUP[setCode];
  if (!gid) return null;
  mkdirSync(CACHE_DIR, { recursive: true });
  const p = join(CACHE_DIR, `g${gid}.csv`);
  const stale = !existsSync(p) || (Date.now() - statSync(p).mtimeMs) > 24 * 3600 * 1000;
  if (stale) {
    await downloadFile(`https://tcgcsv.com/tcgplayer/1/${gid}/ProductsAndPrices.csv`, p);
  }
  const text = await readFile(p, "utf8");
  const parsed = parseCSVRFC(text);
  if (parsed.length < 2) return new Map();
  const headers    = parsed[0];
  const iProductId = headers.indexOf("productId");
  const iName      = headers.indexOf("name");
  const iSubType   = headers.indexOf("subTypeName");

  // Build: norm(name)+finish → productId  (prefer first unique match)
  const byNameFinish = new Map();
  for (const cols of parsed.slice(1)) {
    const pid = (cols[iProductId] || "").trim();
    if (!pid) continue;
    const name   = (cols[iName]    || "").trim();
    const sub    = (cols[iSubType] || "").trim();
    const finish = /foil/i.test(sub) ? "f" : "nf";
    const key    = norm(name) + "|" + finish;
    if (!byNameFinish.has(key)) byNameFinish.set(key, pid);
  }
  return byNameFinish;
}

// RFC-4180 CSV parser (handles quoted fields with embedded commas/newlines).
function parseCSVRFC(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQ = false; }
      } else { cell += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(cell); cell = ""; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; }
      else { cell += c; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// Parse the TCGPlayer inventory CSV.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const fields = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { fields.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    fields.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""]));
  });
}

function norm(name) {
  return name
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s*-\s*.*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── Load inventory CSV ────────────────────────────────────────────────────────
const csvRaw = await readFile(csvPath, "utf8");
const rows   = parseCSV(csvRaw);

const byName     = new Map();
const byNameFoil = new Map();
for (const row of rows) {
  const condition = row["Condition"] || "";
  const isFoil    = condition.toLowerCase().includes("foil");
  const key       = norm(row["Product Name"]);
  if (isFoil) byNameFoil.set(key, row);
  else         byName.set(key, row);
}
console.log(`TCG rows: ${rows.length}, unique non-foil: ${byName.size}, foil: ${byNameFoil.size}`);

// ── Pre-load TCGCSV catalogs for every set code that appears in any deck ─────
const dataDir  = join(__dir, "../data/decks/tmc");
const yamls    = (await readdir(dataDir)).filter(f => f.endsWith(".yaml") && f !== "display.yaml");

// Collect set codes from display_key values across all YAML files.
const setCodesNeeded = new Set(["tmc", "tmt"]); // always include tmc/tmt
for (const yfile of yamls) {
  const content = await readFile(join(dataDir, yfile), "utf8");
  for (const m of content.matchAll(/display_key:\s*\S+-(\w+)-\d+-\w+/g)) {
    setCodesNeeded.add(m[1]);
  }
}

const catalogs = {};
for (const sc of setCodesNeeded) {
  try {
    catalogs[sc] = await loadCatalogByName(sc);
    if (catalogs[sc]) console.log(`  TCGCSV catalog loaded for ${sc} (${catalogs[sc].size} entries)`);
  } catch (e) {
    console.warn(`  Warning: TCGCSV catalog unavailable for ${sc}: ${e.message}`);
    catalogs[sc] = null;
  }
}

// ── Patch each YAML file ──────────────────────────────────────────────────────
let totalUpdated = 0, totalSkipped = 0;

for (const yfile of yamls) {
  const ypath   = join(dataDir, yfile);
  const content = await readFile(ypath, "utf8");
  const lines   = content.split("\n");
  const out     = [];
  let updated   = 0, skipped = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*tcgplayer_product_id:/.test(line)) {
      // Collect context from the preceding ~10 lines.
      let nameVal = "", finish = "", setCode = "";
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (!nameVal) {
          const m = lines[j].match(/^\s*name:\s*"?(.+?)"?\s*$/);
          if (m) nameVal = m[1].trim();
        }
        if (!finish) {
          const mf = lines[j].match(/^\s*finish:\s*(\S+)/);
          if (mf) finish = mf[1];
        }
        if (!setCode) {
          const md = lines[j].match(/display_key:\s*\S+-(\w+)-\d+-\w+/);
          if (md) setCode = md[1];
        }
      }

      const isFoil = finish === "f";
      const key    = norm(nameVal);
      const match  = isFoil
        ? (byNameFoil.get(key) || byName.get(key))
        : (byName.get(key)     || byNameFoil.get(key));

      if (match) {
        const skuId  = match["TCGplayer Id"];
        const indent = line.match(/^(\s*)/)[1];

        // Resolve real productId from TCGCSV by name+finish.
        let productId = null;
        const catalog = catalogs[setCode];
        if (catalog) {
          const ck = norm(nameVal) + "|" + (isFoil ? "f" : "nf");
          productId = catalog.get(ck) || null;
        }

        const oldId = line.match(/:\s*"?(\d+)"?/)?.[1] || "?";
        const newProductId = productId || skuId; // fall back to skuId if TCGCSV miss

        if (productId) {
          if (oldId !== productId) {
            console.log(`  ${yfile}: ${nameVal}  product_id ${oldId} → ${productId}${isFoil ? " (foil)" : ""}`);
            updated++;
          }
        } else {
          console.warn(`  ${yfile}: no TCGCSV match for "${nameVal}" — kept existing product_id`);
          skipped++;
        }

        out.push(`${indent}tcgplayer_product_id: "${newProductId}"`);

        // Write (or update) tcgplayer_sku_id on the very next line.
        const nextLine = lines[i + 1] || "";
        if (/^\s*tcgplayer_sku_id:/.test(nextLine)) {
          // Line already exists — update it.
          const oldSku = nextLine.match(/:\s*"?(\d+)"?/)?.[1] || "?";
          if (oldSku !== skuId) console.log(`  ${yfile}: ${nameVal}  sku_id ${oldSku} → ${skuId}`);
          out.push(`${indent}tcgplayer_sku_id: "${skuId}"`);
          i += 2; // consume both lines
          continue;
        } else {
          // Insert new line.
          out.push(`${indent}tcgplayer_sku_id: "${skuId}"`);
          i++;
          continue;
        }
      } else {
        console.warn(`  SKIP ${yfile}: no TCG match for "${nameVal}" (${isFoil ? "foil" : "non-foil"})`);
        out.push(line);
        skipped++;
      }
    } else {
      out.push(line);
    }
    i++;
  }

  if (updated > 0 || out.join("\n") !== content) {
    await writeFile(ypath, out.join("\n"), "utf8");
    console.log(`  ✓ ${yfile}: ${updated} updated, ${skipped} skipped`);
  } else {
    console.log(`  — ${yfile}: no changes (${skipped} skipped)`);
  }
  totalUpdated += updated;
  totalSkipped += skipped;
}

console.log(`\nDone — ${totalUpdated} product IDs resolved, ${totalSkipped} unmatched.`);
