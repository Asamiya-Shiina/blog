'use strict';

// —— 邮件发送模块 ——
// 从 status_config 读取全局管理员配置的 SMTP(key='smtp'),用 nodemailer 发验证信。
// 未配置 SMTP(或配置不完整)时返回 { sent:false },由路由决定跳过邮箱验证。

const nodemailer = require('nodemailer');
const db = require('./db');
const { decrypt } = require('./crypto-box');

// 读取 SMTP 配置;host/user/pass 缺任一视为未配置
// pass 是加密落库的，这里读出来时自动解密回明文
function getSmtpConfig() {
  const row = db.prepare("SELECT value FROM status_config WHERE key = 'smtp'").get();
  if (!row) return null;
  let cfg;
  try { cfg = JSON.parse(row.value); } catch { return null; }
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) return null;
  const plain = decrypt(cfg.pass);
  return { ...cfg, pass: plain };
}

// 站点根地址,用于拼验证链接;可用 SITE_URL 覆盖
function baseUrl() {
  const hint = process.env.SITE_URL;
  if (hint) return hint.replace(/\/$/, '');
  return 'http://localhost:' + (process.env.PORT || '3000');
}

async function sendVerifyEmail(token, toEmail) {
  const cfg = getSmtpConfig();
  if (!cfg) return { sent: false };

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  // 拼 from 字段：QQ/Outlook SMTP 都要求发件地址必须是认证账户（含 @ 的完整地址），
  // 否则会被拒为 sender rejected。这里把 sender 当显示名，user 当地址。
  let sender = cfg.sender;
  if (!sender || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    // 留空或已是完整邮箱：直接用
    sender = sender || cfg.user;
  } else {
    sender = `${sender} <${cfg.user}>`;
  }
  const link = `${baseUrl()}/api/verify?token=${encodeURIComponent(token)}`;

  try {
    await transport.sendMail({
      from: sender,
      to: toEmail,
      subject: '验证你的博客账号',
      text: `请点击以下链接完成邮箱验证：\n\n${link}\n\n链接 15 分钟内有效。若不是你本人操作，可忽略此邮件。`,
    });
    return { sent: true };
  } catch (e) {
    console.warn('sendVerifyEmail failed:', e.message);
    return { sent: false };
  } finally {
    transport.close();
  }
}

module.exports = { getSmtpConfig, sendVerifyEmail };