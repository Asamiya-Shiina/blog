'use strict';

// —— 认证路由 ——
// 处理：首次引导、登录、退出、用户管理、密码修改

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
  getUserByUsername,
  listUsers,
  createUser,
  deleteUser,
  updatePassword,
  verifyPassword,
  sha256,
  BCRYPT_COST,
} = require('../auth');

const router = express.Router();

// —— 速率限制器 ——

// 登录限流：15 分钟内最多 5 次，防暴力破解
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

// 首次设置限流：1 小时内最多 10 次，防竞态创建管理员
const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

// 写操作限流：15 分钟内最多 30 次，防滥用
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, try again later' },
});

// —— 输入校验 Schema（Zod） ——

// 用户名：1-64 字符，只允许字母数字下划线连字符
const usernameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'invalid username');
// 密码：8-256 字符
const passwordSchema = z.string().min(8).max(256);
// 创建用户：用户名必填，密码或密码哈希至少填一个
const userCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema.optional(),
  password_hash: z.string().min(1).max(256).optional(),
}).refine(d => d.password || d.password_hash, { message: 'password required' });
// 修改密码：新密码或新密码哈希至少填一个
const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(256).optional(),
  old_password_hash: z.string().min(1).max(256).optional(),
  new_password: passwordSchema.optional(),
  new_password_hash: z.string().min(1).max(256).optional(),
}).refine(d => d.new_password || d.new_password_hash, { message: 'new password required' });

// 占位哈希：用户不存在时用这个做 bcrypt 比较
// 目的：让"用户不存在"和"密码错误"的响应时间一致，防止用户名枚举
const PLACEHOLDER_HASH = '$2b$12$..............................................................................';

// —— 首次引导 ——

// GET /api/setup-status：返回是否需要初始化（无管理员账号时为 true）
// 未认证即可访问，供前端决定显示登录页还是设置页
router.get('/setup-status', (_req, res) => {
  res.json({ needsSetup: db.userCount() === 0 });
});

// POST /api/setup：创建首个管理员账号
// 只有在没有任何用户时才能调用，防止被恶意创建管理员
router.post('/setup', setupLimiter, (req, res) => {
  if (db.userCount() !== 0) {
    return res.status(409).json({ error: 'setup already done' });
  }
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  // 优先使用 password_hash（前端已 SHA-256），否则用 password（明文）
  const pw = parsed.data.password_hash || parsed.data.password;
  const preHashed = !!parsed.data.password_hash;
  const user = createUser({ username: parsed.data.username, password: pw, preHashed });
  setSessionCookie(res, user.id);
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// —— 登录 ——

// POST /api/login：用户名密码登录
// 接受 password_hash（推荐）或 password（回退）
router.post('/login', loginLimiter, (req, res) => {
  const parsed = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256).optional(),
    password_hash: z.string().min(1).max(256).optional(),
  }).refine(d => d.password || d.password_hash, { message: 'password required' })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const { username, password, password_hash } = parsed.data;

  const user = getUserByUsername(username);

  // 用户不存在时也走一次 bcrypt，保持响应耗时恒定，避免用户名枚举
  if (!user) {
    bcrypt.compareSync(password_hash || password, PLACEHOLDER_HASH);
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const result = verifyPassword({ password, password_hash }, user);
  if (!result.ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  // 登录成功，签发 session cookie
  setSessionCookie(res, user.id);
  res.status(204).end();
});

// POST /api/logout：退出登录，清除 session cookie
router.post('/logout', requireAuth, (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// GET /api/me：获取当前登录用户信息（前端用于判断登录状态）
router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

// —— 用户管理（仅管理员） ——

// GET /api/users：列出所有用户
router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ items: listUsers() });
});

// POST /api/users：创建新用户（管理员操作）
router.post('/users', requireAuth, requireAdmin, writeLimiter, (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  try {
    const pw = parsed.data.password_hash || parsed.data.password;
    const preHashed = !!parsed.data.password_hash;
    const user = createUser({ username: parsed.data.username, password: pw, preHashed });
    res.status(201).json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    // SQLite 唯一约束冲突 = 用户名已存在
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username already exists' });
    }
    throw err;
  }
});

// DELETE /api/users/:id：删除用户（管理员操作，不能删自己）
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (id === req.user.id) {
    return res.status(400).json({ error: 'cannot delete yourself' });
  }
  if (!deleteUser(id)) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// PATCH /api/users/:id/password：修改密码
// 自己改自己：需要验证旧密码
// 管理员改别人：不需要旧密码
router.patch('/users/:id/password', requireAuth, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  // 权限检查：只能改自己的密码，或者管理员可以改任何人的
  if (id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  // 自己改自己时必须验证旧密码
  if (id === req.user.id) {
    const user = getUserByUsername(req.user.username);
    if (!user) return res.status(403).json({ error: 'incorrect password' });
    const result = verifyPassword({
      password: parsed.data.old_password,
      password_hash: parsed.data.old_password_hash,
    }, user);
    if (!result.ok) return res.status(403).json({ error: 'incorrect password' });
  }
  // 优先使用 new_password_hash（前端已 sha256），否则用 new_password（明文）
  const newPw = parsed.data.new_password_hash || parsed.data.new_password;
  const hash = bcrypt.hashSync(sha256(newPw), BCRYPT_COST);
  const info = db.prepare('UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?').run(hash, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
