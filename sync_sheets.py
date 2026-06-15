#!/usr/bin/env python3
"""
Syncs change log from a Google Sheet into change_log.json.

Setup:
  1. Create a Google Sheet with columns: Content ID | Date | Description | Changed By
  2. Share it: File → Share → Anyone with the link → Viewer
  3. Run this script once — it will ask for the sheet URL and save it
  4. After that, just run: python3 sync_sheets.py

After syncing, run: python3 extract_data.py
to rebuild the dashboard with the latest changes.
"""

import csv, json, os, sys
from urllib.request import urlopen
from urllib.error import HTTPError

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
LOG_FILE    = os.path.join(SCRIPT_DIR, 'change_log.json')
CONFIG_FILE = os.path.join(SCRIPT_DIR, 'sheets_config.json')


def extract_sheet_id(url):
    """Pull the sheet ID out of any Google Sheets URL."""
    try:
        parts = url.split('/')
        idx = parts.index('d')
        raw = parts[idx + 1]
        return raw.split('?')[0].split('#')[0]
    except (ValueError, IndexError):
        return None


def csv_url(sheet_id, gid='0'):
    return f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'


def download_sheet(sheet_id):
    url = csv_url(sheet_id)
    try:
        with urlopen(url) as r:
            return r.read().decode('utf-8')
    except HTTPError as e:
        if e.code == 403:
            print("\n⚠️  Access denied (403).")
            print("Make sure the sheet is shared as 'Anyone with the link can view':")
            print("  File → Share → Change to 'Anyone with the link' → set to Viewer → Done\n")
        raise


def parse_sheet(csv_text):
    """Parse rows into {item_id: [{date, description, changed_by}]} dict."""
    reader = csv.reader(csv_text.splitlines())
    rows   = [r for r in reader if any(c.strip() for c in r)]

    if not rows:
        return {}

    # Detect and skip header row
    first = [c.lower().strip() for c in rows[0]]
    if any(h in first for h in ('content id', 'id', 'date', 'description')):
        rows = rows[1:]

    changes = {}
    skipped = 0

    for i, row in enumerate(rows, start=2):
        # Pad short rows
        while len(row) < 4:
            row.append('')

        item_id     = row[0].strip().upper()
        date        = row[1].strip()
        description = row[2].strip()
        changed_by  = row[3].strip()

        if not item_id or not description:
            skipped += 1
            continue

        if item_id not in changes:
            changes[item_id] = []

        changes[item_id].append({
            'date':        date,
            'description': description,
            'changed_by':  changed_by,
        })

    if skipped:
        print(f"  (skipped {skipped} empty/incomplete rows)")

    return changes


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {}


def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def main():
    print("=== Caravan Wellness — Google Sheets Sync ===\n")

    config = load_config()

    # First-time setup: ask for sheet URL
    if 'sheet_id' not in config:
        print("First-time setup. Paste your Google Sheet URL below.")
        print("(The sheet must be shared as 'Anyone with the link can view')\n")
        url = input("Google Sheet URL: ").strip()
        if not url:
            print("No URL entered. Exiting.")
            sys.exit(1)

        sheet_id = extract_sheet_id(url)
        if not sheet_id:
            print("Could not read the sheet ID from that URL.")
            print("Make sure it's a full Google Sheets URL like:")
            print("  https://docs.google.com/spreadsheets/d/ABC123.../edit")
            sys.exit(1)

        config['sheet_url'] = url
        config['sheet_id']  = sheet_id
        save_config(config)
        print(f"\n✓ Saved. Sheet ID: {sheet_id}")
        print(f"  (Config saved to sheets_config.json — don't commit this file)\n")

    sheet_id = config['sheet_id']
    print(f"Downloading sheet {sheet_id}...")

    try:
        csv_text = download_sheet(sheet_id)
    except Exception as e:
        print(f"Download failed: {e}")
        sys.exit(1)

    incoming = parse_sheet(csv_text)
    total    = sum(len(v) for v in incoming.values())
    print(f"✓ Found {total} change entries across {len(incoming)} content items.")

    # Load existing local change log (from change_log.py entries)
    try:
        with open(LOG_FILE) as f:
            existing = json.load(f)
    except:
        existing = {}

    # Merge: sheet entries are source of truth for sheet-sourced changes.
    # Local entries (from change_log.py) are kept if not duplicated.
    merged = {}

    # Start with sheet data
    for item_id, entries in incoming.items():
        merged[item_id] = entries

    # Add local-only entries that aren't already in the sheet
    for item_id, entries in existing.items():
        local_only = [
            e for e in entries
            if e not in (merged.get(item_id) or [])
        ]
        if local_only:
            if item_id not in merged:
                merged[item_id] = []
            merged[item_id].extend(local_only)

    # Sort each item's entries newest first
    for item_id in merged:
        merged[item_id].sort(key=lambda e: e.get('date',''), reverse=True)

    with open(LOG_FILE, 'w') as f:
        json.dump(merged, f, indent=2)

    total_final = sum(len(v) for v in merged.values())
    print(f"✓ change_log.json updated — {total_final} total entries.\n")
    print("Next step: run  python3 extract_data.py")
    print("This rebuilds index.html with all the latest changes.")


if __name__ == '__main__':
    main()
