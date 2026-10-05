'use strict';

// 邮件发送模块
// 从 status_config 读取管理员配置的 SMTP（key='smtp'），通过 nodemailer 发送验证邮件
// 未配置 SMTP 或配置不完整时返回 { sent:false }，由路由决定是否跳过邮箱验证

const nodemailer = require('nodemailer');
const db = require('./db');
const { decrypt, tryDecrypt } = require('./crypto-box');

// 读取 SMTP 原始配置行（未解密）
function readSmtpRow() {
  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// 读取 SMTP 配置并解密密码
// 返回 { state, config, reason }：
//   state='not_configured' 管理员尚未填写完整配置（注册应被拒绝并提示）
//   state='broken'         配置存在但密码解不开（密钥被轮换/改动）——必须大声报错，绝不静默降级
//   state='ok'             可用，config 为解密后的完整配置
// 注意：本函数不会把解不开的密文当作密码返回（旧实现会，导致注册静默失效）
function getSmtpStatus() {
  const cfg = readSmtpRow();
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) {
    return { state: 'not_configured', config: null, reason: null };
  }
  const r = tryDecrypt(cfg.pass);
  if (!r.ok) {
    return { state: 'broken', config: null, reason: r.reason };
  }
  return { state: 'ok', config: { ...cfg, pass: r.value }, reason: null };
}

// 兼容旧调用方：仅在配置可用时返回配置，否则返回 null
function getSmtpConfig() {
  const s = getSmtpStatus();
  return s.state === 'ok' ? s.config : null;
}

// 解析站点根地址，用于拼接验证链接
// 安全前提：绝不能用客户端可控的 Host 头去拼邮件里的链接
// （攻击者带 Host: evil.tld 注册，受害者会收到一封真实来自本站、
//   但链接指向攻击者域名的邮件，验证令牌直接泄露）
//
// 优先级：
//   ① SITE_URL 环境变量（生产强烈建议显式设置，这是唯一可靠来源）
//   ② ALLOWED_HOSTS 白名单内的请求 Host（本地开发 / 多域名场景）
//   ③ localhost 兜底
// 返回 { url, trusted }：trusted=false 表示 url 不可信，调用方应拒绝发信
//
// 审计 H7：原实现把 ALLOWED_HOSTS 在模块加载时一次性求值，
// 运维在进程内改 env（如 dotenv 重载）不会生效。
// 改为每次调用重新解析 env，env 变动即时生效（仍然 O(n)，n=白名单长度，足够便宜）。
function getAllowedHosts() {
  return new Set(
    String(process.env.ALLOWED_HOSTS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function baseUrl(req) {
  const hint = process.env.SITE_URL;
  if (hint) return { url: hint.replace(/\/$/, ''), trusted: true };

  if (req && req.get) {
    const host = (req.get('host') || '').toLowerCase();
    const ALLOWED_HOSTS = getAllowedHosts();   // 每次重新解析，env 改动即时生效
    if (host && ALLOWED_HOSTS.has(host)) {
      return { url: `${req.protocol || 'http'}://${host}`.replace(/\/$/, ''), trusted: true };
    }
    // 有 Host 但不在白名单，且没有 SITE_URL：不可信
    if (host) return { url: '', trusted: false };
  }
  // 无 Host 信息（内部调用）：回落 localhost，仅供本地开发
  return { url: 'http://localhost:' + (process.env.PORT || '3000'), trusted: true };
}

// req 可选：传入时验证链接自动跟随当前请求的域名与协议；不传则回落到 SITE_URL 或 localhost
// 返回 { sent, reason }：reason 用于上层区分"没配 SMTP"与"配置坏了"
async function sendVerifyEmail(token, toEmail, username, req) {
  const status = getSmtpStatus();
  if (status.state !== 'ok') {
    // 不静默失败：把状态回传给路由，由路由决定是否拒绝注册并明确报错
    return { sent: false, reason: status.state, detail: status.reason };
  }
  const cfg = status.config;

  const base = baseUrl(req);
  if (!base.trusted) {
    console.warn(
      '[mailer] 拒绝发送验证邮件：请求 Host 不在 ALLOWED_HOSTS 白名单内，且未设置 SITE_URL。' +
      '请设置 SITE_URL（推荐）或把域名加入 ALLOWED_HOSTS。'
    );
    return { sent: false, reason: 'untrusted_host' };
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    // 明文端口强制 STARTTLS：否则可被能力剥离型中间人降级，AUTH 凭据明文外泄
    requireTLS: !cfg.secure,
    tls: { minVersion: 'TLSv1.2' },
    auth: { user: cfg.user, pass: cfg.pass },
  });
  // 拼装 from 字段：
  // QQ / Outlook SMTP 均要求发件地址必须是认证账户（含 @ 的完整地址），
  // 否则会被拒绝并返回 sender rejected。这里将 sender 作为显示名，user 作为地址。
  let sender = cfg.sender;
  if (!sender || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    // 留空或已是完整邮箱地址，直接使用
    sender = sender || cfg.user;
  } else {
    sender = `${sender} <${cfg.user}>`;
  }
  const link = `${base.url}/verify/?token=${encodeURIComponent(token)}`;

  try {
    await transport.sendMail({
      from: sender,
      to: toEmail,
      subject: '验证你的博客账号',
      text: `你正在为账号「${username}」验证邮箱 ${toEmail}。\n\n如果不是本人操作，请忽略此邮件。\n\n请点击以下链接完成邮箱验证：\n\n${link}\n\n链接 15 分钟内有效。`,
    });
    return { sent: true };
  } catch (e) {
    // 错误日志脱敏：仅输出 SMTP code 与 message，
    // 避免泄露 envelope、附件与堆栈等敏感信息
    // （nodemailer 错误对象可能携带 SMTP envelope，包含完整收发件人；生产排查不需要）
    const code = e && (e.code || (e.responseCode != null ? String(e.responseCode) : ''));
    const msg = (e && e.message) ? String(e.message).slice(0, 200) : 'unknown';
    console.warn(`sendVerifyEmail failed: ${code ? `[${code}] ` : ''}${msg}`);
    return { sent: false, reason: 'send_failed' };
  } finally {
    transport.close();
  }
}

module.exports = { getSmtpConfig, getSmtpStatus, sendVerifyEmail, baseUrl };