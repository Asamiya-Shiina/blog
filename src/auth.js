'use strict';

// 认证与授权模块
// 提供密码哈希、session token 签发与校验、用户 CRUD、鉴权中间件
// 整个站点的核心安全逻辑集中在本文件

const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

// Session Secret 校验
// 该密钥用于签发与验证 session token（HMAC-SHA256）
// 必须在 .env 中设置，且不能是占位符、长度不足或熵过低
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}
// 常见占位符 / 低熵弱密钥集合 —— 历史漏洞（已修复）：
// 早期只检测字面 "change-me-to-a-random-string"，其他常见弱密钥（如 "secret"、
// "password123"、32 个空格、全 'a' 等）能蒙混过关，攻击者只需读 .env 即拿到 MAC 密钥。
const WEAK_SECRETS = new Set([
  'change-me-to-a-random-string',
  'changeme',
  'secret',
  'password',
  'admin',
  'default',
  'development',
  'production',
  'test',
  '12345678901234567890123456789012',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '                                ', // 32 spaces
]);
if (WEAK_SECRETS.has(SECRET)) {
  console.error('SESSION_SECRET is a known weak value — set a real secret in .env');
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error('SESSION_SECRET is too short (minimum 32 characters)');
  process.exit(1);
}
// 熵校验：拒绝全相同字符或单一字符重复的模式
// 用游程编码检测最长相同字符连续段；超过总长 50% 视为低熵
let maxRun = 1, curRun = 1;
for (let i = 1; i < SECRET.length; i++) {
  if (SECRET[i] === SECRET[i - 1]) {
    curRun += 1;
    if (curRun > maxRun) maxRun = curRun;
  } else {
    curRun = 1;
  }
}
if (maxRun >= SECRET.length * 0.5) {
  console.error('SESSION_SECRET has too little entropy (single character repeats)');
  process.exit(1);
}

// Cookie 配置
const COOKIE_NAME = 'sid';                        // session cookie 名称
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;       // 1 年有效期
const BCRYPT_COST = 12;                            // bcrypt 计算成本（2^12 = 4096 轮迭代）

// session token 的 MAC 固定为 64 位小写十六进制
const HEX64_RE = /^[0-9a-f]{64}$/;

// SHA-256 哈希
// 密码在进入 bcrypt 前先哈希，可绕过 bcrypt 72 字节输入限制，
// 客户端与服务端使用同一算法可确保结果一致
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Session Token 签发
// 格式：userId.iat.expiresAt.epoch.mac
//
// 各字段作用：
//   userId / expiresAt  身份与有效期
//   iat                 签发秒级时间戳，仅用于展示与排序（不参与吊销判断）
//   epoch               会话世代号，与 users.session_epoch 比对，用于吊销
//   mac                 HMAC-SHA256 覆盖前四个字段，防篡改
//
// 为什么用世代号而不是时间戳判断吊销：
// 时间戳是秒级精度，无法区分"同一秒内的登出与前一次登录"，
// 会导致登出后同一秒内重新登录被误判为已吊销。世代号单调递增，无此歧义。
function sign(userId, iat, expiresAt, epoch) {
  const payload = `${userId}.${iat}.${expiresAt}.${epoch}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

// Session Token 校验
// 解析 token，验证 HMAC 签名（使用恒定时间比较）并检查是否过期
// Session Token 校验
// 解析 token，验证 HMAC 签名（使用恒定时间比较）并检查是否过期
//
// user 参数可选：传入时额外校验会话世代号（epoch）。
// 世代号校验是吊销机制的核心，必须由调用方把用户记录传进来。
// 若调用方已经查过用户却忘了传，会静默跳过吊销检查，所以要格外注意。
function verify(token, user) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [userId, iat, expiresAt, epoch, mac] = parts;
  const payload = `${userId}.${iat}.${expiresAt}.${epoch}`;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  // 长度不一致直接拒绝，避免后续 Buffer 比较出错
  if (mac.length !== expected.length) return null;
  // 必须是恰好 64 位小写十六进制。
  // 仅比较字符长度是不够的：Buffer.from('zz…','hex') 会静默丢弃非十六进制字符并返回
  // 0 字节缓冲区，此时 timingSafeEqual 会抛出 RangeError。
  // 由于本函数在全局 optionalAuth 中间件中被调用（先于所有路由），
  // 该异常会逃逸成全局 500 并绕过全部路由级限流，因此必须在此提前拒绝。
  if (!HEX64_RE.test(mac)) return null;
  let macBuf, expBuf;
  try {
    macBuf = Buffer.from(mac, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch { return null; }
  // 恒定时间比较：防止通过响应时间推断 MAC 是否接近正确值
  // 比较本身也包在 try 内，任何长度异常一律视为校验失败而非抛出
  try {
    if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  } catch { return null; }
  const expNum = Number(expiresAt);
  const iatNum = Number(iat);
  const userIdNum = Number(userId);
  const epochNum = Number(epoch);
  if (!Number.isFinite(expNum) || !Number.isFinite(iatNum) ||
      !Number.isFinite(userIdNum) || !Number.isFinite(epochNum)) return null;
  // 检查 token 是否已过期
  if (expNum <= Math.floor(Date.now() / 1000)) return null;
  if (userIdNum <= 0 || iatNum <= 0 || epochNum < 0) return null;
  // 会话世代号：与库中当前值不一致即视为已吊销
  // 这是登出/改密后旧 token 立即失效的判定点
  if (user && Number(user.session_epoch || 0) !== epochNum) return null;
  return { userId: userIdNum, iat: iatNum, epoch: epochNum };
}

// 判定本次响应是否应标记 Secure
// 默认按请求协议推断：仅 HTTPS 才标记 Secure，避免本地 HTTP 开发时 cookie 不回带
// 通过环境变量 COOKIE_SECURE=true|false 可强制覆盖
function resolveSecure(req) {
  const envSecure = process.env.COOKIE_SECURE;
  if (envSecure !== undefined) return envSecure !== 'false';
  return !!(req && req.secure);
}

// Cookie 属性集中定义
// 设置与删除必须使用完全一致的属性，否则浏览器可能忽略删除指令
// （RFC 6265：UA 可拒绝一个不带 Secure 的 Set-Cookie 去删除带 Secure 的同名 cookie）
function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: resolveSecure(req),
    path: '/',
  };
}

// 设置 Session Cookie
// 签发 token 并写入 httpOnly cookie
// httpOnly：JS 无法读取（防 XSS 窃取）
// sameSite=lax：阻止跨站 POST 携带（防 CSRF）
// secure：仅 HTTPS 传输（防网络嗅探）
function setSessionCookie(req, res, userId) {
  const iat = Math.floor(Date.now() / 1000);
  const expiresAt = iat + MAX_AGE_SECONDS;
  // 取该用户当前的会话世代号写入 token；吊销时该值 +1，旧 token 随即失效
  const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(userId);
  const epoch = row ? Number(row.session_epoch || 0) : 0;
  const token = sign(userId, iat, expiresAt, epoch);
  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions(req),
    maxAge: MAX_AGE_SECONDS * 1000,
  });
}

// 清除 session cookie（退出登录时使用）
// 属性与 setSessionCookie 保持一致；不带 maxAge/expires 即为会话级删除
function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

// 吊销某用户所有【已签发】的 session token
//
// 原理：把 users.session_epoch 加一。
// token 里带着签发时的世代号并纳入 MAC 签名，校验时要求与库中当前值相等，
// 因此加一之后所有旧 token 立刻失效，且不受任何时间精度影响。
//
// 为什么不用时间戳：秒级时间戳无法区分"同一秒内的登出与前一次登录"，
// 会出现登出后同一秒重新登录被误判为已吊销的竞态。
//
// 登出与改密都调用本函数。改密场景下调用方随后会重新签发当前会话，
// 新 token 会带上加一后的新世代号，所以操作者本设备不会被踢下线。
function revokeUserTokens(userId) {
  const info = db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(userId);
  return info.changes > 0;
}

// 用户 CRUD
const db = require('./db');

// 根据 ID 查询用户（不返回密码哈希）
// 包含 session_epoch —— verify() 用它校验 token 是否已被吊销，务必保留该字段
function getUserById(id) {
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare(
    'SELECT id, username, role, status, email, name, bio, avatar_filename, created_at, session_epoch FROM users WHERE id = ?'
  ).get(id) || null;
}

// 根据用户名查询用户（包含密码哈希，用于登录验证）
function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare(
    'SELECT id, username, role, status, email, name, bio, avatar_filename, created_at, password_hash, hash_version FROM users WHERE username = ?'
  ).get(username) || null;
}

// 列出所有用户（管理接口使用）
function listUsers() {
  return db.prepare(
    'SELECT id, username, role, status, name, email, created_at FROM users ORDER BY id ASC'
  ).all();
}

// 创建用户
// preHashed=true 表示 password 已经是 SHA-256 哈希值（来自前端）
// preHashed=false 表示 password 是明文，需先 SHA-256 再 bcrypt
// role 三档：admin（全局管理员）/ moderator（普通管理员）/ user（普通用户）
// 异步实现：bcrypt 计算开销较大（默认约 200ms），避免阻塞事件循环
async function createUser({ username, password, preHashed, role = 'user', email = null, status = 'active', verifyToken = null, verifyExpires = null }) {
  const hash = await bcrypt.hash(preHashed ? password : sha256(password), BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, hash_version, email, status, verify_token, verify_expires)
    VALUES (?, ?, ?, 2, ?, ?, ?, ?)
  `).run(username, hash, role, email, status, verifyToken, verifyExpires);
  db.invalidateUserCount();
  return getUserById(info.lastInsertRowid);
}

// 创建待邮箱验证的用户（注册专用）
// 关键：注册阶段不写入任何用户选择的密码。
// password_hash 是 NOT NULL 列，这里填一个 CSPRNG 生成的 64 位十六进制随机串——
// 它不可能等于任何前端提交的 SHA-256 值，因此该账号在设置密码前无法被登录。
// 这样即使攻击者用他人邮箱注册，也无法预置一个自己知道的密码（防账号预劫持）。
async function createPendingUser({ username, email, verifyToken, verifyExpires }) {
  const unusable = `!${crypto.randomBytes(32).toString('hex')}`;   // 前缀 ! 确保不是合法哈希格式
  const hash = await bcrypt.hash(unusable, BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, hash_version, email, status, verify_token, verify_expires)
    VALUES (?, ?, 'user', 2, ?, 'pending', ?, ?)
  `).run(username, hash, email, verifyToken, verifyExpires);
  db.invalidateUserCount();
  return getUserById(info.lastInsertRowid);
}

// 删除用户
function deleteUser(id) {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (info.changes > 0) db.invalidateUserCount();
  return info.changes > 0;
}

// 更新密码（始终使用 v2 哈希方案：bcrypt(sha256(明文))）
// 同时把 session_epoch 加一，使该用户所有已签发的 session 立即失效
async function updatePassword(id, newPassword) {
  const hash = await bcrypt.hash(sha256(newPassword), BCRYPT_COST);
  const info = db.prepare(
    'UPDATE users SET password_hash = ?, hash_version = 2, session_epoch = session_epoch + 1 WHERE id = ?'
  ).run(hash, id);
  return info.changes > 0;
}

// 密码验证
// 接受两种输入：
//   password_hash：前端已做 SHA-256（推荐，避免明文传输）
//   password：明文密码（回退方案，由后端自行计算 SHA-256）
// 按用户的 hash_version 分支：
//   1 = bcrypt(明文)              —— 历史方案，旧库迁移账号
//   2 = bcrypt(sha256(明文))      —— 当前方案
// v1 账号验证成功后透明升级为 v2，避免旧账号被永久锁死
async function verifyPassword({ password, password_hash }, user) {
  if (!user) return { ok: false };

  // v1（历史方案）：password_hash 字段存的是 bcrypt(明文)，不能用 SHA-256 值比对
  if (user.hash_version === 1) {
    // 只有拿到明文才能验证旧方案；前端已做 SHA-256 时无法还原明文，直接拒绝
    if (!password) return { ok: false };
    if (!(await bcrypt.compare(password, user.password_hash))) return { ok: false };
    // 成功即透明升级，之后走 v2 路径
    try {
      const upgraded = await bcrypt.hash(sha256(password), BCRYPT_COST);
      db.prepare('UPDATE users SET password_hash = ?, hash_version = 2 WHERE id = ?')
        .run(upgraded, user.id);
    } catch { /* 升级失败不影响本次登录 */ }
    return { ok: true, user };
  }

  // v2（当前方案）
  // 优先使用 password_hash（前端 SHA-256）
  if (password_hash) {
    return await bcrypt.compare(password_hash, user.password_hash) ? { ok: true, user } : { ok: false };
  }

  // 回退：前端未做 SHA-256，后端自行计算
  if (password) {
    const hash = sha256(password);
    return await bcrypt.compare(hash, user.password_hash) ? { ok: true, user } : { ok: false };
  }

  return { ok: false };
}

// 鉴权中间件

// requireAuth：验证 session token，将用户信息挂载到 req.user
// requireAuth：验证 session token，将用户信息挂载到 req.user
// 吊销校验（会话世代号）在 verify() 内完成，因此必须把用户记录传给它
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  // 先用不带 user 的调用做一次廉价格式检查，拿到 userId 再去查库
  const pre = verify(token);
  if (!pre) return res.status(401).json({ error: 'unauthorized' });
  const user = getUserById(pre.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  // 带 user 再校验一次：这次会比对 session_epoch，token 已被吊销则返回 null
  const session = verify(token, user);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

// optionalAuth：尝试解析 session 并挂载到 req.user；失败不阻断请求
// 用于公开但需要个性化输出的端点（如 /api/data 公开版）
// 解析失败时 req.user 为 undefined
function optionalAuth(req, _res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    const pre = verify(token);
    if (!pre) return next();
    const user = getUserById(pre.userId);
    if (user && verify(token, user)) {
      req.user = user;
    }
  } catch (e) {
    // 审计 H2：公开访问不能被异常阻断，但要让运维能看到会话解析失败
    // （DB 错误、token 异常等），便于排查
    const msg = e && e.message ? String(e.message).slice(0, 200) : 'unknown';
    console.warn('[optionalAuth] session parse failed:', msg);
  }
  next();
}

// requireAdmin：仅全局管理员（admin）可通过
// 内部先执行 requireAuth，避免调用方漏链导致 req.user 为空时绕过校验
function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });
}

// requireManager：后台管理者（全局 admin + 普通管理员 moderator）可通过
function requireManager(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  revokeUserTokens,
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireManager,
  verify,
  COOKIE_NAME,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  createPendingUser,
  deleteUser,
  updatePassword,
  verifyPassword,
  sha256,
  BCRYPT_COST,
};
