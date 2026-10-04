'use strict';

// 认证路由
// 包含首次引导、登录、退出、用户管理、密码修改等接口
// 首次引导：
//   GET  /api/setup-status  公开：返回是否需要初始化（无管理员账号时为 true）
//   POST /api/setup         公开 + 限流：创建首个管理员账号（仅在无用户时可调用）
// 开放注册：
//   GET  /api/captcha       公开 + 限流：生成滑块验证数据
//   POST /api/register      公开 + 限流：注册新用户（需滑块验证）
// 登录 / 退出：
//   POST /api/login         公开 + 限流：登录，返回 session cookie
//   POST /api/logout        登录：清除 session cookie
// by ALyCE_Aoi

const path = require('node:path');
const fs = require('fs');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const captcha = require('../captcha');
const mailer = require('../mailer');
const audit = require('../audit');
const emailPolicy = require('../email-policy');
const cryptoBox = require('../crypto-box');
const { parseMultipart } = require('../upload');
const {
  setSessionCookie,
  clearSessionCookie,
  revokeUserTokens,
  requireAuth,
  requireAdmin,
  getUserByUsername,
  getUserById,
  listUsers,
  createUser,
  createPendingUser,
  deleteUser,
  updatePassword,
  verifyPassword,
  sha256,
  BCRYPT_COST,
} = require('../auth');

const router = express.Router();

// 头像目录与限制（与 server.js 中 /avatar 的静态挂载保持一致）
const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
// 头像仅接受 JPG（站点规范），其他格式直接拒绝
const AVATAR_MIME = { 'image/jpeg': '.jpg' };
const AVATAR_MAX = 200 * 1024; // 头像大小上限 200KB

// 校验图片文件头部的 magic number 是否与声称的 MIME 类型一致
// 客户端可随意修改 Content-Type，但文件 buffer 的起始字节由文件内容决定，无法伪造
// 因此即使攻击者声明 image/png 而提交 HTML / SVG / 可执行文件，仍会被拒绝
// 识别规则：
//   PNG:  89 50 4E 47 0D 0A 1A 0A
//   JPEG: FF D8 FF
//   GIF:  47 49 46 38 (37|39) 61
//   WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
function checkImageMagic(mime, buf) {
  if (mime === 'image/png') {
    return buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
  }
  if (mime === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  }
  if (mime === 'image/gif') {
    return buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  }
  if (mime === 'image/webp') {
    return buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&  // RIFF
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;   // WEBP
  }
  return false;
}

// 速率限制器

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

// 按邮箱限流：每个邮箱 1 小时内最多 5 次注册尝试，防抢注和骚扰
// key 使用 body.email（小写）；缺失时回退到 IP，避免无 body 请求共用一个桶
// 与 writeLimiter（按 IP 限流）正交：前者限制恶意 IP，后者限制被抢注邮箱
const emailRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return (typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null) || ipKeyGenerator(req.ip);
  },
  message: { error: 'this email has too many registration attempts, try again later' },
});

// captcha 限流：每 IP 每分钟最多 30 次，防止 captcha 内存被打满
// MAX_ITEMS=2000 为内存硬上限，但攻击者可不断 GET 拿走未消费 token 占据名额
// 此处限流即为该攻击面增加一道闸门
const captchaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many captcha requests, try again later' },
});

// 邮箱验证限流：每 IP 15 分钟最多 20 次
// 令牌为 192 位随机串，本身不可爆破；此限流用于阻止
// 用 /api/verify 做令牌有效性探测或资源消耗
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many verification attempts, try again later' },
});

// 改密码限流：按【用户】计数，15 分钟最多 10 次
// 按用户而非按 IP：旧密码校验是 bcrypt 比对，若只按 IP 限流，
// 攻击者持有一个有效 session 时可换 IP 无限次猜测旧密码（在线爆破）。
// 计数键优先用已认证用户 id，未认证时（理论上到不了这里）回退 IP。
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: { error: '密码修改过于频繁，请稍后再试' },
});

// 输入校验 Schema（Zod）

// 用户名：1-64 字符，仅允许字母、数字、下划线与连字符
const usernameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'invalid username');

// 常见弱密码黑名单（取最常被撞库的前 50 条）
// 服务端的「最终防线」作用有限，但拦截「123456」「qwerty」这类高频弱密码仍有价值
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '1234567', '12345', '11111111',
  '00000000', 'password', 'password1', 'password123', 'qwerty', 'qwerty123',
  'abc12345', 'abc123', 'iloveyou', 'admin123', 'admin1234', 'admin12345',
  'letmein', 'welcome', 'monkey123', 'dragon123', 'master123', 'login123',
  'princess1', 'sunshine1', 'trustno1', 'shadow123', 'michael1', 'jennifer1',
  'jordan23', 'michelle1', 'daniel123', 'andrew123', 'charlie1', 'jessica1',
  'ashley123', 'fuckyou1', 'football1', 'baseball1', 'soccer123', 'hockey123',
  'batman123', 'superman1', 'starwars1', 'killer123', 'jordan123', 'thomas123',
  'robert123',
]);

// 密码强度校验：至少 10 位，必须含字母和数字，且不在常见弱密码清单中
// 重要：本函数只在拿到【明文】密码时才有意义。
// 绝不可传入前端预哈希的 SHA-256 值——它是恒定 64 位十六进制串，
// 长度 ≥10、含字母、含数字三条必然全部通过，弱密码清单也永远匹配不上，
// 等于密码策略被完全绕过。所有设置密码的接口因此都要求明文提交。
function validatePassword(pw) {
  if (typeof pw !== 'string') return 'invalid password';
  if (pw.length < 10) return '密码至少需要 10 个字符';
  if (pw.length > 256) return '密码过长';
  if (!/[a-zA-Z]/.test(pw)) return '密码必须包含字母';
  if (!/[0-9]/.test(pw)) return '密码必须包含数字';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return '密码过于常见，请换一个';
  return null;
}
// 密码：服务端再用 zod 控一遍长度，强度由 validatePassword 补
const passwordSchema = z.string().min(10).max(256);
// 新密码（设置/重置密码时使用）：必须是明文，服务端才能校验强度
const newPasswordSchema = passwordSchema;
// 创建用户：用户名必填，密码必填且为明文（由服务端做强度校验并哈希）
// 不再接受 password_hash：哈希恒为 64 位十六进制，对它做强度校验必然全过，
// 等于密码策略形同虚设（见 validatePassword 注释）
const userCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
// 修改密码：旧密码 + 新密码
// 允许旧密码以哈希形式提交（仅用于比对，不做强度判定）；
// 新密码必须是明文，服务端才能校验强度
const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(256).optional(),
  old_password_hash: z.string().min(1).max(256).optional(),
  new_password: newPasswordSchema,
});
// 注册：用户名 + 邮箱 + 滑块验证
// 注意：注册阶段不接收密码。
// 账号密码在邮箱验证通过后由本人设置，这样即使他人用你的邮箱注册，
// 也无法预先埋入一个自己知道的密码（防账号预劫持）。
const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().toLowerCase().max(254).refine(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'invalid email' }),
  captcha_token: z.string().min(1).max(64),
  captcha_x: z.number().finite(),
  // 拖动轨迹：可选字段，缺失/格式错误都会在 captcha.verify 里被判负，不靠这里做强约束
  captcha_track: z.array(z.object({ x: z.number().finite(), t: z.number().finite() })).optional(),
});

// 占位哈希：用户不存在时使用该哈希进行 bcrypt 比较
// 用途：使「用户不存在」与「密码错误」的响应时间一致，避免用户名枚举
const PLACEHOLDER_HASH = '$2b$12$..............................................................................';

// 首次引导

// GET /api/setup-status：返回是否需要初始化（无管理员账号时为 true）
// 可在未登录状态下访问，供前端决定显示登录页还是设置页
router.get('/setup-status', (_req, res) => {
  res.json({ needsSetup: db.userCount() === 0 });
});

// POST /api/setup：创建首个管理员账号
// 只有在没有任何用户时才能调用，防止被恶意创建管理员
// 必须原子：计数判断与插入在单条 SQL 内完成，否则并发请求可各自创建一个 admin
router.post('/setup', setupLimiter, async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  // 明文密码：由服务端做强度校验并 SHA-256 → bcrypt
  const pw = parsed.data.password;
  const pwErr = validatePassword(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const hash = await bcrypt.hash(sha256(pw), BCRYPT_COST);
  // 原子插入：仅在 users 表为空时生效
  const created = db.createFirstAdminSync({ username: parsed.data.username, passwordHash: hash });
  if (created === 0) {
    return res.status(409).json({ error: 'setup already done' });
  }
  const user = getUserByUsername(parsed.data.username);
  setSessionCookie(req, res, user.id);
  audit.log({ actorId: user.id, targetId: user.id, action: 'user.setup', detail: { username: user.username } });
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// 开放注册

// GET /api/captcha：生成滑块验证数据（公开）
// 返回 { token, targetX, width, sliderWidth }，前端据此绘制缺口并校验拖拽
// token 内部绑定当前请求 IP，verify 时必须在同一 IP 提交，防止跨设备盗用
router.get('/captcha', captchaLimiter, (req, res) => {
  captcha.sweep();
  res.json(captcha.create(req));
});

// POST /api/register：开放注册，新用户默认为普通用户（user）
// 处理流程：滑块验证 → Zod 校验 → SMTP 配置检查
//   - 已配置 SMTP：创建 pending 用户并发送验证邮件，needsVerify=true
//   - 未配置 SMTP：创建 active 用户，needsVerify=false（跳过邮箱验证）
router.post('/register', writeLimiter, emailRegisterLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  const { username, email, captcha_token, captcha_x, captcha_track } = parsed.data;

  // 仅在站点完成初始化后才开放注册；首个账号仍走 /setup
  if (db.userCount() === 0) return res.status(409).json({ error: 'setup required' });
  // 邮箱域名白名单：拒绝一次性、匿名、企业及学校邮箱，仅放行主流个人邮箱
  if (!emailPolicy.isDomainAllowed(email)) {
    return res.status(400).json({ error: '请使用主流个人邮箱（Gmail / QQ / Outlook / 163 等）' });
  }
  if (!captcha.verify(captcha_token, captcha_x, captcha_track, req)) return res.status(400).json({ error: 'captcha failed' });

  // 注册不再接收密码；账号密码在邮箱验证通过后由本人设置
  // （防账号预劫持：他人用你的邮箱注册也无法预置一个自己知道的密码）

  // 先分别查询 username 与 email 是否被占用，统一返回 409 消息
  // 若直接 INSERT 并捕获 UNIQUE 异常，由于异常时机因命中列不同而存在差异，
  // 攻击者可借助响应时间差区分「username 已存在」与「email 已存在」
  // 顺便 sweep 一次：清掉过期 pending 用户，避免「填错邮箱未收信 → 用户名被锁定」的情况
  const expiredNow = db.sweepExpiredPendingUsers();
  for (const u of expiredNow) {
    // targetId=null：写入审计时记录已被删除，外键约束会失败
    // 在 detail 中携带 username 与 email 足以满足追溯需要
    audit.log({ actorId: null, targetId: null, action: 'user.expired', detail: { username: u.username, email: u.email } });
  }
  const userByName = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  const userByEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (userByName || userByEmail) {
    return res.status(409).json({ error: 'username or email already exists' });
  }

  // SMTP 状态决定注册是否可用。
  // 由于密码只在验证后设置，注册必须能发出验证邮件，否则账号永远无法激活；
  // 因此「未配置」与「配置损坏」都必须明确拒绝，绝不静默降级为直接激活。
  const smtp = mailer.getSmtpStatus();
  if (smtp.state === 'not_configured') {
    return res.status(503).json({ error: '站点尚未配置邮件服务，暂时无法注册，请联系管理员' });
  }
  if (smtp.state === 'broken') {
    console.error('[register] SMTP 配置损坏，拒绝注册：', smtp.reason);
    return res.status(503).json({ error: '站点的邮件服务配置异常，暂时无法注册，请联系管理员' });
  }

  const verifyToken = crypto.randomBytes(24).toString('hex');
  const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let user;
  try {
    // 不写入任何用户选择的密码：password_hash 由 CSPRNG 随机串填充，该账号在设置密码前无法登录
    user = await createPendingUser({ username, email, verifyToken, verifyExpires });
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username or email already exists' });
    }
    throw err;
  }

  const result = await mailer.sendVerifyEmail(verifyToken, email, username, req);
  if (!result.sent) {
    // 邮件发不出去则该 pending 账号不可能被激活，直接回滚，避免占用用户名/邮箱 15 分钟
    try { deleteUser(user.id); } catch { /* 回滚失败由 pending 过期清理兜底 */ }
    const msg = result.reason === 'untrusted_host'
      ? '站点域名配置异常，暂时无法注册，请联系管理员'
      : '验证邮件发送失败，请稍后重试或联系管理员';
    return res.status(503).json({ error: msg });
  }
  if (process.env.NODE_ENV !== 'production') {
    // 仅在非生产环境输出激活链接，便于本地未配置可用 SMTP 时联调
    console.log(`[dev] verify link for ${email}: /verify/?token=${verifyToken}`);
  }

  audit.log({ actorId: null, targetId: user.id, action: 'user.register', detail: { username, needsVerify: true } });
  res.status(201).json({ id: user.id, username: user.username, role: user.role, needsVerify: true });
});

// 邮箱验证（两步流程）
//   GET  /api/verify?token=...  校验令牌，返回该账号可设置密码的状态（不激活、不改状态）
//   POST /api/verify            用令牌 + 新密码完成激活（原子操作）
//
// 为什么不再"点链接即激活"：旧流程下攻击者可用他人邮箱注册，
// 受害者点一下链接账号就被激活，而密码是攻击者预先设定的（账号预劫持）。
// 现在注册阶段不存任何密码，激活必须由持令牌者本人设置密码，攻击者无机可乘。
//
// 时序与枚举防护：令牌是 192 位 CSPRNG 随机串，比较走预处理语句；
// 无论令牌是否存在都返回同样的结构，不区分"不存在"与"已过期"以外的差异。

// 取出待验证账号；null 表示令牌无效/已用/过期
function findPendingByToken(token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT id, username, email, verify_expires FROM users WHERE verify_token = ? AND status = ?'
  ).get(token, 'pending');
  if (!row) return null;
  // verify_expires 为 ISO 8601 字符串，字典序等价于时间序
  if (row.verify_expires && row.verify_expires < new Date().toISOString()) return null;
  return row;
}

// 令牌格式：48 位十六进制（randomBytes(24)）
const VERIFY_TOKEN_RE = /^[0-9a-f]{48}$/;

// GET /api/verify：查询令牌是否可用于设置密码
router.get('/verify', verifyLimiter, (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!VERIFY_TOKEN_RE.test(token)) {
    return res.status(400).json({ valid: false, error: '链接无效或已失效' });
  }
  const row = findPendingByToken(token);
  if (!row) {
    return res.status(400).json({ valid: false, error: '链接不存在、已被使用或已超过 15 分钟有效期' });
  }
  res.json({ valid: true, username: row.username });
});

// POST /api/verify：设置密码并激活账号
// body: { token, password }（明文密码，服务端做强度校验后哈希）
router.post('/verify', verifyLimiter, async (req, res) => {
  const parsed = z.object({
    token: z.string().min(1).max(128),
    password: newPasswordSchema,
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });

  const token = parsed.data.token.trim();
  if (!VERIFY_TOKEN_RE.test(token)) {
    return res.status(400).json({ error: '链接无效或已失效' });
  }
  const row = findPendingByToken(token);
  if (!row) {
    return res.status(400).json({ error: '链接不存在、已被使用或已超过 15 分钟有效期' });
  }

  const pwErr = validatePassword(parsed.data.password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = await bcrypt.hash(sha256(parsed.data.password), BCRYPT_COST);
  // 原子激活：以 verify_token + status='pending' 为条件，
  // 这样并发提交同一令牌时只有一次能成功，天然防重放
  const info = db.prepare(`
    UPDATE users
    SET password_hash = ?, hash_version = 2, status = 'active',
        verify_token = NULL, verify_expires = NULL
    WHERE id = ? AND verify_token = ? AND status = 'pending'
  `).run(hash, row.id, token);
  if (info.changes === 0) {
    return res.status(400).json({ error: '链接已被使用，请重新发起注册' });
  }

  audit.log({ actorId: row.id, targetId: row.id, action: 'user.verify', detail: { username: row.username } });
  // 激活即登录：直接签发会话，免去用户再输一次密码
  setSessionCookie(req, res, row.id);
  res.status(200).json({ ok: true, username: row.username });
});

// 登录

// POST /api/login：用户名密码登录
// 接受 password_hash（推荐）或 password（回退）
router.post('/login', loginLimiter, async (req, res) => {
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
    const dummy = password_hash || password;
    if (typeof dummy === 'string' && dummy.length > 0) {
      await bcrypt.compare(dummy, PLACEHOLDER_HASH);
    }
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const result = await verifyPassword({ password, password_hash }, user);
  if (!result.ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  // 邮箱未验证的用户不允许登录
  if (user.status === 'pending') {
    return res.status(409).json({ error: 'email not verified' });
  }

  // 登录成功：先清除旧 cookie 再签发新 token，防止 Session Fixation
  // （攻击者预先在公共电脑植入 cookie，等待用户登录后继续沿用旧 cookie）
  clearSessionCookie(req, res);
  setSessionCookie(req, res, user.id);
  audit.log({ actorId: user.id, targetId: user.id, action: 'user.login', detail: { username } });
  res.status(204).end();
});

// POST /api/logout：退出登录
// 必须服务端吊销：仅清 cookie 是不够的——HMAC token 本身仍有效，
// 一旦泄露（共享电脑/备份/恶意扩展）受害者无法通过登出自救。
// revokeUserTokens 把该用户的 session_epoch 加一，使所有已签发 token 立即失效。
router.post('/logout', requireAuth, (req, res) => {
  clearSessionCookie(req, res);
  revokeUserTokens(req.user.id);
  audit.log({ actorId: req.user.id, targetId: req.user.id, action: 'user.logout' });
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

// POST /api/me/avatar：上传自己的头像（仅 JPG，≤200KB）
// 落盘流程：写入临时文件 → rename 原子切换 → 再更新 DB → 异步删除旧文件
// 顺序很重要：先 rename 再提交 DB，保证 DB 永远不会指向磁盘上不存在的文件
// （旧实现先更新 DB 再 rename，中途崩溃会留下悬空引用）
// 解析使用 busboy 流式处理，超出上限立即中断请求，不会把整个 body 缓冲进内存
router.post('/me/avatar', requireAuth, writeLimiter, async (req, res) => {
  const parsed = await parseMultipart(req, { maxFileBytes: AVATAR_MAX, maxFiles: 1, maxFields: 2 });
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const { mime, buffer: buf } = parsed.file;
  const ext = AVATAR_MIME[mime];
  if (!ext) return res.status(400).json({ error: '头像仅支持 JPG 格式' });
  // magic byte 校验：客户端声明的 MIME 必须与文件实际内容相符
  // 防止传 .png 扩展但内容是 HTML/SVG/可执行文件
  if (!checkImageMagic(mime, buf)) {
    return res.status(400).json({ error: 'file content does not match declared image type' });
  }

  const storedName = crypto.randomUUID() + ext;
  const tmpName = storedName + '.tmp';
  const tmpPath = path.join(AVATAR_DIR, tmpName);
  const finalPath = path.join(AVATAR_DIR, storedName);
  try {
    // 1. 写入临时文件（半成品，对外不可见）
    await fs.promises.writeFile(tmpPath, buf);
    // 2. 原子切换：同一文件系统内 rename 为原子操作
    await fs.promises.rename(tmpPath, finalPath);
    // 3. 文件已就位，再切换 DB 指针
    const prev = db.transaction(() => {
      const row = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(req.user.id);
      db.prepare('UPDATE users SET avatar_filename = ? WHERE id = ?').run(storedName, req.user.id);
      return row;
    })();
    // 4. 异步删除旧文件，失败不影响响应
    if (prev && prev.avatar_filename && prev.avatar_filename !== storedName) {
      fs.promises.unlink(path.join(AVATAR_DIR, prev.avatar_filename)).catch(() => {});
    }
    return res.status(201).json({ avatar_url: `/avatar/${storedName}` });
  } catch (e) {
    console.error('avatar upload failed:', e);
    // 兜底：清理可能残留的临时文件与新文件（不影响已存在的旧文件）
    fs.promises.unlink(tmpPath).catch(() => {});
    fs.promises.unlink(finalPath).catch(() => {});
    return res.status(500).json({ error: 'failed to upload avatar' });
  }
});

// 用户管理接口（仅管理员）

// GET /api/users：列出所有用户
router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ items: listUsers() });
});

// POST /api/users：创建新用户（管理员操作）
// 密码必须是明文，服务端才能执行强度校验（哈希形态无法判断强度）
router.post('/users', requireAuth, requireAdmin, writeLimiter, async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const pw = parsed.data.password;
  const pwErr = validatePassword(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const user = await createUser({ username: parsed.data.username, password: pw, preHashed: false });
    audit.log({ actorId: req.user.id, targetId: user.id, action: 'user.create', detail: { username: user.username, role: user.role } });
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
  audit.log({ actorId: req.user.id, targetId: id, action: 'user.delete' });
  res.status(204).end();
});

// PATCH /api/users/:id/password：修改密码
// 自己改自己：需要验证旧密码（按用户维度限流，防在线爆破）
// 管理员改别人：不需要旧密码
// 新密码必须是明文，服务端才能做强度校验
router.patch('/users/:id/password', requireAuth, passwordChangeLimiter, async (req, res) => {
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
    const result = await verifyPassword({
      password: parsed.data.old_password,
      password_hash: parsed.data.old_password_hash,
    }, user);
    if (!result.ok) return res.status(403).json({ error: 'incorrect password' });
  }
  const newPw = parsed.data.new_password;
  const pwErr = validatePassword(newPw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const hash = await bcrypt.hash(sha256(newPw), BCRYPT_COST);
  const info = db.prepare(
    'UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?'
  ).run(hash, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });

  // 吊销该用户所有已签发的 session（改密后旧 cookie 一律失效）
  // 随后若改的是自己，立即重新签发当前会话，因此操作者本设备不会被踢下线。
  // 顺序很重要：必须先吊销再签发，否则新 token 也会被一起吊销。
  revokeUserTokens(id);
  if (id === req.user.id) {
    setSessionCookie(req, res, req.user.id);
  }
  audit.log({ actorId: req.user.id, targetId: id, action: 'password.change' });
  res.status(204).end();
});

// PATCH /api/users/:id/role：任命或降级角色（仅全局管理员）
// role 可选值：admin（全局）/ moderator（普通管理员）/ user（普通用户）
router.patch('/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const parsed = z.object({ role: z.enum(['admin', 'moderator', 'user']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid role' });
  const { role } = parsed.data;
  // 不允许全局管理员降级自己，避免将自己锁在角色管理之外
  if (id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'cannot demote yourself' });
  }
  // 记录修改前的角色，用于审计
  const before = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  audit.log({
    actorId: req.user.id, targetId: id, action: 'role.change',
    detail: { from: before ? before.role : null, to: role },
  });
  res.status(204).end();
});

// 站点级配置接口（仅全局管理员）

// GET /api/site/smtp：读取邮件配置（不回显明文密码）
// 额外返回 state 字段，把"配置坏了"这种以前只能靠日志发现的状态显式暴露给后台：
//   ok              配置完整可用
//   not_configured  尚未填写完整
//   broken          密码解不开（通常是 SESSION_SECRET 被轮换）——必须让管理员看到并修复
// registration_ready：注册功能当前是否可用（SMTP 必须 ok，因为密码在验证后设置）
router.get('/site/smtp', requireAuth, requireAdmin, (_req, res) => {
  const status = mailer.getSmtpStatus();
  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  let cfg = {};
  if (row) { try { cfg = JSON.parse(row.value); } catch {} }
  res.json({
    configured: !!(cfg.host && cfg.user && cfg.pass),
    state: status.state,
    needs_repair: status.state === 'broken',
    repair_hint: status.state === 'broken'
      ? 'SMTP 密码无法解密（加密密钥已变更）。请重新填写 SMTP 密码以恢复邮件功能。'
      : null,
    registration_ready: status.state === 'ok',
    host: cfg.host || null,
    port: cfg.port || 587,
    secure: !!cfg.secure,
    user: cfg.user || null,
    sender: cfg.sender || null,
  });
});

// SMTP host 校验
// 只允许合法主机名或 IP 字面量，拒绝空白、CR/LF、@、scheme 等
// 这些字符若进入 SMTP 会话会造成命令/头部注入
// 注意：这里【不】阻断私网地址——自托管场景下 SMTP 常跑在 127.0.0.1 或局域网，
// 一刀切会直接搞坏正常部署。需要收紧时由管理员自行在网络层限制。
const SMTP_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253})$/;
function validateSmtpHost(host) {
  if (!host) return null;                       // 空 = 未配置，允许
  if (/[\s\r\n@/\\]/.test(host)) return 'host 不能包含空白、换行、@ 或路径字符';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return 'host 只需填写主机名，不要带 http:// 前缀';
  // IPv6 字面量形如 [::1]
  if (host.startsWith('[') && host.endsWith(']')) {
    return /^\[[0-9A-Fa-f:.]+\]$/.test(host) ? null : 'IPv6 地址格式不正确';
  }
  if (!SMTP_HOST_RE.test(host)) return 'host 格式不正确';
  // 末尾不能是点或连字符开头/结尾的标签
  if (/[.-]$/.test(host)) return 'host 格式不正确';
  return null;
}

// 邮箱地址校验（sender/user 复用注册时的规则）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const hostErr = validateSmtpHost(d.host);
  if (hostErr) return res.status(400).json({ error: hostErr });
  // user 必须是完整邮箱（QQ/Outlook 等要求发件地址与认证账户一致）
  if (d.user && !EMAIL_RE.test(d.user)) return res.status(400).json({ error: 'user 必须是完整邮箱地址' });
  if (d.sender && !EMAIL_RE.test(d.sender)) return res.status(400).json({ error: 'sender 必须是完整邮箱地址' });

  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  let prev = {};
  if (row) { try { prev = JSON.parse(row.value); } catch {} }
  const cfg = {
    host: d.host,
    port: d.port,
    // 未传入 secure 时视为沿用旧值；显式传入 true / false 才会覆盖
    secure: typeof d.secure === 'boolean' ? d.secure : !!prev.secure,
    user: d.user,
    // 未传入新密码 → 沿用旧密文
    // 传入新密码 → 加密后落库
    pass: d.pass ? cryptoBox.encrypt(d.pass) : (prev.pass || ''),
    sender: d.sender,
  };
  db.prepare(`INSERT INTO status_config (key, value) VALUES ('smtp', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cfg));
  const status = mailer.getSmtpStatus();
  audit.log({ actorId: req.user.id, targetId: null, action: 'smtp.update', detail: { host: cfg.host, user: cfg.user, configured: !!(cfg.host && cfg.user && cfg.pass), state: status.state } });
  res.json({ configured: !!(cfg.host && cfg.user && cfg.pass), state: status.state, registration_ready: status.state === 'ok' });
});

module.exports = router;
