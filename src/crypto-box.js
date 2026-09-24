'use strict';

// AES-256-GCM 加密 / 解密小工具
// 用于把 SMTP 密码这类敏感字段在落 SQLite 前加密
// key 从 SESSION_SECRET 派生（scrypt 强 KDF），保证密钥本身不直接落盘
// 同一 SECRET + 同一明文 + 同一 IV 永远产生同一密文，但每次加密都用随机 IV
//
// 输出格式：base64(iv 12B || authTag 16B || ciphertext)

const crypto = require('node:crypto');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  // 与 src/auth.js 的硬性要求保持一致
  console.error('SESSION_SECRET is not set or too short');
  process.exit(1);
}

// 固定 salt：和 SECRET 一起派生固定 key
// salt 公开与否没关系（它不是密钥，只是 KDF 的额外熵）
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
  // 旧版配置可能还是明文：base64 解码失败 / 长度不够 / GCM 验证失败时
  // 直接把原文返回，方便从明文无痛升级到密文
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

// 标记一个字符串是否已经加密（不严格，只是用长度 + 字符集粗判，
// 用来避免重复加密已经是密文的内容）
function isEncrypted(payload) {
  if (!payload) return false;
  // 加密后是 base64，最小 28 字节密文 → base64 至少 38 字符
  if (payload.length < 38) return false;
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

module.exports = { encrypt, decrypt, isEncrypted };
