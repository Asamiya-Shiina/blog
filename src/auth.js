'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}
if (SECRET === 'change-me-to-a-random-string') {
  console.error('SESSION_SECRET is still the default placeholder — set a real secret in .env');
  process.exit(1);
}

const COOKIE_NAME = 'sid';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 天
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const BCRYPT_COST = 12;

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

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
  return db.prepare('SELECT id, username, role, created_at, password_hash, hash_version FROM users WHERE username = ?').get(username) || null;
}

function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
}

function createUser({ username, password, preHashed }) {
  const hash = bcrypt.hashSync(preHashed ? password : sha256(password), BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, hash_version)
    VALUES (?, ?, 'admin', 2)
  `).run(username, hash);
  return getUserById(info.lastInsertRowid);
}

function deleteUser(id) {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}

function updatePassword(id, newPassword) {
  const hash = bcrypt.hashSync(sha256(newPassword), BCRYPT_COST);
  const info = db.prepare('UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?').run(hash, id);
  return info.changes > 0;
}

// 验证密码，自动处理 v1(旧) 和 v2(新) 两种 hash 格式
// 前端发送 { password: 明文, password_hash: sha256(明文) } 两个字段
// 不依赖数据库中的 hash_version，而是自动检测并迁移
// 返回 { ok, user? }
function verifyPassword({ password, password_hash }, user) {
  if (!user) return { ok: false };

  // 优先尝试 v2：比对 sha256(明文) 与 bcrypt(sha256(明文))
  if (password_hash && user.hash_version === 2) {
    const ok = bcrypt.compareSync(password_hash, user.password_hash);
    if (ok) return { ok: true, user };
    // v2 标记但比对失败，可能是 hash_version 被误标，继续尝试 v1
  }

  // 尝试 v1：比对明文与 bcrypt(明文)
  if (password) {
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (ok) {
      // 自动迁移到 v2
      if (password_hash) {
        const newHash = bcrypt.hashSync(password_hash, BCRYPT_COST);
        db.prepare('UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?').run(newHash, user.id);
      }
      return { ok: true, user };
    }
  }

  // v2 比对（hash_version 不是 2 但提供了 password_hash 的情况）
  if (password_hash) {
    const ok = bcrypt.compareSync(password_hash, user.password_hash);
    if (ok) {
      // 标记为 v2
      db.prepare('UPDATE users SET hash_version = 2 WHERE id = ?').run(user.id);
      return { ok: true, user };
    }
  }

  return { ok: false };
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
  verifyPassword,
  sha256,
  BCRYPT_COST,
};