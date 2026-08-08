'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set in .env');
  process.exit(1);
}
// 启动时把环境变量里的明文密码哈希一次，之后每次登录比对哈希
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 12);

const COOKIE_NAME = 'sid';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 天
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

function sign(userId, expiresAt) {
  const payload = `${userId}.${expiresAt}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresAt, mac] = parts;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (mac.length !== expected.length) return null;
  let macBuf, expBuf;
  try {
    macBuf = Buffer.from(mac, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return null; }
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  const expNum = Number(expiresAt);
  const userIdNum = Number(userId);
  if (!Number.isFinite(expNum) || !Number.isFinite(userIdNum)) return null;
  if (expNum <= Math.floor(Date.now() / 1000)) return null;
  if (userIdNum <= 0) return null;
  return { userId: userIdNum };
}

function setSessionCookie(res, userId) {
  const expiresAt = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const token = sign(userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: MAX_AGE_SECONDS * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verify(token);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  // 单管理员写死，不再查数据库
  req.user = { id: 1, username: ADMIN_USERNAME };
  next();
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  verify,
  COOKIE_NAME,
  ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH,
};
