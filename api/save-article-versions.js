import { getUser } from './_lib/token.js';

const OWNER = 'Caravanwellness';
const REPO  = 'Dashboard';
const PATH  = 'article_versions.json';
const BRANCH = 'main';

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}

async function ghPut(data, sha) {
  const body = { message: 'Update article_versions.json', content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub PUT ${r.status}: ${t}`); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const { data } = await ghGet();
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { id, entry } = req.body || {};
    if (!id || !entry) return res.status(400).json({ error: 'id and entry required' });

    // 3-retry loop for SHA conflicts
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, sha } = await ghGet();
        if (!data[id]) data[id] = [];
        data[id].push(entry);
        // keep last 50 entries per item
        if (data[id].length > 50) data[id] = data[id].slice(-50);
        await ghPut(data, sha);
        return res.json({ ok: true });
      } catch (e) {
        if (attempt < 2 && e.message.includes('409')) continue;
        return res.status(500).json({ error: e.message });
      }
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
