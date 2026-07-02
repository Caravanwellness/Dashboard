import crypto from 'crypto';

export function verifyToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return null;
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    if (data.expiry < Date.now()) return null;
    return data; // { email, name, expiry }
  } catch(e) { return null; }
}

export function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifyToken(token);
}
