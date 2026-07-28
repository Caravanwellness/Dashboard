// Shared GitHub helper — efficient reads/writes, handles files > 1MB

export function ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

// Read JSON file — returns { data, sha }
// Falls back to download_url (with auth) for files > 1MB
export async function ghReadJson(repo, path, token) {
  const headers = ghHeaders(token);
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub read ${r.status}: ${await r.text()}`);
  const meta = await r.json();

  let text;
  if (meta.content && meta.content.trim()) {
    text = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  } else if (meta.download_url) {
    // File > 1MB — fetch raw content with auth (required for private repos)
    const raw = await fetch(meta.download_url, { headers: { Authorization: `token ${token}` } });
    if (!raw.ok) throw new Error(`download_url fetch ${raw.status}`);
    text = await raw.text();
  } else {
    return { data: {}, sha: meta.sha };
  }
  return { data: JSON.parse(text), sha: meta.sha };
}

// Write JSON file — uses Contents API PUT (1 call) when sha is provided.
// Falls back to Git Data API (5 calls) only when the file is too large for Contents API.
// Returns true on success, false on SHA conflict (caller should retry).
export async function ghWriteJson(repo, path, branch, content, message, token, sha) {
  const headers = ghHeaders(token);
  const base = `https://api.github.com/repos/${repo}`;
  const body = JSON.stringify(content, null, 2);

  // Try Contents API first (fast — 1 call)
  if (sha !== undefined) {
    const putBody = {
      message,
      content: Buffer.from(body).toString('base64'),
      branch,
    };
    if (sha) putBody.sha = sha;

    const r = await fetch(`${base}/contents/${path}`, {
      method: 'PUT', headers,
      body: JSON.stringify(putBody),
    });
    if (r.ok) return true;
    if (r.status === 409) return false; // SHA conflict — caller retries
    // For other errors (e.g. file too large), fall through to Git Data API
    const errText = await r.text();
    // Only fall through if it looks like a size issue; otherwise surface the error
    if (!errText.includes('too large') && r.status !== 422) {
      throw new Error(`Contents API write ${r.status}: ${errText}`);
    }
  }

  // Git Data API fallback for large files (5 calls)
  const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
  if (!refRes.ok) throw new Error(`ref fetch ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  const commitRes = await fetch(`${base}/git/commits/${commitSha}`, { headers });
  if (!commitRes.ok) throw new Error(`commit fetch ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  const blobRes = await fetch(`${base}/git/blobs`, {
    method: 'POST', headers,
    body: JSON.stringify({ content: body, encoding: 'utf-8' }),
  });
  if (!blobRes.ok) throw new Error(`blob create ${blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  const newTreeRes = await fetch(`${base}/git/trees`, {
    method: 'POST', headers,
    body: JSON.stringify({ base_tree: treeSha, tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }] }),
  });
  if (!newTreeRes.ok) throw new Error(`tree create ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: 'POST', headers,
    body: JSON.stringify({ message, tree: newTreeSha, parents: [commitSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`commit create ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (updateRes.ok) return true;
  if (updateRes.status === 422) return false; // concurrent write — retry
  throw new Error(`ref update ${updateRes.status}`);
}
