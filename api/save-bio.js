export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO         = 'Caravanwellness/Dashboard';
  const FILE_PATH    = 'creator_bios.json';
  const BRANCH       = 'main';
  const API_BASE     = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
  const headers      = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // GET — return current bios
  if (req.method === 'GET') {
    const r = await fetch(API_BASE, { headers });
    if (!r.ok) return res.status(500).json({ error: 'Could not fetch bios' });
    const data = await r.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return res.json(content);
  }

  // POST — single: { name, field, value }  OR  bulk: { bulk: [{name, field, value}, ...] }
  if (req.method === 'POST') {
    const { name, field, value, bulk } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (name && field !== undefined ? [{ name, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'name+field or bulk array required' });

    for (let attempt = 0; attempt < 5; attempt++) {
      const getRes = await fetch(API_BASE, { headers });
      if (!getRes.ok) return res.status(500).json({ error: 'Could not read file' });
      const fileData = await getRes.json();
      const sha = fileData.sha;
      const bios = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

      for (const { name: n, field: f, value: v } of changes) {
        if (!bios[n]) bios[n] = {};
        bios[n][f] = v;
      }

      const msg = changes.length === 1 ? `Update bio: ${changes[0].name}` : `Bulk bio update: ${changes.length} fields`;
      const commitRes = await fetch(API_BASE, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: msg,
          content: Buffer.from(JSON.stringify(bios, null, 2)).toString('base64'),
          sha,
          branch: BRANCH,
        }),
      });

      if (commitRes.ok) return res.json({ ok: true, count: changes.length });
      if (commitRes.status === 409 && attempt < 4) continue;
      const err = await commitRes.text();
      return res.status(500).json({ error: 'Commit failed', detail: err });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
