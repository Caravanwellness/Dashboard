import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO   = 'Caravanwellness/Dashboard';
const BRANCH = 'main';

// Photos stay in the large file (Git Data API, ~6 calls, rare operation)
const PHOTO_PATH = 'creator_bios.json';
// Text fields (bio, creds, etc.) go in a small file (Contents API, 2 calls, frequent)
const TEXT_PATH  = 'creator_bios_text.json';

function isPhotoField(f) { return f === 'photo'; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;

  // GET — merge text + photo files into one response
  if (req.method === 'GET') {
    try {
      const [{ data: textBios }, { data: photoBios }] = await Promise.all([
        ghReadJson(REPO, TEXT_PATH, token),
        ghReadJson(REPO, PHOTO_PATH, token),
      ]);
      // Merge: text fields override photo-file text fields; photos come from photoBios
      const merged = {};
      for (const [name, fields] of Object.entries(photoBios)) {
        merged[name] = { ...fields };
      }
      for (const [name, fields] of Object.entries(textBios)) {
        if (!merged[name]) merged[name] = {};
        Object.assign(merged[name], fields);
      }
      return res.json(merged);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — single: { name, field, value }  OR  bulk: { bulk: [{name, field, value},...] }
  if (req.method === 'POST') {
    const { name, field, value, bulk } = req.body || {};
    const changes = bulk && Array.isArray(bulk) ? bulk : (name && field !== undefined ? [{ name, field, value }] : null);
    if (!changes) return res.status(400).json({ error: 'name+field or bulk array required' });

    // Split changes by destination file
    const photoChanges = changes.filter(c => isPhotoField(c.field));
    const textChanges  = changes.filter(c => !isPhotoField(c.field));

    const delay = ms => new Promise(r => setTimeout(r, ms));

    async function applyChanges(path, changeset) {
      const msg = changeset.length === 1
        ? `Update bio: ${changeset[0].name}`
        : `Bulk bio update: ${changeset.length} fields`;

      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await delay(600 + Math.random() * 400);
        try {
          const { data: bios, sha } = await ghReadJson(REPO, path, token);
          for (const { name: n, field: f, value: v } of changeset) {
            if (!bios[n]) bios[n] = {};
            bios[n][f] = v;
          }
          const ok = await ghWriteJson(REPO, path, BRANCH, bios, msg, token, sha);
          if (ok) return;
          // false = SHA conflict, retry
        } catch(e) {
          throw e;
        }
      }
      throw new Error('Too many concurrent writes — try again');
    }

    try {
      // Run photo and text writes in parallel when both present, sequentially otherwise
      const tasks = [];
      if (photoChanges.length) tasks.push(applyChanges(PHOTO_PATH, photoChanges));
      if (textChanges.length)  tasks.push(applyChanges(TEXT_PATH,  textChanges));
      await Promise.all(tasks);
      return res.json({ ok: true, count: changes.length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
