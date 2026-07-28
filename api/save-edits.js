import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO   = 'Caravanwellness/Dashboard';
const PATH   = 'content_edits.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;

  // GET — return all edits
  if (req.method === 'GET') {
    try {
      const { data } = await ghReadJson(REPO, PATH, token);
      return res.json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — single: { id, field, value }  OR  bulk: { bulk: [{id, field, value},...], message }
  if (req.method === 'POST') {
    const { id, field, value, bulk, message } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (id && field !== undefined ? [{ id, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'id+field or bulk array required' });

    const ts = new Date().toISOString();
    const commitMsg = message || (changes.length === 1
      ? `Edit ${changes[0].id}: ${changes[0].field}`
      : `Bulk update ${changes.length} fields`);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { data: edits } = await ghReadJson(REPO, PATH, token);

        for (const { id: cId, field: cField, value: cVal } of changes) {
          if (!edits[cId]) edits[cId] = {};
          edits[cId][cField] = cVal;
          edits[cId]._at = ts;
        }

        const ok = await ghWriteJson(REPO, PATH, BRANCH, edits, commitMsg, token);
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
