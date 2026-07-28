// Shared GitHub helper — handles files > 1MB via download_url + Git Data API writes

export function ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

// Read a JSON file from GitHub — falls back to download_url for files > 1MB
export async function ghReadJson(repo, path, token) {
  const headers = ghHeaders(token);
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
  if (r.status === 404) return { data: {}, sha: null };
  // GitHub returns 403 for files > 100MB; for files 1-100MB it returns 200 with download_url
  if (!r.ok) throw new Error(`GitHub read ${r.status}: ${await r.text()}`);
  const meta = await r.json();

  let text;
  if (meta.content && meta.content.trim()) {
    text = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  } else if (meta.download_url) {
    // Auth header required for private repos
    const raw = await fetch(meta.download_url, { headers: { Authorization: `token ${token}` } });
    if (!raw.ok) throw new Error(`download_url fetch ${raw.status}`);
    text = await raw.text();
  } else {
    return { data: {}, sha: meta.sha };
  }
  return { data: JSON.parse(text), sha: meta.sha };
}

// Write a JSON file to GitHub using Git Data API (no size limit, handles > 1MB)
// Returns true on success, throws on unrecoverable error
// Caller should retry on 422 (concurrent write conflict)
export async function ghWriteJson(repo, path, branch, content, message, token) {
  const headers = ghHeaders(token);
  const base = `https://api.github.com/repos/${repo}`;

  // Get latest commit SHA on branch
  const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
  if (!refRes.ok) throw new Error(`ref fetch ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  // Get tree SHA from that commit
  const commitRes = await fetch(`${base}/git/commits/${commitSha}`, { headers });
  if (!commitRes.ok) throw new Error(`commit fetch ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  // Create blob with new content
  const blobRes = await fetch(`${base}/git/blobs`, {
    method: 'POST', headers,
    body: JSON.stringify({ content: JSON.stringify(content, null, 2), encoding: 'utf-8' }),
  });
  if (!blobRes.ok) throw new Error(`blob create ${blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  // Create new tree
  const newTreeRes = await fetch(`${base}/git/trees`, {
    method: 'POST', headers,
    body: JSON.stringify({ base_tree: treeSha, tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }] }),
  });
  if (!newTreeRes.ok) throw new Error(`tree create ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  // Create commit
  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: 'POST', headers,
    body: JSON.stringify({ message, tree: newTreeSha, parents: [commitSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`commit create ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  // Update branch ref
  const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (updateRes.ok) return true;
  if (updateRes.status === 422) return false; // concurrent write — caller should retry
  throw new Error(`ref update ${updateRes.status}`);
}
