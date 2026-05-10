// Convert theexpectedvalue.com drc-decks.json (mirrors MTGJSON deck_map)
// into ev-calculator deck YAMLs. Also pulls per-deck sealed product IDs
// from TCGCSV so the box-cost side of the EV calc has TCGPlayer IDs.
//
// Inputs (cached locally if you've already curl'd them):
//   c:/tmp/drc-decks.json     <- theexpectedvalue.com/commander-ev/data/drc-decks.json
//   c:/tmp/drc-products.json  <- tcgcsv.com/tcgplayer/1/23929/products
const fs = require('fs');
const path = require('path');

const src = JSON.parse(fs.readFileSync('c:/tmp/drc-decks.json', 'utf8'));
const products = JSON.parse(fs.readFileSync('c:/tmp/drc-products.json', 'utf8')).results;
const FIN = { nonfoil: 'nf', foil: 'f', etched: 'e' };

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function yamlStr(s) {
  if (s == null) return '';
  if (/[:#&*!|>'"%@`{}\[\],?-]|^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}
function findDeckProductID(deckName) {
  const wanted = `Aetherdrift Commander Deck - ${deckName}`;
  const hit = products.find(p => p.name === wanted);
  return hit ? String(hit.productId) : '';
}

const outDir = 'c:/Users/nguye/VSCode/FG-CollectLabs/ev-calculator/data/decks/aetherdrift';

for (const deck of src.decks) {
  const slug = slugify(deck.name);
  const key = `aetherdrift-commander-${slug}`;
  const productKey = `mtg-drc-commander-${slug}`;
  const productTCGID = findDeckProductID(deck.name);
  const lines = [];
  lines.push(`# Generated from theexpectedvalue.com drc-decks.json + tcgcsv DRC products.`);
  lines.push(`# Regenerate with: node scripts/gen-drc-yaml.js`);
  lines.push(`key: ${key}`);
  lines.push(`name: ${yamlStr(deck.name)}`);
  lines.push(`game: mtg`);
  lines.push(`set_code: drc`);
  lines.push(`product_display_key: ${productKey}`);
  if (productTCGID) lines.push(`product_tcgplayer_id: "${productTCGID}"`);
  lines.push(`components:`);
  for (const c of deck.cards) {
    const finish = FIN[c.finish] || c.finish;
    const setCode = (c.setCode || 'DRC').toLowerCase();
    const num = (c.collectorNumber || '').replace(/\s+/g, '');
    if (!num) continue;
    const dk = `mtg-${setCode}-${num}-${finish}`;
    lines.push(`  - display_key: ${dk}`);
    lines.push(`    qty: ${c.count}`);
    lines.push(`    name: ${yamlStr(c.name)}`);
    if (c.tcgplayerProductId) lines.push(`    tcgplayer_product_id: "${c.tcgplayerProductId}"`);
    lines.push(`    finish: ${finish}`);
    if (c.section === 'commander') lines.push(`    note: commander`);
  }
  fs.writeFileSync(path.join(outDir, `${slug}.yaml`), lines.join('\n') + '\n');
  console.log('wrote', `${slug}.yaml`);
}

const dispLines = [
  `# Aetherdrift Commander Display.`,
  `# 2 unique decks (Eternal Might, Living Energy), 2 of each per display.`,
  `# Box cost = sum(deck market price * copies). No standalone "display"`,
  `# product on TCGPlayer for DRC.`,
  `key: aetherdrift-commander-display`,
  `name: Aetherdrift Commander Display`,
  `game: mtg`,
  `set_code: drc`,
  `product_display_key: mtg-drc-commander-display`,
  ``,
  `decks:`,
  `  - deck_key: aetherdrift-commander-eternal-might`,
  `    copies: 2`,
  `  - deck_key: aetherdrift-commander-living-energy`,
  `    copies: 2`,
  ``,
  `extra_components: []`,
  ``,
];
fs.writeFileSync(path.join(outDir, 'display.yaml'), dispLines.join('\n'));
console.log('wrote display.yaml');
