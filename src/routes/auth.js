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
  password: passwordSchema,
});
const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(256).optional(),
  new_password: passwordSchema,
});

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
  const user = createUser(parsed.data);
  setSessionCookie(res, user.id);
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// —— 登录 ——
router.post('/login', loginLimiter, (req, res) => {
  const parsed = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const { username, password } = parsed.data;

  // 用户不存在时也走一次 bcrypt，保持响应耗时恒定，避免用户名枚举
  const user = getUserByUsername(username);
  const hashToCheck = user ? user.password_hash : PLACEHOLDER_HASH;
  const passOk = bcrypt.compareSync(password, hashToCheck);

  if (!user || !passOk) {
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
    const user = createUser(parsed.data);
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
    if (!user || !bcrypt.compareSync(parsed.data.old_password, user.password_hash)) {
      return res.status(403).json({ error: 'incorrect password' });
    }
  }
  if (!updatePassword(id, parsed.data.new_password)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.status(204).end();
});

module.exports = router;