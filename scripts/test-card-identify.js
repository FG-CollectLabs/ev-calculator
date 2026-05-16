#!/usr/bin/env node
// Tests card identifier matches against a folder of scans.
// Usage: node scripts/test-card-identify.js <folder>
// Images processed in order: even index = front, odd = back.
// Reports match rate and lists unmatched files.

import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";

const API     = process.env.CARD_ID_API || "http://localhost:8082";
const TOKEN   = process.env.CARD_ID_TOKEN || "dev-token";
const folder  = process.argv[2] || ".";

async function identify(filePath) {
  const fd = new FormData();
  const blob = new Blob([await import("node:fs/promises").then(m => m.readFile(filePath))], { type: "image/jpeg" });
  fd.append("image", blob, filePath.split(/[\\/]/).pop());
  const r = await fetch(`${API}/identify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  return r.json();
}

async function main() {
  const all = (await readdir(folder)).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
  const fronts = all.filter((_, i) => i % 2 === 0);
  console.log(`Folder: ${folder}`);
  console.log(`Total images: ${all.length} → ${fronts.length} front scans to test\n`);

  let matched = 0, unmatched = 0;
  const misses = [];
  const confidenceCounts = {};

  for (let i = 0; i < fronts.length; i++) {
    const file = fronts[i];
    process.stdout.write(`\r[${i+1}/${fronts.length}] ${file.padEnd(40)}`);
    try {
      const res = await identify(join(folder, file));
      const conf = res.confidence || "none";
      confidenceCounts[conf] = (confidenceCounts[conf] || 0) + 1;
      const productId = res.candidates?.[0]?.tcgplayer_product_id;
      if (productId && conf !== "none" && conf !== "back") {
        matched++;
      } else {
        unmatched++;
        misses.push({ file, confidence: conf, candidates: res.candidates?.length || 0 });
      }
    } catch (e) {
      unmatched++;
      misses.push({ file, confidence: "error", error: e.message });
    }
  }

  console.log(`\n\n── Results ──────────────────────────`);
  console.log(`Matched:   ${matched} / ${fronts.length}`);
  console.log(`Unmatched: ${unmatched} / ${fronts.length}`);
  console.log(`\nConfidence breakdown:`);
  for (const [k, v] of Object.entries(confidenceCounts)) console.log(`  ${k}: ${v}`);

  if (misses.length) {
    console.log(`\nUnmatched files (first 20):`);
    misses.slice(0, 20).forEach(m => console.log(`  ${m.file} → ${m.confidence} (${m.candidates} candidates)`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
