#!/usr/bin/env python3
"""
Confirms exact video durations from Vimeo for dashboard items with a
Vimeo-matched title, rounds each up to the nearest whole minute, and writes
a dry-run proposal to duration_updates.json — nothing is written to the
live dashboard by this step.

Usage:
  python3 fetch_durations.py              # full run, writes duration_updates.json
  python3 fetch_durations.py --sample 20  # test with 20 videos

After reviewing duration_updates.json, apply it with apply_durations.py.
"""

import json, math, os, sys, time

from fetch_transcripts import api_get, fetch_all_vimeo_videos, _clean, load_dashboard_items

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE   = os.path.join(SCRIPT_DIR, 'duration_updates.json')


def current_duration(item_id, by_id, edits):
    e = edits.get(item_id, {})
    if 'duration' in e:
        return str(e['duration']).strip()
    return str(by_id.get(item_id, {}).get('duration', '')).strip()


def load_by_id():
    by_id = {}
    with open(os.path.join(SCRIPT_DIR, 'data.json')) as f:
        data = json.load(f)
    for section_items in data.values():
        for item in section_items:
            by_id[item['id']] = item
    extra_path = os.path.join(SCRIPT_DIR, 'extra_content.json')
    if os.path.exists(extra_path):
        with open(extra_path) as f:
            for item in json.load(f):
                by_id[item['id']] = item
    return by_id


def main():
    args = sys.argv[1:]
    sample_limit = None
    if '--sample' in args:
        idx = args.index('--sample')
        sample_limit = int(args[idx + 1]) if idx + 1 < len(args) else 20

    by_id = load_by_id()
    edits_path = os.path.join(SCRIPT_DIR, 'content_edits.json')
    edits = {}
    if os.path.exists(edits_path):
        with open(edits_path) as f:
            edits = json.load(f)

    print("Loading dashboard items...")
    items = load_dashboard_items()
    print(f"  {len(items)} items with titles.")

    vimeo_index = fetch_all_vimeo_videos()

    matched, unmatched = [], []
    for item_id, title in items:
        vid_id = vimeo_index.get(_clean(title))
        if vid_id:
            matched.append((item_id, title, vid_id))
        else:
            unmatched.append((item_id, title))

    print(f"\nMatched {len(matched)} / {len(items)} dashboard items to Vimeo videos.")
    print(f"Unmatched (no title match on the Vimeo account — skipped): {len(unmatched)}")

    to_check = matched[:sample_limit] if sample_limit else matched
    print(f"Checking duration for {len(to_check)} videos...")

    confirmed = 0
    not_confirmed = []
    proposed = []

    for i, (item_id, title, vid_id) in enumerate(to_check):
        try:
            info = api_get(f'/videos/{vid_id}', 'fields=duration')
            secs = info.get('duration')
        except Exception as e:
            secs = None
        if secs is None:
            not_confirmed.append((item_id, title, vid_id))
        else:
            confirmed += 1
            rounded_min = math.ceil(secs / 60) if secs > 0 else 0
            new_val = f"{rounded_min} min"
            cur = current_duration(item_id, by_id, edits)
            if new_val != cur:
                proposed.append({
                    'id': item_id, 'title': title, 'vimeo_id': vid_id,
                    'seconds': secs, 'new_duration': new_val, 'current_duration': cur,
                })
        if (i + 1) % 25 == 0 or i == len(to_check) - 1:
            print(f"  [{i+1}/{len(to_check)}] confirmed={confirmed} would_change={len(proposed)}")
        time.sleep(0.15)  # ~6-7 req/sec, matches fetch_transcripts.py pacing

    with open(OUT_FILE, 'w') as f:
        json.dump(proposed, f, indent=2)

    print(f"\nConfirmed duration for {confirmed}/{len(to_check)} checked videos.")
    print(f"Could not confirm (Vimeo returned no duration): {len(not_confirmed)}")
    print(f"Items whose duration would change: {len(proposed)}")
    print(f"\nProposal written to {OUT_FILE} — nothing applied yet.")
    print("Review it, then run: python3 apply_durations.py")


if __name__ == '__main__':
    main()
