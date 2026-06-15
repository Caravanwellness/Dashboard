#!/usr/bin/env python3
"""
Syncs change log from one or more Google Sheets into change_log.json.

Usage:
  python3 sync_sheets.py                        # sync all saved sheets
  python3 sync_sheets.py <url>                  # add a new sheet and sync it
  python3 sync_sheets.py --list                 # show all saved sheets
  python3 sync_sheets.py --remove <url or #>    # remove a sheet

Sheet column format (any tab, any sheet):
  Content ID | Date | Description | Changed By | Language | Topic | URL | Category

After syncing, run:
  python3 extract_data.py
"""

import csv, json, os, re, sys
from io import StringIO
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
LOG_FILE    = os.path.join(SCRIPT_DIR, 'change_log.json')
CONFIG_FILE = os.path.join(SCRIPT_DIR, 'sheets_config.json')

HEADERS = {'User-Agent': 'Mozilla/5.0'}


# ── Config helpers ──────────────────────────────────────────────────────────

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {'sheets': []}

def save_config(cfg):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)


# ── URL / ID helpers ────────────────────────────────────────────────────────

def extract_sheet_id(url):
    try:
        parts = url.split('/')
        idx = parts.index('d')
        raw = parts[idx + 1]
        return raw.split('?')[0].split('#')[0]
    except (ValueError, IndexError):
        return None

def extract_gid(url):
    """Return the tab GID from a URL if present, else None."""
    m = re.search(r'gid=(\d+)', url)
    return m.group(1) if m else None

def csv_export_url(sheet_id, gid='0'):
    return f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'


# ── Tab discovery ───────────────────────────────────────────────────────────

def discover_gids(sheet_id):
    """
    Try to discover all tab GIDs from the spreadsheet HTML.
    Returns a list of (gid, name) tuples.
    Falls back to [('0', 'Sheet1')] on failure.
    """
    url = f'https://docs.google.com/spreadsheets/d/{sheet_id}/edit'
    try:
        req = Request(url, headers=HEADERS)
        html = urlopen(req, timeout=10).read().decode('utf-8', errors='replace')

        # Google Sheets HTML contains patterns like: "gid":123456 or #gid=123456
        gids_found = re.findall(r'"gid"\s*:\s*"?(\d+)"?', html)
        if not gids_found:
            gids_found = re.findall(r'#gid=(\d+)', html)

        # Try to find tab names alongside GIDs
        # Pattern: "name":"Sheet Name","index":0,...,"sheetId":123456
        name_map = {}
        for m in re.finditer(r'"name"\s*:\s*"([^"]+)"[^}]*?"sheetId"\s*:\s*(\d+)', html):
            name_map[m.group(2)] = m.group(1)

        gids_unique = list(dict.fromkeys(gids_found))  # preserve order, deduplicate
        if gids_unique:
            return [(g, name_map.get(g, f'Sheet {i+1}')) for i, g in enumerate(gids_unique)]
    except Exception:
        pass
    return [('0', 'Sheet1')]


# ── Download & parse ─────────────────────────────────────────────────────────

def download_tab(sheet_id, gid):
    url = csv_export_url(sheet_id, gid)
    try:
        req = Request(url, headers=HEADERS)
        return urlopen(req, timeout=15).read().decode('utf-8', errors='replace')
    except HTTPError as e:
        if e.code == 403:
            raise RuntimeError(
                "Access denied (403). Make sure the sheet is shared as "
                "'Anyone with the link can view': File → Share → Change to "
                "'Anyone with the link' → Viewer → Done"
            )
        raise

COLUMN_ALIASES = {
    'content id': 'id',      'id': 'id',
    'date': 'date',
    'description': 'description', 'what changed': 'description', 'change': 'description',
    'changed by': 'changed_by',   'who': 'changed_by', 'name': 'changed_by',
    'language': 'language',
    'topic': 'topic',
    'url': 'url',             'link': 'url',
    'category': 'category',
}

def parse_tab(csv_text, source_label=''):
    """Parse one tab's CSV into a list of change entries."""
    reader = csv.reader(StringIO(csv_text))
    rows   = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return {}

    # Detect header row
    col_map = {}  # column index → field name
    first   = [c.lower().strip() for c in rows[0]]
    is_header = any(alias in first for alias in COLUMN_ALIASES)

    if is_header:
        for i, h in enumerate(first):
            mapped = COLUMN_ALIASES.get(h)
            if mapped:
                col_map[i] = mapped
        data_rows = rows[1:]
    else:
        # Assume positional: ID | Date | Description | Changed By | Language | Topic | URL | Category
        col_map = {0:'id', 1:'date', 2:'description', 3:'changed_by',
                   4:'language', 5:'topic', 6:'url', 7:'category'}
        data_rows = rows

    changes = {}
    skipped = 0

    for row in data_rows:
        entry = {}
        for idx, field in col_map.items():
            entry[field] = row[idx].strip() if idx < len(row) else ''

        item_id = entry.get('id', '').upper()
        desc    = entry.get('description', '')
        if not item_id or not desc:
            skipped += 1
            continue

        record = {k: v for k, v in {
            'date':        entry.get('date', ''),
            'description': desc,
            'changed_by':  entry.get('changed_by', ''),
            'language':    entry.get('language', ''),
            'topic':       entry.get('topic', ''),
            'url':         entry.get('url', ''),
            'category':    entry.get('category', ''),
            'source':      source_label,
        }.items() if v}  # omit empty fields

        changes.setdefault(item_id, []).append(record)

    if skipped:
        print(f"    (skipped {skipped} incomplete rows)")

    return changes


def sync_one_sheet(url, label=None):
    """Download all tabs from a sheet URL and return merged change dict."""
    sheet_id = extract_sheet_id(url)
    if not sheet_id:
        raise ValueError(f"Could not parse sheet ID from: {url}")

    explicit_gid = extract_gid(url)

    if explicit_gid:
        # User gave a URL pointing at a specific tab — pull only that tab
        gids = [(explicit_gid, label or f'tab {explicit_gid}')]
    else:
        # Pull all tabs
        print(f"  Discovering tabs in sheet {sheet_id}...")
        gids = discover_gids(sheet_id)
        print(f"  Found {len(gids)} tab(s): {', '.join(n for _,n in gids)}")

    all_changes = {}
    for gid, name in gids:
        print(f"  Pulling tab: {name} (gid={gid})...")
        try:
            csv_text = download_tab(sheet_id, gid)
            tab_changes = parse_tab(csv_text, source_label=name)
            total = sum(len(v) for v in tab_changes.values())
            print(f"    → {total} entries across {len(tab_changes)} items")
            for item_id, entries in tab_changes.items():
                all_changes.setdefault(item_id, []).extend(entries)
        except Exception as e:
            print(f"    ⚠️  Skipped (error: {e})")

    return all_changes


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    cfg = load_config()
    if 'sheets' not in cfg:
        cfg['sheets'] = []

    # --list
    if args and args[0] == '--list':
        if not cfg['sheets']:
            print("No sheets saved yet. Run:  python3 sync_sheets.py <url>")
        else:
            print("Saved sheets:")
            for i, s in enumerate(cfg['sheets'], 1):
                print(f"  {i}. {s.get('label','(unnamed)')}  →  {s['url']}")
        return

    # --remove <url or number>
    if len(args) >= 2 and args[0] == '--remove':
        target = args[1]
        before = len(cfg['sheets'])
        if target.isdigit():
            idx = int(target) - 1
            if 0 <= idx < len(cfg['sheets']):
                removed = cfg['sheets'].pop(idx)
                print(f"Removed: {removed['url']}")
        else:
            cfg['sheets'] = [s for s in cfg['sheets'] if s['url'] != target]
        if len(cfg['sheets']) < before:
            save_config(cfg)
            print("✓ Saved.")
        else:
            print("No matching sheet found.")
        return

    # <url> argument — add if not already saved, then sync just that one
    if args and args[0].startswith('http'):
        url = args[0]
        existing_urls = [s['url'] for s in cfg['sheets']]
        if url not in existing_urls:
            label = input(f"Label for this sheet (press Enter to skip): ").strip() or url[:60]
            cfg['sheets'].append({'url': url, 'label': label})
            save_config(cfg)
            print(f"✓ Added sheet: {label}")
        sheets_to_sync = [s for s in cfg['sheets'] if s['url'] == url]
    else:
        # No args — sync all saved sheets
        if not cfg['sheets']:
            print("No sheets saved yet.\n")
            print("Usage:  python3 sync_sheets.py <google-sheet-url>")
            print("        python3 sync_sheets.py --list")
            return
        sheets_to_sync = cfg['sheets']

    # ── Sync ──
    print(f"\n=== Caravan Wellness — Google Sheets Sync ===")
    print(f"Syncing {len(sheets_to_sync)} sheet(s)...\n")

    all_incoming = {}
    for sheet in sheets_to_sync:
        url   = sheet['url']
        label = sheet.get('label', url[:50])
        print(f"Sheet: {label}")
        try:
            changes = sync_one_sheet(url, label)
            for item_id, entries in changes.items():
                all_incoming.setdefault(item_id, []).extend(entries)
        except Exception as e:
            print(f"  ⚠️  Failed: {e}")

    total_incoming = sum(len(v) for v in all_incoming.values())
    print(f"\nTotal from sheets: {total_incoming} entries across {len(all_incoming)} items.")

    # Load existing local entries (from change_log.py)
    try:
        with open(LOG_FILE) as f:
            existing = json.load(f)
    except:
        existing = {}

    # Merge: sheet entries replace sheet-sourced entries; local-only entries are kept
    merged = dict(all_incoming)
    for item_id, entries in existing.items():
        local_only = [e for e in entries if not e.get('source')]
        if local_only:
            merged.setdefault(item_id, []).extend(local_only)

    # Sort each item's log newest first
    for item_id in merged:
        def sort_key(e):
            d = e.get('date', '')
            try:
                from datetime import datetime
                return datetime.strptime(d, '%m/%d/%Y')
            except:
                return d
        merged[item_id].sort(key=sort_key, reverse=True)

    with open(LOG_FILE, 'w') as f:
        json.dump(merged, f, indent=2)

    total_final = sum(len(v) for v in merged.values())
    print(f"✓ change_log.json saved — {total_final} total entries.\n")
    print("Next:  python3 extract_data.py   →  rebuilds the dashboard")


if __name__ == '__main__':
    main()
