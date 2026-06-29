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

  // POST — update a single creator's bio fields
  if (req.method === 'POST') {
    const { name, field, value } = req.body || {};
    if (!name || !field) return res.status(400).json({ error: 'name and field required' });

    // Fetch current file + SHA
    const getRes = await fetch(API_BASE, { headers });
    if (!getRes.ok) return res.status(500).json({ error: 'Could not read file' });
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const bios = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

    // Update
    if (!bios[name]) bios[name] = {};
    bios[name][field] = value;

    // Commit
    const newContent = Buffer.from(JSON.stringify(bios, null, 2)).toString('base64');
    const commitRes = await fetch(API_BASE, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Update bio: ${name}`,
        content: newContent,
        sha,
        branch: BRANCH,
      }),
    });

    if (!commitRes.ok) {
      const err = await commitRes.text();
      return res.status(500).json({ error: 'Commit failed', detail: err });
    }
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
