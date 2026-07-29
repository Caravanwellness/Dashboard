import crypto from 'crypto';
import { getUser } from './_lib/token.js';
import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO   = 'Caravanwellness/Dashboard';
const PATH   = 'users.json';
const BRANCH = 'main';

function hashPw(password, email) {
  return crypto.createHash('sha256').update(password + ':' + email).digest('hex');
}

function makeToken(email, name) {
  const secret  = process.env.SESSION_SECRET;
  const expiry  = Date.now() + 8 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ email, name, expiry })).toString('base64');
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// Module-level cache — persists across warm Vercel invocations, skips GitHub read on login
let _usersCache = null;
let _usersCacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function readUsers(token, { skipCache = false } = {}) {
  if (!skipCache && _usersCache && Date.now() - _usersCacheAt < CACHE_TTL) {
    return _usersCache;
  }
  const result = await ghReadJson(REPO, PATH, token);
  _usersCache = result;
  _usersCacheAt = Date.now();
  return result;
}

async function writeUsers(users, sha, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await ghWriteJson(REPO, PATH, BRANCH, users, 'Update users', token, sha);
    if (ok) {
      // Update cache so subsequent logins don't need a GitHub read
      _usersCache = { data: users, sha: typeof ok === 'string' ? ok : sha };
      _usersCacheAt = Date.now();
      return;
    }
  }
  throw new Error('Could not write users after retries');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SESSION_SECRET)
    return res.status(500).json({ error: 'SERVER MISCONFIGURATION: SESSION_SECRET is not set.' });
  if (!process.env.GITHUB_TOKEN)
    return res.status(500).json({ error: 'SERVER MISCONFIGURATION: GITHUB_TOKEN is not set.' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const { action, email, password, name, targetEmail, newPassword } = req.body || {};

  try {
    // List users (admin)
    if (action === 'list') {
      const caller = getUser(req);
      if (!caller) return res.status(401).json({ error: 'Unauthorized' });
      const { data: users } = await readUsers(token);
      return res.json({ users: Object.entries(users).map(([e, u]) => ({ email: e, name: u.name, createdAt: u.createdAt })) });
    }

    // Admin password reset
    if (action === 'reset') {
      const caller = getUser(req);
      if (!caller) return res.status(401).json({ error: 'Unauthorized' });
      if (!targetEmail || !newPassword) return res.status(400).json({ error: 'targetEmail and newPassword required.' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      const target = targetEmail.toLowerCase().trim();
      const { data: users, sha } = await readUsers(token, { skipCache: true });
      if (!users[target]) return res.status(404).json({ error: 'No account found with that email.' });
      users[target].passwordHash = hashPw(newPassword, target);
      users[target].passwordResetAt = new Date().toISOString();
      await writeUsers(users, sha, token);
      return res.json({ ok: true, name: users[target].name });
    }

    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const emailLow = email.toLowerCase().trim();

    // Master account — bypasses GitHub API entirely (remove once env vars are set up)
    if (action === 'login' && emailLow === 'info@caravanwellness.com' && password === 'password45') {
      return res.json({ ok: true, token: makeToken('info@caravanwellness.com', 'Caravan Admin'), name: 'Caravan Admin', email: 'info@caravanwellness.com' });
    }

    // Sign up / reset password
    if (action === 'signup') {
      if (!emailLow.endsWith('@caravanwellness.com'))
        return res.status(403).json({ error: 'Only @caravanwellness.com email addresses can sign up.' });
      if (!name || name.trim().length < 2)
        return res.status(400).json({ error: 'Please enter your full name.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const { data: users, sha } = await readUsers(token, { skipCache: true });
      users[emailLow] = {
        name: name.trim(),
        passwordHash: hashPw(password, emailLow),
        createdAt: users[emailLow]?.createdAt || new Date().toISOString(),
      };
      await writeUsers(users, sha, token);
      return res.json({ ok: true, token: makeToken(emailLow, name.trim()), name: name.trim(), email: emailLow });
    }

    // Login
    if (action === 'login') {
      const { data: users } = await readUsers(token);
      const user = users[emailLow];
      if (!user) return res.status(401).json({ error: 'No account found with this email.' });
      if (user.passwordHash !== hashPw(password, emailLow))
        return res.status(401).json({ error: 'Incorrect password.' });
      return res.json({ ok: true, token: makeToken(emailLow, user.name), name: user.name, email: emailLow });
    }

    return res.status(400).json({ error: 'Unknown action.' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
