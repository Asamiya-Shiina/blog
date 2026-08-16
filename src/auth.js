'use strict';

// —— 认证与授权模块 ——
// 负责：密码哈希、session 签名/验证、用户 CRUD、鉴权中间件

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

// —— Session Secret 校验 ——
// 这个密钥用于签发和验证 session token（HMAC-SHA256）
// 必须在 .env 中设置，且不能是占位符或过短
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}
if (SECRET === 'change-me-to-a-random-string') {
  console.error('SESSION_SECRET is still the default placeholder — set a real secret in .env');
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error('SESSION_SECRET is too short (minimum 32 characters)');
  process.exit(1);
}

// —— Cookie 配置 ——
const COOKIE_NAME = 'sid';                        // session cookie 名称
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;        // 30 天有效期
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';  // 默认 true，仅 HTTPS 传输
const BCRYPT_COST = 12;                            // bcrypt 计算成本（2^12 = 4096 轮迭代）

// —— SHA-256 哈希 ——
// 用于密码预处理：先 SHA-256 再 bcrypt
// 解决 bcrypt 72 字节输入限制，同时确保客户端和服务端使用相同中间值
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// —— Session Token 签名 ——
// 格式：userId.expiresAt.hmac
// 使用 HMAC-SHA256 对 userId + 过期时间签名，防篡改
function sign(userId, expiresAt) {
  const payload = `${userId}.${expiresAt}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

// —— Session Token 验证 ——
// 解析 token，验证 HMAC 签名（恒定时间比较防时序攻击），检查是否过期
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresAt, mac] = parts;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  // 长度不一致直接拒绝，避免后续 Buffer 比较出错
  if (mac.length !== expected.length) return null;
  let macBuf, expBuf;
  try {
    macBuf = Buffer.from(mac, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return null; }
  // 恒定时间比较：防止通过响应时间推断 MAC 是否接近正确值
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  const expNum = Number(expiresAt);
  const userIdNum = Number(userId);
  if (!Number.isFinite(expNum) || !Number.isFinite(userIdNum)) return null;
  // 检查 token 是否已过期
  if (expNum <= Math.floor(Date.now() / 1000)) return null;
  if (userIdNum <= 0) return null;
  return { userId: userIdNum };
}

// —— 设置 Session Cookie ——
// 签发 token 并写入 httpOnly cookie
// httpOnly: JS 无法读取（防 XSS 窃取）
// sameSite: lax 阻止跨站 POST 携带（防 CSRF）
// secure: 仅 HTTPS 传输（防网络嗅探）
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

// 清除 session cookie（退出登录时使用）
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// —— 用户 CRUD ——
const db = require('./db');

// 根据 ID 查询用户（不返回密码哈希）
function getUserById(id) {
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) || null;
}

// 根据用户名查询用户（返回密码哈希，用于登录验证）
function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare('SELECT id, username, role, created_at, password_hash, hash_version FROM users WHERE username = ?').get(username) || null;
}

// 列出所有用户（管理接口使用）
function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
}

// 创建用户
// preHashed=true 表示 password 已经是 SHA-256 哈希值（来自前端）
// preHashed=false 表示 password 是明文，需要先 SHA-256 再 bcrypt
function createUser({ username, password, preHashed }) {
  const hash = bcrypt.hashSync(preHashed ? password : sha256(password), BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, hash_version)
    VALUES (?, ?, 'admin', 2)
  `).run(username, hash);
  return getUserById(info.lastInsertRowid);
}

// 删除用户
function deleteUser(id) {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}

// 更新密码（始终使用 v2 哈希方案：bcrypt(sha256(明文))）
function updatePassword(id, newPassword) {
  const hash = bcrypt.hashSync(sha256(newPassword), BCRYPT_COST);
  const info = db.prepare('UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?').run(hash, id);
  return info.changes > 0;
}

// —— 密码验证 ——
// 支持两种输入：
//   password_hash: 前端已做 SHA-256（推荐，避免明文传输）
//   password: 明文密码（回退方案，后端自行计算 SHA-256）
function verifyPassword({ password, password_hash }, user) {
  if (!user) return { ok: false };

  // 优先使用 password_hash（前端 SHA-256）
  if (password_hash) {
    return bcrypt.compareSync(password_hash, user.password_hash) ? { ok: true, user } : { ok: false };
  }

  // 回退：前端未做 SHA-256，后端自行计算
  if (password) {
    const hash = sha256(password);
    return bcrypt.compareSync(hash, user.password_hash) ? { ok: true, user } : { ok: false };
  }

  return { ok: false };
}

// —— 鉴权中间件 ——

// requireAuth: 验证 session token，将用户信息挂载到 req.user
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verify(token);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const user = getUserById(session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

// requireAdmin: 检查用户角色是否为 admin（必须在 requireAuth 之后使用）
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
