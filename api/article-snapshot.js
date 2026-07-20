import { getGoogleToken, extractDocId } from './_lib/google-auth.js';
import { getUser } from './_lib/token.js';

const OWNER  = 'Caravanwellness';
const REPO   = 'Dashboard';
const PATH   = 'article_snapshots.json';
const BRANCH = 'main';
const MAX_SNAPSHOTS = 5;
const MAX_CONTENT   = 60000; // chars per snapshot

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
  const body = {
    message: 'Update article_snapshots.json',
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub PUT ${r.status}: ${t}`); }
}

async function fetchDocText(docUrl) {
  const docId = extractDocId(docUrl);
  if (!docId) throw new Error('Could not extract Google Doc ID from URL');

  const token = await getGoogleToken('https://www.googleapis.com/auth/drive.readonly');
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (r.status === 403) throw new Error('ACCESS_DENIED');
  if (!r.ok) throw new Error(`Drive export ${r.status}`);
  const text = await r.text();
  return text.slice(0, MAX_CONTENT);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT not configured' });
  }

  // GET — fetch current doc text + return stored snapshots
  if (req.method === 'GET') {
    const { itemId, docUrl } = req.query;
    if (!itemId || !docUrl) return res.status(400).json({ error: 'itemId and docUrl required' });

    const { data } = await ghGet();
    const snapshots = (data[itemId] || []);

    let current = null, fetchError = null;
    try {
      current = await fetchDocText(docUrl);
    } catch (e) {
      fetchError = e.message;
    }

    return res.json({ current, snapshots, fetchError });
  }

  // POST — save a new snapshot
  if (req.method === 'POST') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { itemId, docUrl } = req.body || {};
    if (!itemId || !docUrl) return res.status(400).json({ error: 'itemId and docUrl required' });

    let content, fetchError;
    try {
      content = await fetchDocText(docUrl);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, sha } = await ghGet();
        if (!data[itemId]) data[itemId] = [];
        const version = data[itemId].length + 1;
        data[itemId].push({
          ts:      new Date().toISOString(),
          version,
          content,
          byName:  user.name,
          byEmail: user.email,
        });
        // keep last N snapshots
        if (data[itemId].length > MAX_SNAPSHOTS) {
          data[itemId] = data[itemId].slice(-MAX_SNAPSHOTS);
        }
        await ghPut(data, sha);
        return res.json({ ok: true, version });
      } catch (e) {
        if (attempt < 2 && e.message.includes('409')) continue;
        return res.status(500).json({ error: e.message });
      }
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
