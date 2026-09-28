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

function decrypt(payload) {
  if (!payload) return '';
  // 兼容历史明文配置：base64 解码失败、长度不足或 GCM 校验失败时
  // 原样返回，便于从明文平滑升级到密文
  let buf;
  try { buf = Buffer.from(payload, 'base64'); } catch { return payload; }
  if (buf.length < 12 + 16) return payload;
  try {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return payload;
  }
}

// 粗判字符串是否已经加密（基于长度与字符集，仅用于防止重复加密）
function isEncrypted(payload) {
  if (!payload) return false;
  // 加密后为 base64，最小 28 字节密文对应至少 38 个 base64 字符
  if (payload.length < 38) return false;
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

module.exports = { encrypt, decrypt, isEncrypted };
