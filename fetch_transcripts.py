#!/usr/bin/env python3
"""
Fetches Vimeo transcripts for all dashboard videos and saves to transcripts.json.

Usage:
  python3 fetch_transcripts.py              # full fetch (slow, ~6150 API calls)
  python3 fetch_transcripts.py --sample 20  # test with 20 videos

After running, re-run extract_data.py to embed transcripts in the dashboard.
"""

import json, os, re, sys, time
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

SCRIPT_DIR      = os.path.dirname(os.path.abspath(__file__))
OUT_FILE        = os.path.join(SCRIPT_DIR, 'transcripts.json')
VIMEO_INDEX_FILE = os.path.join(SCRIPT_DIR, 'vimeo_index_cache.json')
VIMEO_TOKEN     = '488efb28b42f3dc3b37cfc035973a021'
API_BASE        = 'https://api.vimeo.com'

def api_get(path, params='', retries=4):
    url = f'{API_BASE}{path}{"?" + params if params else ""}'
    req = Request(url, headers={'Authorization': f'bearer {VIMEO_TOKEN}', 'Accept': 'application/json'})
    for attempt in range(retries):
        try:
            resp = urlopen(req, timeout=30)
            return json.loads(resp.read())
        except (URLError, OSError) as e:
            if attempt < retries - 1:
                wait = 2 ** attempt
                print(f"\n  ⚠ Network error ({e}), retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise

def _clean(s):
    return re.sub(r'[^a-z0-9]', '', s.lower()) if s else ''

def fetch_all_vimeo_videos():
    """Paginate through all account videos and return {clean_title: video_id}."""
    # Use cached index if available (avoids re-fetching 6150 videos)
    if os.path.exists(VIMEO_INDEX_FILE):
        with open(VIMEO_INDEX_FILE) as f:
            index = json.load(f)
        print(f"  Loaded cached Vimeo index ({len(index)} titles). Delete vimeo_index_cache.json to refresh.")
        return index

    print("Fetching all Vimeo video titles (this takes ~2-3 minutes)...")
    index = {}
    page = 1
    total = None
    while True:
        data = api_get('/me/videos', f'per_page=100&fields=uri,name&page={page}')
        if total is None:
            total = data['total']
            print(f"  Total videos on account: {total}")
        for v in data['data']:
            vid_id = v['uri'].split('/')[-1]
            key = _clean(v['name'])
            if key:
                index[key] = vid_id
        fetched = (page - 1) * 100 + len(data['data'])
        print(f"  Fetched {fetched}/{total}...", end='\r')
        if not data['paging']['next']:
            break
        page += 1
        time.sleep(0.1)
    print(f"\n  Indexed {len(index)} unique titles.")
    with open(VIMEO_INDEX_FILE, 'w') as f:
        json.dump(index, f)
    print(f"  Saved to vimeo_index_cache.json")
    return index

def fetch_transcript(video_id):
    """Return plain text transcript for a video, or None."""
    try:
        tracks = api_get(f'/videos/{video_id}/texttracks')
        if not tracks.get('data'):
            return None
        # Prefer auto-generated English, then any English, then any
        def rank(t):
            lang = t.get('language', '')
            if lang == 'en-x-autogen': return 0
            if lang.startswith('en'): return 1
            return 2
        track = sorted(tracks['data'], key=rank)[0]
        vtt_url = track.get('link')
        if not vtt_url:
            return None
        req = Request(vtt_url)
        vtt = urlopen(req, timeout=20).read().decode('utf-8', errors='replace')
        return vtt_to_text(vtt)
    except Exception:
        return None

def vtt_to_text(vtt):
    """Convert VTT caption file to clean plain text."""
    lines = vtt.splitlines()
    text_parts = []
    for line in lines:
        line = line.strip()
        # Skip WEBVTT header, timestamps, cue IDs, empty lines
        if not line or line.startswith('WEBVTT') or line.startswith('NOTE') or '-->' in line:
            continue
        if re.match(r'^\d+$', line):  # cue number
            continue
        # Strip inline tags like <00:00:01.000>, <c>, </c>
        line = re.sub(r'<[^>]+>', '', line)
        if line:
            text_parts.append(line)
    # Deduplicate consecutive repeated lines (common in auto-captions)
    deduped = []
    prev = None
    for part in text_parts:
        if part != prev:
            deduped.append(part)
        prev = part
    return ' '.join(deduped)

def load_dashboard_items():
    """Return list of (item_id, title) for all dashboard items."""
    index_path = os.path.join(SCRIPT_DIR, 'index.html')
    with open(index_path) as f:
        content = f.read()
    m = re.search(r'const DATA\s+=\s+(\{.+?\});', content, re.DOTALL)
    if not m:
        raise RuntimeError("Could not find DATA in index.html")
    data = json.loads(m.group(1))
    items = []
    for section_items in data.values():
        for item in section_items:
            title = item.get('title', '')
            if title:
                items.append((item['id'], title))
    return items

def main():
    args = sys.argv[1:]
    sample_limit = None
    if '--sample' in args:
        idx = args.index('--sample')
        sample_limit = int(args[idx + 1]) if idx + 1 < len(args) else 20

    # Load existing transcripts to avoid re-fetching
    existing = {}
    if os.path.exists(OUT_FILE):
        with open(OUT_FILE) as f:
            existing = json.load(f)
        print(f"Loaded {len(existing)} existing transcripts.")

    # Get dashboard items
    print("Loading dashboard items...")
    items = load_dashboard_items()
    print(f"  {len(items)} items with titles.")

    # Build Vimeo title index
    vimeo_index = fetch_all_vimeo_videos()

    # Match dashboard items → Vimeo IDs
    matched = []
    unmatched = []
    for item_id, title in items:
        key = _clean(title)
        vid_id = vimeo_index.get(key)
        if vid_id:
            matched.append((item_id, title, vid_id))
        else:
            unmatched.append((item_id, title))

    print(f"\nMatched {len(matched)} / {len(items)} dashboard items to Vimeo videos.")
    print(f"Unmatched: {len(unmatched)}")

    # Apply sample limit
    to_fetch = [(item_id, title, vid_id) for item_id, title, vid_id in matched
                if item_id not in existing]
    if sample_limit:
        to_fetch = to_fetch[:sample_limit]
        print(f"Sample mode: fetching transcripts for {len(to_fetch)} videos.")
    else:
        print(f"Fetching transcripts for {len(to_fetch)} new videos...")

    # Fetch transcripts
    found = 0
    for i, (item_id, title, vid_id) in enumerate(to_fetch):
        transcript = fetch_transcript(vid_id)
        if transcript:
            existing[item_id] = transcript
            found += 1
            marker = '✓'
        else:
            marker = '–'
        if (i + 1) % 10 == 0 or i == len(to_fetch) - 1:
            print(f"  [{i+1}/{len(to_fetch)}] {marker} {title[:50]}")
        if (i + 1) % 50 == 0:
            with open(OUT_FILE, 'w') as f:
                json.dump(existing, f, indent=2)
        time.sleep(0.15)  # ~6-7 req/sec, well within Vimeo limits

    # Save
    with open(OUT_FILE, 'w') as f:
        json.dump(existing, f, indent=2)

    total = len(existing)
    print(f"\n✓ transcripts.json saved — {total} transcripts ({found} new).")
    print(f"\nNext: python3 extract_data.py  →  rebuilds dashboard with transcripts")

if __name__ == '__main__':
    main()
