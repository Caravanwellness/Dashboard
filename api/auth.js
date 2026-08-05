import crypto from 'crypto';
import { getUser } from './_lib/token.js';
import { ghReadJson, ghWriteJson } from './_lib/github.js';

const REPO        = 'Caravanwellness/Dashboard';
const PATH        = 'users.json';
const PENDING_PATH = 'pending_signups.json';
const BRANCH      = 'main';
const OTP_TTL_MS  = 10 * 60 * 1000; // 10 minutes

async function sendOtpEmail(toEmail, name, otp) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');
  const from = process.env.RESEND_FROM || 'noreply@caravanwellness.com';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: 'Your Caravan Dashboard verification code',
      html: `<p>Hi ${name},</p>
<p>Your verification code for the Caravan Wellness Content Dashboard is:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1a1a2e">${otp}</p>
<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || `Resend API error ${r.status}`);
  }
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

    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if ((action === 'signup' || action === 'login') && !password)
      return res.status(400).json({ error: 'Email and password are required.' });
    const emailLow = email.toLowerCase().trim();

    // Master account — bypasses GitHub API entirely (remove once env vars are set up)
    if (action === 'login' && emailLow === 'info@caravanwellness.com' && password === 'password45') {
      return res.json({ ok: true, token: makeToken('info@caravanwellness.com', 'Caravan Admin'), name: 'Caravan Admin', email: 'info@caravanwellness.com' });
    }

    // Sign up — send OTP, do not create account yet
    if (action === 'signup') {
      if (!emailLow.endsWith('@caravanwellness.com'))
        return res.status(403).json({ error: 'Only @caravanwellness.com email addresses can sign up.' });
      if (!name || name.trim().length < 2)
        return res.status(400).json({ error: 'Please enter your full name.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      // Check email not already registered
      const { data: users } = await readUsers(token);
      if (users[emailLow])
        return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

      // Generate OTP and store pending signup
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const trimmedName = name.trim();
      let pending = {};
      try { const r = await ghReadJson(REPO, PENDING_PATH, token); pending = r.data || {}; } catch(e) {}
      pending[emailLow] = {
        name: trimmedName,
        passwordHash: hashPw(password, emailLow),
        otp,
        expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      };
      try { await ghWriteJson(REPO, PENDING_PATH, BRANCH, pending, `Pending signup: ${emailLow}`, token, null); } catch(e) {}

      await sendOtpEmail(emailLow, trimmedName, otp);
      return res.json({ ok: true, pendingVerification: true, email: emailLow });
    }

    // Verify OTP and create account
    if (action === 'verify') {
      const { code } = req.body || {};
      if (!emailLow || !code) return res.status(400).json({ error: 'Email and code are required.' });

      let pending = {};
      try { const r = await ghReadJson(REPO, PENDING_PATH, token); pending = r.data || {}; } catch(e) {}
      const entry = pending[emailLow];
      if (!entry) return res.status(400).json({ error: 'No pending signup found. Please start over.' });
      if (new Date(entry.expiresAt) < new Date()) {
        delete pending[emailLow];
        try { await ghWriteJson(REPO, PENDING_PATH, BRANCH, pending, `Expire signup: ${emailLow}`, token, null); } catch(e) {}
        return res.status(400).json({ error: 'Verification code has expired. Please sign up again.' });
      }
      if (entry.otp !== String(code).trim())
        return res.status(400).json({ error: 'Incorrect code. Please try again.' });

      // Create the account
      const { data: users, sha } = await readUsers(token, { skipCache: true });
      users[emailLow] = {
        name: entry.name,
        passwordHash: entry.passwordHash,
        createdAt: new Date().toISOString(),
      };
      await writeUsers(users, sha, token);

      // Clean up pending entry
      delete pending[emailLow];
      try { await ghWriteJson(REPO, PENDING_PATH, BRANCH, pending, `Complete signup: ${emailLow}`, token, null); } catch(e) {}

      return res.json({ ok: true, token: makeToken(emailLow, entry.name), name: entry.name, email: emailLow });
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
