# Caravan Wellness Content Dashboard

Internal admin tool for managing Caravan Wellness's content catalog — videos, articles, infographics, recipes, and more — along with creator bios, client licensing, and review/versioning metadata.

**Live app:** https://content-dashboard-xi-five.vercel.app

## How it works

- **Frontend:** a single-page app (`index.html` / `template.html`) served statically.
- **Backend:** Vercel serverless functions under `api/` act as a thin API layer.
- **Database:** there is no traditional database — content, edits, licenses, bios, and transcripts are stored as JSON files in this repo (root and `data/`) and read/written via the GitHub Contents API (see `api/_lib/github.js`).

## Key data files

| File | Purpose |
|---|---|
| `data.json` | Core catalog (articles, infographics, videos, and their "library" language variants) |
| `extra_content.json` | Additional/imported catalog items |
| `content_edits.json` | Per-item field edits, applied as an overlay on top of the base catalog |
| `data/client_licenses.json` | Which clients are licensed for which content items |
| `client_data.json` | Client roster |
| `creator_bios.json` / `creator_bios_text.json` | Creator/author bio and credentials data |
| `transcripts.json` | Video transcripts |
| `users.json` | Dashboard login accounts |

## Local scripts

A few standalone Python scripts (`fetch_transcripts.py`, `fetch_durations.py`, `sync_sheets.py`, `extract_data.py`, `apply_durations.py`, `change_log.py`) support one-off data maintenance and are run manually, not as part of the deployed app.
