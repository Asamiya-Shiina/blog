'use strict';

// —— 认证路由 ——
// 首次引导、登录、退出、用户管理、密码修改都住这里
// by ALyCE_Aoi

const path = require('node:path');
const fs = require('fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const captcha = require('../captcha');
const mailer = require('../mailer');
const {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
  getUserByUsername,
  getUserById,
  listUsers,
  createUser,
  deleteUser,
  updatePassword,
  verifyPassword,
  sha256,
  BCRYPT_COST,
} = require('../auth');

const router = express.Router();

// 头像目录与限制（与 server.js 的 /avatar 静态挂载保持一致）
const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const AVATAR_MAX = 100 * 1024; // 头像上限 100KB

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
// 注册：用户名 + 密码/密码哈希 + 邮箱 + 滑块验证
const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema.optional(),
  password_hash: z.string().min(1).max(256).optional(),
  email: z.string().trim().toLowerCase().max(254).refine(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'invalid email' }),
  captcha_token: z.string().min(1).max(64),
  captcha_x: z.number().finite(),
}).refine(d => d.password || d.password_hash, { message: 'password required' });

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
  const user = createUser({ username: parsed.data.username, password: pw, preHashed, role: 'admin' });
  setSessionCookie(req, res, user.id);
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// —— 开放注册 ——

// GET /api/captcha：生成滑块验证数据（public）
// 返回 { token, targetX, width, sliderWidth }，前端据此画缺口并校验拖拽
router.get('/captcha', (_req, res) => {
  captcha.sweep();
  res.json(captcha.create());
});

// POST /api/register：公开注册，新用户默认为普通用户（user）
// 流程：滑块验证 → Zod 校验 → 查 SMTP 是否已配置
//   - 已配置 SMTP：创建 pending 用户，发验证邮件，needsVerify=true
//   - 未配置 SMTP：创建 active 用户，needsVerify=false（跳过邮箱验证）
router.post('/register', writeLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  const { username, password, password_hash, email, captcha_token, captcha_x } = parsed.data;

  // 站点已初始化才开放注册；首个账户仍走 /setup
  if (db.userCount() === 0) return res.status(409).json({ error: 'setup required' });
  if (!captcha.verify(captcha_token, captcha_x)) return res.status(400).json({ error: 'captcha failed' });

  const pw = password_hash || password;
  const preHashed = !!password_hash;
  const needsVerify = !!mailer.getSmtpConfig();

  let user;
  try {
    if (needsVerify) {
      const verifyToken = crypto.randomBytes(24).toString('hex');
      const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      user = createUser({ username, password: pw, preHashed, role: 'user', email, status: 'pending', verifyToken, verifyExpires });
      const result = await mailer.sendVerifyEmail(verifyToken, email);
      if (!result.sent) {
        console.log(`[dev] verify link for ${email}: /api/verify?token=${verifyToken}`);
      }
    } else {
      user = createUser({ username, password: pw, preHashed, role: 'user', email, status: 'active' });
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username or email already exists' });
    }
    throw err;
  }
  res.status(201).json({ id: user.id, username: user.username, role: user.role, needsVerify });
});

// GET /api/verify?token=...：邮箱验证链接，激活 pending 用户
router.get('/verify', (req, res) => {
  const renderPage = ({ title, heading, message, link, linkText, status }) => {
    res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="/site/site.css" />
<style>
  html, body {
    margin: 0; padding: 0; min-height: 100vh;
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: url('/image/IMG_20250703_100031.jpeg') center/cover no-repeat fixed;
    border-radius: 0;
    overflow: hidden;
  }
  body::before {
    content: ''; position: fixed; inset: 0;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(8px) saturate(120%);
    -webkit-backdrop-filter: blur(8px) saturate(120%);
    border-radius: 0;
    pointer-events: none; z-index: 0;
  }
  .wrap {
    position: relative; z-index: 1; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    text-align: center; max-width: 380px; width: 100%; padding: 44px 32px;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.6);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08);
    animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
  .mark {
    width: 56px; height: 56px; margin: 0 auto 20px;
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 28px; color: #fff;
  }
  .mark.ok  { background: #22c55e; }
  .mark.bad { background: #ef4444; }
  h1 {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-weight: 400; font-size: 28px;
    margin: 0 0 12px; line-height: 1.3;
  }
  p {
    color: var(--muted); font-size: 14px;
    margin: 0 0 28px; line-height: 1.6;
  }
  .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn {
    display: inline-block; padding: 10px 18px; border-radius: 10px;
    font-size: 14px; text-decoration: none; transition: background 0.2s ease, transform 0.15s ease;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-primary:active { transform: scale(0.98); }
  .btn-ghost {
    background: transparent; color: var(--muted);
    border: 1px solid rgba(0, 0, 0, 0.15);
  }
  .btn-ghost:hover { color: var(--fg); }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <div class="mark ${status === 400 ? 'bad' : 'ok'}">${status === 400 ? '×' : '✓'}</div>
      <h1>${heading}</h1>
      <p>${message}</p>
      <div class="actions">
        <a class="btn btn-primary" href="${link}">${linkText}</a>
        <a class="btn btn-ghost" href="/">← 返回首页</a>
      </div>
    </div>
  </main>
</body></html>`);
  };
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) return renderPage({
    status: 400, title: '验证失败',
    heading: '链接无效',
    message: '链接里没有验证令牌,请回到邮件里复制完整链接,或者重新发起一次注册。',
    link: '/login/', linkText: '去登录',
  });
  const row = db.prepare('SELECT id FROM users WHERE verify_token = ? AND status = ?').get(token, 'pending');
  if (!row) return renderPage({
    status: 400, title: '验证失败',
    heading: '链接已失效',
    message: '验证链接不存在、已用过或已超过 15 分钟。请重新登录看看,或在个人主页发起新的验证。',
    link: '/login/', linkText: '去登录',
  });
  db.prepare('UPDATE users SET status = ?, verify_token = NULL, verify_expires = NULL WHERE id = ?').run('active', row.id);
  renderPage({
    status: 200, title: '已验证',
    heading: '邮箱已激活',
    message: '账号已激活,现在可以登录了。',
    link: '/login/', linkText: '前往登录',
  });
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

  // 邮箱未验证的用户不允许登录
  if (user.status === 'pending') {
    return res.status(409).json({ error: 'email not verified' });
  }

  // 登录成功，签发 session cookie
  setSessionCookie(req, res, user.id);
  res.status(204).end();
});

// POST /api/logout：退出登录，清除 session cookie
router.post('/logout', requireAuth, (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// GET /api/me：获取当前登录用户信息（含个人资料）
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    email: u.email,
    name: u.name,
    bio: u.bio,
    avatar_url: u.avatar_filename ? `/avatar/${encodeURIComponent(u.avatar_filename)}` : null,
  });
});

// PATCH /api/me：修改自己的名字、签名
router.patch('/me', requireAuth, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().max(100).optional(),
    bio: z.string().trim().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  const { name, bio } = parsed.data;

  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name || null); }
  if (bio !== undefined) { sets.push('bio = ?'); vals.push(bio || null); }
  if (sets.length > 0) {
    vals.push(req.user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const u = getUserById(req.user.id);
  res.json({
    id: u.id, username: u.username, role: u.role, status: u.status, email: u.email,
    name: u.name, bio: u.bio,
    avatar_url: u.avatar_filename ? `/avatar/${encodeURIComponent(u.avatar_filename)}` : null,
  });
});

// POST /api/me/avatar：上传自己的头像（≤100KB，png/jpeg/webp/gif）
router.post('/me/avatar', requireAuth, writeLimiter, async (req, res) => {
  let form;
  try {
    const webBody = Readable.toWeb(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    const webReq = new Request('http://internal/avatar', { method: 'POST', headers, body: webBody, duplex: 'half' });
    form = await webReq.formData();
  } catch {
    return res.status(400).json({ error: 'invalid multipart payload' });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return res.status(400).json({ error: 'file is required' });
  const mime = (file.type || '').toLowerCase();
  const ext = AVATAR_MIME[mime];
  if (!ext) return res.status(400).json({ error: 'unsupported image type' });
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return res.status(400).json({ error: 'empty file' });
  if (buf.length > AVATAR_MAX) return res.status(413).json({ error: 'avatar too large (max 100KB)' });

  const storedName = crypto.randomUUID() + ext;
  try {
    await fs.promises.writeFile(path.join(AVATAR_DIR, storedName), buf);
  } catch (e) {
    console.error('avatar write failed:', e);
    return res.status(500).json({ error: 'failed to write file' });
  }
  const prev = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET avatar_filename = ? WHERE id = ?').run(storedName, req.user.id);
  // 异步删旧头像，失败不影响响应
  if (prev && prev.avatar_filename) {
    fs.promises.unlink(path.join(AVATAR_DIR, prev.avatar_filename)).catch(() => {});
  }
  res.status(201).json({ avatar_url: `/avatar/${storedName}` });
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

// PATCH /api/users/:id/role：任命/降级角色（仅全局管理员）
// role  ∈  admin（全局）/ moderator（普通管理员）/ user（普通用户）
router.patch('/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const parsed = z.object({ role: z.enum(['admin', 'moderator', 'user']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid role' });
  const { role } = parsed.data;
  // 不允许全局管理员降级自己，避免把自己锁在角色管理之外
  if (id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'cannot demote yourself' });
  }
  const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// —— 站点级配置（仅全局管理员） ——

// GET /api/site/smtp：读取开放注册邮件配置（不回显明文密码）
router.get('/site/smtp', requireAuth, requireAdmin, (_req, res) => {
  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  let cfg = {};
  if (row) { try { cfg = JSON.parse(row.value); } catch {} }
  res.json({
    configured: !!(cfg.host && cfg.user && cfg.pass),
    host: cfg.host || null,
    port: cfg.port || 587,
    secure: !!cfg.secure,
    user: cfg.user || null,
    sender: cfg.sender || null,
  });
});

// PUT /api/site/smtp：保存开放注册邮件配置；pass 留空表示沿用旧密码
router.put('/site/smtp', requireAuth, requireAdmin, (req, res) => {
  const parsed = z.object({
    host: z.string().trim().max(255).optional().default(''),
    port: z.coerce.number().int().min(1).max(65535).optional().default(587),
    user: z.string().trim().max(255).optional().default(''),
    pass: z.string().max(255).optional().default(''),
    sender: z.string().trim().max(255).optional().default(''),
    secure: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  const d = parsed.data;

  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  let prev = {};
  if (row) { try { prev = JSON.parse(row.value); } catch {} }
  const cfg = {
    host: d.host,
    port: d.port,
    // 不传 secure 视为沿用旧值；显式传 true/false 才覆盖
    secure: typeof d.secure === 'boolean' ? d.secure : !!prev.secure,
    user: d.user,
    pass: d.pass || prev.pass || '',
    sender: d.sender,
  };
  db.prepare(`INSERT INTO status_config (key, value) VALUES ('smtp', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cfg));
  res.json({ configured: !!(cfg.host && cfg.user && cfg.pass) });
});

module.exports = router;
