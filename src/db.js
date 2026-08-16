'use strict';

// —— 数据库初始化模块 ——
// 使用 better-sqlite3（同步 SQLite 驱动），启动时自动建表和迁移

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 数据库文件路径，默认 ./data/blog.sqlite，可通过 DB_PATH 环境变量覆盖
const DB_PATH = process.env.DB_PATH || './data/blog.sqlite';

// 确保数据目录存在
const dir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// WAL 模式：允许读写并发，提升多读者场景性能
db.pragma('journal_mode = WAL');
// 外键约束：确保数据完整性
db.pragma('foreign_keys = ON');

// —— 建表语句 ——
db.exec(`
  -- 用户表：存储管理员账号
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin')),       -- 目前只允许 admin 角色
    created_at    TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))  -- 北京时间
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

  -- 文章表：Markdown 内容 + 发布状态
  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,                -- URL 友好的唯一标识
    title       TEXT NOT NULL,
    excerpt     TEXT,                                -- 摘要（可选）
    content_md  TEXT NOT NULL,                       -- Markdown 原文
    status      TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );
  -- 按状态和更新时间索引，加速列表查询
  CREATE INDEX IF NOT EXISTS idx_posts_status_updated
    ON posts(status, updated_at DESC);

  -- 状态配置表：键值对存储，用于实时状态功能的管理配置
  CREATE TABLE IF NOT EXISTS status_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL                                  -- JSON 字符串
  );
`);

// —— 数据库迁移 ——
// users 表添加 hash_version 列：区分密码哈希方案
// 1 = bcrypt(明文)（旧方案）
// 2 = bcrypt(sha256(明文))（当前方案，解决 bcrypt 72 字节限制）
try {
  db.exec(`ALTER TABLE users ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1`);
} catch (_) { /* 列已存在则忽略 */ }

// —— 初始化默认状态配置 ——
// 首次运行时插入默认值，后续启动不会覆盖（INSERT OR IGNORE）
const defaultConfig = {
  // 黑名单：这些应用不会上报状态（密码管理器、系统工具等）
  blacklist: JSON.stringify(['1Password', 'KeePass', 'LastPass', 'Bitwarden', 'Windows Security', 'Task Manager', 'Registry Editor', 'cmd', 'powershell']),
  // 黑名单正则：窗口标题匹配这些模式的应用不上报
  blacklistPatterns: JSON.stringify(['.*密码.*', '.*password.*']),
  // 应用名映射：进程名 → 显示名
  appNames: JSON.stringify({ 'Code': 'VS Code', 'chrome': 'Chrome', 'firefox': 'Firefox', 'msedge': 'Edge', 'idea64': 'IntelliJ IDEA', 'Obsidian': 'Obsidian', 'Figma': 'Figma', 'Typora': 'Typora', 'notion': 'Notion', 'Spotify': 'Spotify', 'Discord': 'Discord', 'WindowsTerminal': 'Windows Terminal' }),
  // 应用名正则映射：进程名匹配正则时使用指定显示名
  appNamePatterns: JSON.stringify([{ pattern: '^explorer$', name: '文件资源管理器' }]),
  // 显示窗口标题的应用：这些应用的状态会显示当前文档/网页标题
  titleApps: JSON.stringify(['Code', 'chrome', 'firefox', 'msedge', 'idea64', 'Obsidian', 'Typora', 'notion']),
};

const insertConfig = db.prepare('INSERT OR IGNORE INTO status_config (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultConfig)) {
  insertConfig.run(key, value);
}

// 查询用户总数（用于首次引导判断）
function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

module.exports = db;
module.exports.userCount = userCount;
