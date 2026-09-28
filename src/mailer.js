'use strict';

// 邮件发送模块
// 从 status_config 读取管理员配置的 SMTP（key='smtp'），通过 nodemailer 发送验证邮件
// 未配置 SMTP 或配置不完整时返回 { sent:false }，由路由决定是否跳过邮箱验证

const nodemailer = require('nodemailer');
const db = require('./db');
const { decrypt } = require('./crypto-box');

// 读取 SMTP 配置；host/user/pass 任一缺失即视为未配置
// pass 以密文形式落库，此处解密为明文后返回
function getSmtpConfig() {
  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  if (!row) return null;
  let cfg;
  try { cfg = JSON.parse(row.value); } catch { return null; }
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) return null;
  const plain = decrypt(cfg.pass);
  return { ...cfg, pass: plain };
}

// 构造站点根地址，用于拼接验证链接
// 优先级：① SITE_URL 环境变量显式覆盖 → ② 请求自身（req.protocol / req.host，
// 在前置 HTTPS 反代 + TRUST_PROXY=1 时可还原为 https://你的域名）→ ③ 本地 localhost 兜底
function baseUrl(req) {
  const hint = process.env.SITE_URL;
  if (hint) return hint.replace(/\/$/, '');
  if (req && req.get) {
    const host = req.get('host');
    if (host) return `${req.protocol || 'http'}://${host}`.replace(/\/$/, '');
  }
  return 'http://localhost:' + (process.env.PORT || '3000');
}

// req 可选：传入时验证链接自动跟随当前请求的域名与协议；不传则回落到 SITE_URL 或 localhost
async function sendVerifyEmail(token, toEmail, username, req) {
  const cfg = getSmtpConfig();
  if (!cfg) return { sent: false };

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
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
  const link = `${baseUrl(req)}/api/verify?token=${encodeURIComponent(token)}`;

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
    return { sent: false };
  } finally {
    transport.close();
  }
}

module.exports = { getSmtpConfig, sendVerifyEmail };