const REPO      = 'Caravanwellness/Dashboard';
const FILE_PATH = 'client_notifications.json';
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
    if (!r.ok) return res.status(500).json({ error: 'Could not fetch notifications' });
    const data = await r.json();
    const all = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    const now = Date.now();
    return res.json(all.filter(n => new Date(n.expiresAt).getTime() > now));
  }

  if (req.method === 'POST') {
    const { id, title, clients, changedByName } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(API_BASE, { headers: ghHeaders() });
      if (!r.ok) return res.status(500).json({ error: 'Could not read notifications' });
      const fileData = await r.json();
      const sha = fileData.sha;
      let notifs = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

      // Replace any existing notification for this item
      notifs = notifs.filter(n => n.id !== id);
      notifs.push({
        id,
        title:         title || id,
        clients:       clients || [],
        changedByName: changedByName || 'Unknown',
        changedAt:     new Date().toISOString(),
        expiresAt:     new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      });

      const content = Buffer.from(JSON.stringify(notifs, null, 2)).toString('base64');
      const commitRes = await fetch(API_BASE, {
        method: 'PUT', headers: ghHeaders(),
        body: JSON.stringify({ message: `Client notification: ${id}`, content, sha, branch: BRANCH }),
      });

      if (commitRes.ok) return res.json({ ok: true });
      if (commitRes.status === 409 && attempt < 2) continue;
      return res.status(500).json({ error: 'Commit failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
