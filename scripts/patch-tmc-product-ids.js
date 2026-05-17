#!/usr/bin/env node
// Patches TMC deck YAML files with correct TCGPlayer product IDs
// from a TCGPlayer inventory export CSV.
// Usage: node scripts/patch-tmc-product-ids.js <inventory.csv>

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir  = dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2];
if (!csvPath) { console.error("Usage: node patch-tmc-product-ids.js <inventory.csv>"); process.exit(1); }

// Parse the TCGPlayer CSV.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas.
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

// Normalise a card name for fuzzy matching:
// strip (Borderless), alt-print suffixes, trailing spaces.
function norm(name) {
  return name
    .replace(/\s*\(.*?\)\s*/g, "")   // remove anything in parens
    .replace(/\s*-\s*.*$/g, "")       // remove "- Alt Name" suffix (Slash Clone - Steelbane Hydra)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const csvRaw = await readFile(csvPath, "utf8");
const rows   = parseCSV(csvRaw);

// Build lookup: normalised name → { pid, price, condition }
// Prefer non-foil if both exist; store foil separately.
const byName     = new Map(); // norm(name) → row  (non-foil preferred)
const byNameFoil = new Map(); // norm(name) → row  (foil)

for (const row of rows) {
  const condition = row["Condition"] || "";
  const isFoil    = condition.toLowerCase().includes("foil");
  const key       = norm(row["Product Name"]);
  if (isFoil) byNameFoil.set(key, row);
  else         byName.set(key, row);
}

console.log(`TCG rows: ${rows.length}, unique non-foil: ${byName.size}, foil: ${byNameFoil.size}`);

// Find all TMC YAML deck files.
const dataDir  = join(__dir, "../data/decks/tmc");
const yamls    = (await readdir(dataDir)).filter(f => f.endsWith(".yaml") && f !== "display.yaml");

let totalUpdated = 0, totalSkipped = 0;

for (const yfile of yamls) {
  const ypath   = join(dataDir, yfile);
  let   content = await readFile(ypath, "utf8");
  const lines   = content.split("\n");
  const out     = [];
  let updated   = 0, skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for lines with tcgplayer_product_id after a name: field.
    if (/^\s*tcgplayer_product_id:/.test(line)) {
      // Find the name from previous lines.
      let nameVal = "";
      let finish  = "";
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const m = lines[j].match(/^\s*name:\s*"?(.+?)"?\s*$/);
        if (m) { nameVal = m[1].trim(); }
        const mf = lines[j].match(/^\s*finish:\s*(\S+)/);
        if (mf) { finish = mf[1]; }
      }

      const isFoil = finish === "f";
      const key    = norm(nameVal);
      const match  = isFoil
        ? (byNameFoil.get(key) || byName.get(key))
        : (byName.get(key)     || byNameFoil.get(key));

      if (match) {
        const newId  = match["TCGplayer Id"];
        const oldId  = line.match(/:\s*"?(\d+)"?/)?.[1] || "?";
        if (oldId !== newId) {
          const indent = line.match(/^(\s*)/)[1];
          out.push(`${indent}tcgplayer_product_id: "${newId}"`);
          console.log(`  ${yfile}: ${nameVal} ${oldId} → ${newId}${isFoil?" (foil)":""}`);
          updated++;
        } else {
          out.push(line); // already correct
        }
      } else {
        console.warn(`  SKIP ${yfile}: no TCG match for "${nameVal}" (${isFoil?"foil":"non-foil"})`);
        out.push(line);
        skipped++;
      }
      continue;
    }
    out.push(line);
  }

  if (updated > 0) {
    await writeFile(ypath, out.join("\n"), "utf8");
    console.log(`  ✓ ${yfile}: ${updated} updated, ${skipped} skipped`);
  } else {
    console.log(`  — ${yfile}: no changes (${skipped} skipped)`);
  }
  totalUpdated += updated;
  totalSkipped += skipped;
}

console.log(`\nDone — ${totalUpdated} IDs updated, ${totalSkipped} unmatched.`);
