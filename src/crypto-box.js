'use strict';

// AES-256-GCM 加密 / 解密工具
// 用于把 SMTP 密码等敏感字段在写入 SQLite 前加密
// 密钥由 SESSION_SECRET 经 scrypt 派生，避免密钥本身落盘
// 每次加密使用随机 IV，加密结果不可重复
//
// 输出格式：base64(iv 12B || authTag 16B || ciphertext)

const crypto = require('node:crypto');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  // 与 src/auth.js 中 SECRET 长度下限保持一致
  console.error('SESSION_SECRET is not set or too short');
  process.exit(1);
}

// 固定 salt：与 SECRET 一起派生固定 key
// salt 不是密钥，只是 KDF 所需的额外熵，公开不影响安全性
const SALT = 'asamiya-blog:smtp-encryption:v1';
const KEY = crypto.scryptSync(SECRET, SALT, 32);

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

// 解密失败异常
// 调用方必须显式处理，绝不能把密文当成明文继续使用
class DecryptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptError';
  }
}

// 解密
// 返回值语义：
//   成功            -> 明文
//   payload 为空    -> ''（未配置）
//   密文但解不开    -> 抛 DecryptError（fail-closed）
//
// 设计说明（重要）：
// 历史上本函数在解密失败时 return payload，把 base64 密文当作"密码"返回。
// 这会造成静默故障：SESSION_SECRET 轮换后，getSmtpConfig() 仍认为配置完整，
// 于是 needsVerify=true，所有注册都变成 pending 且邮件永远发不出去，
// 15 分钟后被清理，而管理后台仍显示"已配置"。
// 现在改为抛错，让上层明确拒绝服务并大声报错。
//
// 兼容历史明文：只对"明显不是本方案密文"的输入放行（base64 解码失败或长度不足）。
// 长度足够的输入一律按密文处理——GCM 认证标签失败必须视为密钥错误，不得降级。
function decrypt(payload) {
  if (!payload) return '';

  let buf;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch {
    // 不是合法 base64：视为历史明文配置
    return payload;
  }
  // 长度不足以容纳 iv(12) + authTag(16)：视为历史明文配置
  if (buf.length < 12 + 16) return payload;

  try {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    throw new DecryptError(
      'SMTP 密码解密失败：加密密钥与写入时不一致（通常是 SESSION_SECRET 被轮换或改动）。' +
      '请在后台重新填写 SMTP 密码以修复。'
    );
  }
}

// 尝试解密但不抛错，供只想知道"是否可用"的调用方使用
// 返回 { ok: true, value } 或 { ok: false, reason }
function tryDecrypt(payload) {
  try {
    return { ok: true, value: decrypt(payload) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 粗判字符串是否已经加密（基于长度与字符集，仅用于防止重复加密）
function isEncrypted(payload) {
  if (!payload) return false;
  // 加密后为 base64，最小 28 字节密文对应至少 38 个 base64 字符
  if (payload.length < 38) return false;
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

module.exports = { encrypt, decrypt, tryDecrypt, isEncrypted, DecryptError };
