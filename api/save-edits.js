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

  // POST — single field: { id, field, value }
  //        bulk rename: { bulk: [{id, field, value}, ...], message }
  if (req.method === 'POST') {
    const { id, field, value, bulk, message } = req.body || {};

    // Build list of changes
    const changes = bulk && Array.isArray(bulk) ? bulk : (id && field !== undefined ? [{ id, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'id+field or bulk array required' });

    const ts = new Date().toISOString();
    const commitMsg = message || (changes.length === 1 ? `Edit ${changes[0].id}: ${changes[0].field}` : `Bulk update ${changes.length} fields`);

    // Retry loop for SHA conflicts
    for (let attempt = 0; attempt < 5; attempt++) {
      const getRes = await fetch(API_BASE, { headers });
      if (!getRes.ok) return res.status(500).json({ error: 'Could not read edits file' });
      const fileData = await getRes.json();
      const sha   = fileData.sha;
      const edits = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

      for (const { id: cId, field: cField, value: cVal } of changes) {
        if (!edits[cId]) edits[cId] = {};
        edits[cId][cField] = cVal;
        edits[cId]._at = ts;
      }

      const commitRes = await fetch(API_BASE, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: commitMsg,
          content: Buffer.from(JSON.stringify(edits, null, 2)).toString('base64'),
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
