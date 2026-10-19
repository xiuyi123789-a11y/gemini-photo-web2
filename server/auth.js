import { Router } from 'express';
import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const COOKIE = 'ql_session';
const TTL = 7 * 24 * 60 * 60 * 1000;
export const digest = token => createHash('sha256').update(token).digest('hex');
export const normalizeUsername = name => String(name || '').trim().toLowerCase();
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Password must be 12-256 characters');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [kind, salt, hash] = encoded.split(':');
  if (kind !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(hash || '')) return false;
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
const readToken = req => {
  const token = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
};

export function createAuth(store, { secure = process.env.NODE_ENV === 'production' } = {}) {
  const router = Router();
  const attempts = new Map();
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  // Use the same scrypt cost for unknown usernames to avoid a cheap enumeration path.
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  const originGuard = (req, res, next) => {
    const origin = req.get('origin');
    const expected = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site')) {
      return res.status(403).json({ error: 'Cross-site request rejected' });
    }
    next();
  };
  const authenticate = async (req, res, next) => {
    if (!store) return next(); // Local development compatibility only.
    const token = readToken(req);
    const user = token ? await store.getSession(digest(token)) : null;
    if (!user) return res.status(401).json({ error: '请先登录', code: 'LOGIN_REQUIRED' });
    req.authUser = user;
    next();
  };
  router.get('/me', async (req, res) => {
    if (!store) return res.json({ mode: 'legacy', user: null });
    const token = readToken(req);
    const user = token ? await store.getSession(digest(token)) : null;
    res.json({ mode: 'accounts', user: user || null });
  });
  router.post('/login', async (req, res) => {
    if (!store) return res.status(503).json({ error: '账号模式需要 PostgreSQL' });
    const now = Date.now();
    for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
    const key = req.ip;
    const record = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (record.count >= 5 || (!attempts.has(key) && attempts.size >= 10000)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: '登录尝试过多，请稍后重试' });
    }
    // Count before awaiting expensive hashing, including concurrent login attempts.
    record.count++;
    attempts.set(key, record);
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!/^[a-z0-9_-]{3,40}$/.test(username) || typeof password !== 'string' || password.length > 256) {
      return res.status(401).json({ error: '用户名或密码不正确' });
    }
    const user = await store.findUser(username);
    const valid = await verifyPassword(password, user?.password_hash || await dummyHash);
    if (!user || !valid) return res.status(401).json({ error: '用户名或密码不正确' });
    attempts.delete(key);
    const oldToken = readToken(req);
    if (oldToken) await store.removeSession(digest(oldToken));
    const token = randomBytes(32).toString('base64url');
    await store.addSession(digest(token), user.id, new Date(now + TTL));
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: TTL });
    res.json({ user: { id: user.id, username: user.username } });
  });
  router.post('/logout', async (req, res) => {
    const token = readToken(req);
    if (store && token) await store.removeSession(digest(token));
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ success: true });
  });
  return { router, authenticate, originGuard };
}
