import { getUser } from './_lib/token.js';

const REPO      = 'Caravanwellness/Dashboard';
const FILE_PATH = 'change_log.json';
const BRANCH    = 'main';
const API_BASE  = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

function ghHeaders() {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const r = await fetch(API_BASE, { headers: ghHeaders() });
    if (!r.ok) return res.status(500).json({ error: 'Could not fetch changelog' });
    const data = await r.json();
    return res.json(JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')));
  }

  if (req.method === 'POST') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { id, field, oldValue, newValue } = req.body || {};
    if (!id || !field) return res.status(400).json({ error: 'id and field required' });

    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(API_BASE, { headers: ghHeaders() });
      if (!r.ok) return res.status(500).json({ error: 'Could not read changelog' });
      const fileData = await r.json();
      const sha = fileData.sha;
      const log = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

      if (!log[id]) log[id] = [];
      log[id].unshift({
        ts:     new Date().toISOString(),
        field,
        old:    oldValue !== undefined ? String(oldValue) : null,
        new:    newValue !== undefined ? String(newValue) : null,
        byName:  user.name,
        byEmail: user.email,
      });
      if (log[id].length > 100) log[id] = log[id].slice(0, 100);

      const content = Buffer.from(JSON.stringify(log, null, 2)).toString('base64');
      const commitRes = await fetch(API_BASE, {
        method: 'PUT', headers: ghHeaders(),
        body: JSON.stringify({
          message: `Changelog: ${id} · ${field} by ${user.name}`,
          content, sha, branch: BRANCH,
        }),
      });

      if (commitRes.ok) return res.json({ ok: true });
      if (commitRes.status === 409 && attempt < 2) continue;
      return res.status(500).json({ error: 'Commit failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
