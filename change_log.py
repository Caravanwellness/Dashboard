#!/usr/bin/env python3
"""
Run this script whenever a substantive change is made to content.
It logs the change to change_log.json, which gets embedded in the dashboard
the next time you run extract_data.py.
"""
import json, os
from datetime import date

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'change_log.json')

try:
    with open(LOG_FILE) as f:
        log = json.load(f)
except:
    log = {}

print("=== Caravan Wellness — Log a Substantive Change ===\n")
print("Find the Content ID in the first column of the dashboard (e.g. ART-0042, VID-0100).\n")

item_id = input("Content ID: ").strip().upper()
if not item_id:
    print("No ID entered. Exiting.")
    exit()

description = input("What changed: ").strip()
changed_by  = input("Your name: ").strip()
today       = date.today().strftime("%m/%d/%Y")
date_str    = input(f"Date [press Enter for today {today}]: ").strip() or today

if item_id not in log:
    log[item_id] = []

log[item_id].append({
    "date":        date_str,
    "description": description,
    "changed_by":  changed_by,
})

with open(LOG_FILE, 'w') as f:
    json.dump(log, f, indent=2)

print(f"\n✓ Change logged for {item_id}: \"{description}\"")
print("Run 'python3 extract_data.py' to embed this change in the dashboard.")
