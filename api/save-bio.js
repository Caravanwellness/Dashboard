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
  const ghHeaders    = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // Fetch bios JSON — handles files > 1MB via download_url fallback
  async function fetchBios() {
    const r = await fetch(API_BASE, { headers: ghHeaders });
    if (!r.ok) throw new Error(`Contents API ${r.status}`);
    const meta = await r.json();
    let text;
    if (meta.content && meta.content.trim()) {
      text = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    } else if (meta.download_url) {
      // File > 1MB — fetch raw content directly
      const raw = await fetch(meta.download_url);
      if (!raw.ok) throw new Error(`download_url fetch ${raw.status}`);
      text = await raw.text();
    } else {
      return { data: {}, sha: meta.sha };
    }
    return { data: JSON.parse(text), sha: meta.sha };
  }

  // GET — return current bios
  if (req.method === 'GET') {
    try {
      const { data } = await fetchBios();
      return res.json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — single: { name, field, value }  OR  bulk: { bulk: [{name, field, value}, ...] }
  if (req.method === 'POST') {
    const { name, field, value, bulk } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (name && field !== undefined ? [{ name, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'name+field or bulk array required' });

    for (let attempt = 0; attempt < 5; attempt++) {
      let data, sha;
      try {
        ({ data, sha } = await fetchBios());
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }

      for (const { name: n, field: f, value: v } of changes) {
        if (!data[n]) data[n] = {};
        data[n][f] = v;
      }

      const newContent = JSON.stringify(data, null, 2);

      // Use Git Data API for write so it works regardless of file size
      const refRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers: ghHeaders });
      if (!refRes.ok) return res.status(500).json({ error: 'Could not fetch ref' });
      const { object: { sha: commitSha } } = await refRes.json();

      // Get the tree SHA from the commit
      const commitDataRes = await fetch(`https://api.github.com/repos/${REPO}/git/commits/${commitSha}`, { headers: ghHeaders });
      if (!commitDataRes.ok) return res.status(500).json({ error: 'Could not fetch commit' });
      const { tree: { sha: treeSha } } = await commitDataRes.json();

      // Create blob
      const blobRes = await fetch(`https://api.github.com/repos/${REPO}/git/blobs`, {
        method: 'POST', headers: ghHeaders,
        body: JSON.stringify({ content: newContent, encoding: 'utf-8' }),
      });
      if (!blobRes.ok) return res.status(500).json({ error: 'Could not create blob' });
      const { sha: blobSha } = await blobRes.json();

      // Create tree using the commit's tree SHA as base
      const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees`, {
        method: 'POST', headers: ghHeaders,
        body: JSON.stringify({ base_tree: treeSha, tree: [{ path: FILE_PATH, mode: '100644', type: 'blob', sha: blobSha }] }),
      });
      if (!treeRes.ok) return res.status(500).json({ error: 'Could not create tree' });
      const { sha: treeSha } = await treeRes.json();

      // Create commit
      const msg = changes.length === 1 ? `Update bio: ${changes[0].name}` : `Bulk bio update: ${changes.length} fields`;
      const commitRes = await fetch(`https://api.github.com/repos/${REPO}/git/commits`, {
        method: 'POST', headers: ghHeaders,
        body: JSON.stringify({ message: msg, tree: treeSha, parents: [commitSha] }),
      });
      if (!commitRes.ok) return res.status(500).json({ error: 'Could not create commit' });
      const { sha: newCommitSha } = await commitRes.json();

      // Update branch ref
      const updateRes = await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH', headers: ghHeaders,
        body: JSON.stringify({ sha: newCommitSha }),
      });
      if (updateRes.ok) return res.json({ ok: true, count: changes.length });
      if (updateRes.status === 422 && attempt < 4) continue;
      const err = await updateRes.text();
      return res.status(500).json({ error: 'Ref update failed', detail: err });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
