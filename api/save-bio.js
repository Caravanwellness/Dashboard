import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO   = 'Caravanwellness/Dashboard';
const PATH   = 'creator_bios.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;

  // GET — return current bios
  if (req.method === 'GET') {
    try {
      const { data } = await ghReadJson(REPO, PATH, token);
      return res.json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — single: { name, field, value }  OR  bulk: { bulk: [{name, field, value},...] }
  if (req.method === 'POST') {
    const { name, field, value, bulk } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (name && field !== undefined ? [{ name, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'name+field or bulk array required' });

    const msg = changes.length === 1
      ? `Update bio: ${changes[0].name}`
      : `Bulk bio update: ${changes.length} fields`;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { data: bios, sha } = await ghReadJson(REPO, PATH, token);

        for (const { name: n, field: f, value: v } of changes) {
          if (!bios[n]) bios[n] = {};
          bios[n][f] = v;
        }

        const ok = await ghWriteJson(REPO, PATH, BRANCH, bios, msg, token, sha);
        if (ok) return res.json({ ok: true, count: changes.length });
        // false = 422 concurrent write, retry
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(500).json({ error: 'Too many concurrent writes — try again' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
