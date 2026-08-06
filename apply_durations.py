#!/usr/bin/env python3
"""
Applies the duration proposal from duration_updates.json (produced by
fetch_durations.py) to the live dashboard, via the same /api/save-edits
endpoint the dashboard's own UI uses.

Usage:
  python3 apply_durations.py            # apply against the production dashboard
  python3 apply_durations.py --url URL  # apply against a different deployment
"""

import json, os, sys, urllib.request, urllib.error

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
IN_FILE     = os.path.join(SCRIPT_DIR, 'duration_updates.json')
DEFAULT_URL = 'https://library.caravanwellness.com/api/save-edits'


def main():
    args = sys.argv[1:]
    url = DEFAULT_URL
    if '--url' in args:
        idx = args.index('--url')
        url = args[idx + 1]

    if not os.path.exists(IN_FILE):
        print(f"ERROR: {IN_FILE} not found. Run fetch_durations.py first.")
        return

    with open(IN_FILE) as f:
        proposed = json.load(f)

    if not proposed:
        print("Nothing to apply — duration_updates.json is empty.")
        return

    bulk = [{'id': p['id'], 'field': 'duration', 'value': p['new_duration']} for p in proposed]
    body = json.dumps({
        'bulk': bulk,
        'message': f'Vimeo sync: confirm + round up duration for {len(bulk)} items',
    }).encode('utf-8')

    print(f"Applying {len(bulk)} duration updates to {url} ...")
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        print(resp.status, resp.read().decode())
    except urllib.error.HTTPError as e:
        print('HTTPError', e.code, e.read().decode())


if __name__ == '__main__':
    main()
