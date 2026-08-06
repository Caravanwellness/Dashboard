#!/usr/bin/env python3
"""
Confirms exact video durations from Vimeo for dashboard items with a
Vimeo-matched title, rounds each up to the nearest whole minute, and writes
a dry-run proposal to duration_updates.json — nothing is written to the
live dashboard by this step.

Progress is checkpointed to duration_check_cache.json every 25 items and on
exit, so the run is safe to interrupt and resume — already-checked items are
skipped on the next run instead of being re-fetched from Vimeo.

Usage:
  python3 fetch_durations.py              # full run, writes duration_updates.json
  python3 fetch_durations.py --sample 20  # test with 20 new (not-yet-checked) videos

After reviewing duration_updates.json, apply it with apply_durations.py.
"""

import json, math, os, sys, time

from fetch_transcripts import api_get, fetch_all_vimeo_videos, _clean, load_dashboard_items

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
OUT_FILE     = os.path.join(SCRIPT_DIR, 'duration_updates.json')
CACHE_FILE   = os.path.join(SCRIPT_DIR, 'duration_check_cache.json')


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


def write_proposal(cache, by_id, edits):
    proposed = []
    for item_id, entry in cache.items():
        secs = entry.get('seconds')
        if secs is None:
            continue
        rounded_min = math.ceil(secs / 60) if secs > 0 else 0
        new_val = f"{rounded_min} min"
        cur = current_duration(item_id, by_id, edits)
        if new_val != cur:
            proposed.append({
                'id': item_id, 'title': entry['title'], 'vimeo_id': entry['vimeo_id'],
                'seconds': secs, 'new_duration': new_val, 'current_duration': cur,
            })
    with open(OUT_FILE, 'w') as f:
        json.dump(proposed, f, indent=2)
    return proposed


def main():
    sys.stdout.reconfigure(line_buffering=True)  # flush every line immediately, even when piped to a file

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

    cache = {}
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            cache = json.load(f)
        print(f"Resuming — {len(cache)} items already checked in a previous run.")

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

    already_checked = [m for m in matched if m[0] in cache]
    to_check = [m for m in matched if m[0] not in cache]
    if sample_limit:
        to_check = to_check[:sample_limit]
    print(f"{len(already_checked)} already checked. Checking duration for {len(to_check)} more videos...")

    confirmed_this_run = 0
    not_confirmed_this_run = 0

    for i, (item_id, title, vid_id) in enumerate(to_check):
        try:
            info = api_get(f'/videos/{vid_id}', 'fields=duration')
            secs = info.get('duration')
        except Exception:
            secs = None

        cache[item_id] = {'title': title, 'vimeo_id': vid_id, 'seconds': secs}
        if secs is None:
            not_confirmed_this_run += 1
        else:
            confirmed_this_run += 1

        if (i + 1) % 10 == 0 or i == len(to_check) - 1:
            print(f"  [{i+1}/{len(to_check)}] confirmed={confirmed_this_run} not_confirmed={not_confirmed_this_run}")
        if (i + 1) % 25 == 0:
            with open(CACHE_FILE, 'w') as f:
                json.dump(cache, f)

        time.sleep(0.15)  # ~6-7 req/sec, matches fetch_transcripts.py pacing

    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f)

    proposed = write_proposal(cache, by_id, edits)

    total_confirmed = sum(1 for e in cache.values() if e.get('seconds') is not None)
    print(f"\nChecked this run: {len(to_check)} (confirmed {confirmed_this_run}, not confirmed {not_confirmed_this_run})")
    print(f"Total confirmed across all runs: {total_confirmed}/{len(cache)}")
    print(f"Items whose duration would change: {len(proposed)}")
    print(f"\nProposal written to {OUT_FILE} — nothing applied yet.")
    print("Review it, then run: python3 apply_durations.py")


if __name__ == '__main__':
    main()
