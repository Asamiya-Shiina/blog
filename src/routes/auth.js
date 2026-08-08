'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH,
} = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

router.post('/login', loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const { username, password } = parsed.data;

  // 用恒等比较防时序探测；用户名比对故意走 bcrypt 同步路径保持恒定耗时
  const userMatch = username === ADMIN_USERNAME;
  // 先 hash 一份假密码占位，让比对路径长度恒定
  const hashToCheck = userMatch
    ? ADMIN_PASSWORD_HASH
    : '$2b$12$..............................................................................';
  const passOk = bcrypt.compareSync(password, hashToCheck);

  if (!userMatch || !passOk) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  setSessionCookie(res, 1); // 单管理员，固定 id = 1
  res.status(204).end();
});

router.post('/logout', requireAuth, (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

module.exports = router;
