#!/usr/bin/env node
// Tests name OCR by sending a card scan and saving the response for inspection.
// Run: node scripts/test-name-ocr.js <image_path>

import { readFile, writeFile } from "node:fs/promises";

const API   = "http://localhost:8082";
const TOKEN = "dev-token";
const file  = process.argv[2];

if (!file) { console.error("Usage: node test-name-ocr.js <image.jpg>"); process.exit(1); }

const data = await readFile(file);
const blob = new Blob([data], { type: "image/jpeg" });
const fd   = new FormData();
fd.append("image", blob, file.split(/[\\/]/).pop());

const r = await fetch(`${API}/identify`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: fd,
});
const d = await r.json();
console.log(JSON.stringify(d, null, 2));
