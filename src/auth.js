'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}

const COOKIE_NAME = 'sid';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 天
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const BCRYPT_COST = 12;

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

// —— 用户 CRUD ——
const db = require('./db');

function getUserById(id) {
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) || null;
}

function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare('SELECT id, username, role, created_at, password_hash FROM users WHERE username = ?').get(username) || null;
}

function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
}

function createUser({ username, password }) {
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'admin')
  `).run(username, hash);
  return getUserById(info.lastInsertRowid);
}

function deleteUser(id) {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}

function updatePassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  return info.changes > 0;
}

// —— 中间件 ——
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verify(token);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const user = getUserById(session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
  verify,
  COOKIE_NAME,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  deleteUser,
  updatePassword,
  BCRYPT_COST,
};