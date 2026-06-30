export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO         = 'Caravanwellness/Dashboard';
  const FILE_PATH    = 'content_edits.json';
  const BRANCH       = 'main';
  const API_BASE     = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
  const headers      = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // GET — return all edits
  if (req.method === 'GET') {
    const r = await fetch(API_BASE, { headers });
    if (!r.ok) return res.status(500).json({ error: 'Could not fetch edits' });
    const data = await r.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return res.json(content);
  }

  // POST — update a single item's field: { id, field, value }
  if (req.method === 'POST') {
    const { id, field, value } = req.body || {};
    if (!id || !field) return res.status(400).json({ error: 'id and field required' });

    // Retry loop to handle concurrent write conflicts (SHA mismatch)
    for (let attempt = 0; attempt < 3; attempt++) {
      const getRes = await fetch(API_BASE, { headers });
      if (!getRes.ok) return res.status(500).json({ error: 'Could not read edits file' });
      const fileData = await getRes.json();
      const sha = fileData.sha;
      const edits = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

      if (!edits[id]) edits[id] = {};
      edits[id][field] = value;
      edits[id]._at = new Date().toISOString();

      const newContent = Buffer.from(JSON.stringify(edits, null, 2)).toString('base64');
      const commitRes = await fetch(API_BASE, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `Edit ${id}: ${field}`,
          content: newContent,
          sha,
          branch: BRANCH,
        }),
      });

      if (commitRes.ok) return res.json({ ok: true });

      // 409 = SHA conflict (concurrent edit) — retry
      if (commitRes.status === 409 && attempt < 2) continue;

      const err = await commitRes.text();
      return res.status(500).json({ error: 'Commit failed', detail: err });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
