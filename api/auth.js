import crypto from 'crypto';
import { getUser } from './_lib/token.js';

const REPO      = 'Caravanwellness/Dashboard';
const FILE_PATH = 'users.json';
const BRANCH    = 'main';
const API_BASE  = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

function ghHeaders() {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

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

async function readUsers() {
  const r = await fetch(API_BASE, { headers: ghHeaders() });
  if (!r.ok) throw new Error('Could not read users file');
  const data = await r.json();
  return { sha: data.sha, users: JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')) };
}

async function writeUsers(users, sha) {
  const content = Buffer.from(JSON.stringify(users, null, 2)).toString('base64');
  const r = await fetch(API_BASE, {
    method: 'PUT', headers: ghHeaders(),
    body: JSON.stringify({ message: 'Update users', content, sha, branch: BRANCH }),
  });
  if (!r.ok) throw new Error('Could not write users');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'SERVER MISCONFIGURATION: SESSION_SECRET is not set.' });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'SERVER MISCONFIGURATION: GITHUB_TOKEN is not set.' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, password, name, targetEmail, newPassword } = req.body || {};

  // List all users (admin)
  if (action === 'list') {
    const caller = getUser(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const { users } = await readUsers();
    const list = Object.entries(users).map(([email, u]) => ({ email, name: u.name, createdAt: u.createdAt }));
    return res.json({ users: list });
  }

  // Admin password reset
  if (action === 'reset') {
    const caller = getUser(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized — you must be logged in to reset passwords.' });
    if (!targetEmail || !newPassword) return res.status(400).json({ error: 'targetEmail and newPassword required.' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const target = targetEmail.toLowerCase().trim();
    const { sha, users } = await readUsers();
    if (!users[target]) return res.status(404).json({ error: 'No account found with that email.' });

    users[target].passwordHash = hashPw(newPassword, target);
    users[target].passwordResetAt = new Date().toISOString();
    users[target].passwordResetBy = caller.email;
    await writeUsers(users, sha);

    return res.json({ ok: true, name: users[target].name });
  }

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const emailLow = email.toLowerCase().trim();

  if (action === 'signup') {
    if (!emailLow.endsWith('@caravanwellness.com'))
      return res.status(403).json({ error: 'Only @caravanwellness.com email addresses can sign up.' });
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: 'Please enter your full name.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { sha, users } = await readUsers();
    if (users[emailLow]) return res.status(409).json({ error: 'An account with this email already exists.' });

    users[emailLow] = {
      name: name.trim(),
      passwordHash: hashPw(password, emailLow),
      createdAt: new Date().toISOString(),
    };
    await writeUsers(users, sha);

    return res.json({ ok: true, token: makeToken(emailLow, name.trim()), name: name.trim(), email: emailLow });
  }

  if (action === 'login') {
    const { users } = await readUsers();
    const user = users[emailLow];
    if (!user) return res.status(401).json({ error: 'No account found with this email.' });
    if (user.passwordHash !== hashPw(password, emailLow))
      return res.status(401).json({ error: 'Incorrect password.' });

    return res.json({ ok: true, token: makeToken(emailLow, user.name), name: user.name, email: emailLow });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
