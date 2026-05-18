#!/usr/bin/env python3
"""Validates and patches tcgplayer_product_id in all deck YAML files using Scryfall as source of truth.

Usage: python scripts/patch-all-product-ids.py [--dry-run]
"""

import os
import re
import sys
import time
import json
import subprocess
from pathlib import Path

DECKS_DIR = Path(__file__).parent.parent / "data" / "decks"
SCRYFALL_DELAY = 0.12  # stay well under Scryfall's 10 req/s limit
DRY_RUN = "--dry-run" in sys.argv

# Cache: (set_code, number) -> scryfall card dict
_cache: dict = {}


def fetch_scryfall(set_code: str, number: str) -> dict:
    key = (set_code, number)
    if key in _cache:
        return _cache[key]

    url = f"https://api.scryfall.com/cards/{set_code}/{number}"
    try:
        proc = subprocess.run(
            ["curl", "-s", "-A", "FG-CollectLabs-EV-Audit/1.0 (himynameisfil@gmail.com)", url],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(proc.stdout)
        if data.get("object") == "error":
            result = {"error": data.get("details", "scryfall error")}
        else:
            result = {
                "name": data.get("name"),
                "tcgplayer_id": str(data["tcgplayer_id"]) if data.get("tcgplayer_id") else None,
                "tcgplayer_etched_id": str(data["tcgplayer_etched_id"]) if data.get("tcgplayer_etched_id") else None,
            }
    except Exception as e:
        result = {"error": str(e)}

    _cache[key] = result
    time.sleep(SCRYFALL_DELAY)
    return result


def parse_display_key(dk: str):
    """Parse 'mtg-{set}-{number}-{finish}' -> (set_code, number, finish) or None."""
    parts = dk.split("-")
    if len(parts) < 4 or parts[0] != "mtg":
        return None
    finish = parts[-1]
    if finish not in ("nf", "f", "e"):
        return None
    number = parts[-2]
    if not re.match(r"^\d+[a-z★]?$", number):
        return None
    set_code = "-".join(parts[1:-2])
    return set_code, number, finish


def patch_file(yaml_path: Path) -> tuple[int, int, list[str]]:
    lines = yaml_path.read_text(encoding="utf-8").splitlines(keepends=True)
    out = []
    updated = 0
    skipped = 0
    warnings = []

    i = 0
    while i < len(lines):
        line = lines[i]

        if re.match(r"\s*tcgplayer_product_id:", line):
            # Scan backwards for the nearest display_key
            display_key = None
            for j in range(i - 1, max(-1, i - 10), -1):
                m = re.search(r"display_key:\s*(\S+)", lines[j])
                if m:
                    display_key = m.group(1)
                    break

            parsed = parse_display_key(display_key) if display_key else None

            if parsed:
                set_code, number, finish = parsed
                card = fetch_scryfall(set_code, number)

                if "error" in card:
                    warnings.append(f"    FETCH ERROR {display_key}: {card['error']}")
                    out.append(line)
                    skipped += 1
                    i += 1
                    continue

                correct_id = (
                    card.get("tcgplayer_etched_id") or card.get("tcgplayer_id")
                    if finish == "e"
                    else card.get("tcgplayer_id")
                )

                if correct_id:
                    m_old = re.search(r':\s*"?(\d+)"?', line)
                    old_id = m_old.group(1) if m_old else "?"
                    if old_id != correct_id:
                        indent = re.match(r"^(\s*)", line).group(1)
                        new_line = f'{indent}tcgplayer_product_id: "{correct_id}"\n'
                        out.append(new_line)
                        status = "(dry-run) " if DRY_RUN else ""
                        print(f"    {status}{card['name']} ({finish}) {old_id} -> {correct_id}")
                        updated += 1
                        i += 1
                        continue
                else:
                    warnings.append(f"    NO TCG ID on Scryfall: {display_key} ({card.get('name')})")
                    skipped += 1

        out.append(line)
        i += 1

    if updated > 0 and not DRY_RUN:
        yaml_path.write_text("".join(out), encoding="utf-8")

    return updated, skipped, warnings


# ── main ──────────────────────────────────────────────────────────────────────

print(f"{'[DRY RUN] ' if DRY_RUN else ''}Patching TCGPlayer product IDs from Scryfall\n")

total_updated = 0
total_skipped = 0
all_warnings: list[str] = []

for folder in sorted(DECKS_DIR.iterdir()):
    if not folder.is_dir():
        continue
    yamls = sorted(f for f in folder.glob("*.yaml") if f.name != "display.yaml")
    if not yamls:
        continue
    print(f"{'='*55}")
    print(f"{folder.name}/")
    for yaml_path in yamls:
        print(f"  {yaml_path.name}")
        u, s, warns = patch_file(yaml_path)
        if not warns and u == 0:
            print(f"    OK all correct")
        else:
            print(f"    -> {u} updated, {s} skipped")
        all_warnings.extend(warns)
        total_updated += u
        total_skipped += s

print(f"\n{'='*55}")
print(f"TOTAL: {total_updated} updated, {total_skipped} skipped")
if all_warnings:
    print("\nWARNINGS:")
    for w in all_warnings:
        print(w)
