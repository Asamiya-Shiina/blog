'use strict';

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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, try again later' },
});

const usernameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'invalid username');
const passwordSchema = z.string().min(8).max(256);
const userCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema.optional(),
  password_hash: z.string().min(1).max(256).optional(),
}).refine(d => d.password || d.password_hash, { message: 'password required' });
const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(256).optional(),
  old_password_hash: z.string().min(1).max(256).optional(),
  new_password: passwordSchema.optional(),
  new_password_hash: z.string().min(1).max(256).optional(),
}).refine(d => d.new_password || d.new_password_hash, { message: 'new password required' });

// 与 bcrypt cost=12 同长度的不匹配 hash，登录找不到用户时用于恒定时间比对
const PLACEHOLDER_HASH = '$2b$12$..............................................................................';

// —— 首次引导 ——
router.get('/setup-status', (_req, res) => {
  res.json({ needsSetup: db.userCount() === 0 });
});

router.post('/setup', setupLimiter, (req, res) => {
  if (db.userCount() !== 0) {
    return res.status(409).json({ error: 'setup already done' });
  }
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const pw = parsed.data.password_hash || parsed.data.password;
  const preHashed = !!parsed.data.password_hash;
  const user = createUser({ username: parsed.data.username, password: pw, preHashed });
  setSessionCookie(res, user.id);
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// —— 登录 ——
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

  setSessionCookie(res, user.id);
  res.status(204).end();
});

router.post('/logout', requireAuth, (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

// —— 用户管理（仅管理员） ——
router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ items: listUsers() });
});

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
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username already exists' });
    }
    throw err;
  }
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (id === req.user.id) {
    return res.status(400).json({ error: 'cannot delete yourself' });
  }
  if (!deleteUser(id)) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

router.patch('/users/:id/password', requireAuth, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  // 自己或管理员可改
  if (id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  // 自己改自己时必须验证旧密码；管理员改别人时不需要
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