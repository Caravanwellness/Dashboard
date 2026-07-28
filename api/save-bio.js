export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO         = 'Caravanwellness/Dashboard';
  const FILE_PATH    = 'creator_bios.json';
  const BRANCH       = 'main';
  const gh           = (path, opts={}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...(opts.headers||{}),
    },
  });

  // GET — fetch file via Git Data API (works for files > 1MB)
  if (req.method === 'GET') {
    // Get the latest commit SHA on main
    const refRes = await gh(`/git/ref/heads/${BRANCH}`);
    if (!refRes.ok) return res.status(500).json({ error: 'Could not fetch ref' });
    const { object: { sha: commitSha } } = await refRes.json();

    // Get the tree for that commit
    const treeRes = await gh(`/git/trees/${commitSha}?recursive=1`);
    if (!treeRes.ok) return res.status(500).json({ error: 'Could not fetch tree' });
    const { tree } = await treeRes.json();

    const entry = tree.find(f => f.path === FILE_PATH);
    if (!entry) return res.json({});

    // Fetch blob by SHA
    const blobRes = await gh(`/git/blobs/${entry.sha}`);
    if (!blobRes.ok) return res.status(500).json({ error: 'Could not fetch blob' });
    const { content } = await blobRes.json();
    const data = JSON.parse(Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8'));
    return res.json(data);
  }

  // POST — single: { name, field, value }  OR  bulk: { bulk: [{name, field, value}, ...] }
  if (req.method === 'POST') {
    const { name, field, value, bulk } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (name && field !== undefined ? [{ name, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'name+field or bulk array required' });

    for (let attempt = 0; attempt < 5; attempt++) {
      // Get latest commit on branch
      const refRes = await gh(`/git/ref/heads/${BRANCH}`);
      if (!refRes.ok) return res.status(500).json({ error: 'Could not fetch ref' });
      const { object: { sha: commitSha } } = await refRes.json();

      // Get tree
      const treeRes = await gh(`/git/trees/${commitSha}?recursive=1`);
      if (!treeRes.ok) return res.status(500).json({ error: 'Could not fetch tree' });
      const { tree } = await treeRes.json();

      // Get current bios
      const entry = tree.find(f => f.path === FILE_PATH);
      let bios = {};
      if (entry) {
        const blobRes = await gh(`/git/blobs/${entry.sha}`);
        if (!blobRes.ok) return res.status(500).json({ error: 'Could not fetch blob' });
        const { content } = await blobRes.json();
        bios = JSON.parse(Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8'));
      }

      // Apply changes
      for (const { name: n, field: f, value: v } of changes) {
        if (!bios[n]) bios[n] = {};
        bios[n][f] = v;
      }

      // Create new blob
      const newContent = JSON.stringify(bios, null, 2);
      const blobCreateRes = await gh('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: newContent, encoding: 'utf-8' }),
      });
      if (!blobCreateRes.ok) return res.status(500).json({ error: 'Could not create blob' });
      const { sha: newBlobSha } = await blobCreateRes.json();

      // Create new tree
      const newTreeRes = await gh('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: commitSha,
          tree: [{ path: FILE_PATH, mode: '100644', type: 'blob', sha: newBlobSha }],
        }),
      });
      if (!newTreeRes.ok) return res.status(500).json({ error: 'Could not create tree' });
      const { sha: newTreeSha } = await newTreeRes.json();

      // Create commit
      const msg = changes.length === 1 ? `Update bio: ${changes[0].name}` : `Bulk bio update: ${changes.length} fields`;
      const commitRes = await gh('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message: msg, tree: newTreeSha, parents: [commitSha] }),
      });
      if (!commitRes.ok) return res.status(500).json({ error: 'Could not create commit' });
      const { sha: newCommitSha } = await commitRes.json();

      // Update branch ref (fast-forward only; 422 = someone else pushed — retry)
      const updateRes = await gh(`/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
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
