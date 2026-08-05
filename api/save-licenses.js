import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO   = 'Caravanwellness/Dashboard';
const PATH   = 'client_licenses.json';
const BRANCH = 'main';

const delay = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { data, sha } = await ghReadJson(REPO, PATH, token);
      return res.json({ _data: data || {}, _sha: sha });
    } catch(e) {
      return res.json({ _data: {}, _sha: null });
    }
  }

  // POST: { updates: { [itemId]: [client, ...] }, message? }
  // Merges into existing data — a null/empty array removes the item's licenses
  if (req.method === 'POST') {
    const { updates, message } = req.body || {};
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'updates object required' });

    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await delay(600 + Math.random() * 400);
      try {
        const { data, sha } = await ghReadJson(REPO, PATH, token);
        const licenses = data || {};

        for (const [id, lics] of Object.entries(updates)) {
          if (!lics || !lics.length) {
            delete licenses[id];
          } else {
            licenses[id] = lics;
          }
        }

        const count = Object.keys(updates).length;
        const result = await ghWriteJson(REPO, PATH, BRANCH, licenses,
          message || `Update licenses: ${count} items`, token, sha);
        if (result) return res.json({ ok: true, count, _sha: typeof result === 'string' ? result : null });
        // SHA conflict — retry
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(500).json({ error: 'Too many concurrent writes — try again' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
