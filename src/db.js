'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/blog.sqlite';

// Ensure data dir exists
const dir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    excerpt     TEXT,
    content_md  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_posts_status_updated
    ON posts(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS status_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 迁移：users 表添加 hash_version 列
// 1 = bcrypt(明文)，2 = bcrypt(sha256(明文))
try {
  db.exec(`ALTER TABLE users ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1`);
} catch (_) { /* 列已存在则忽略 */ }

// 初始化默认状态配置
const defaultConfig = {
  blacklist: JSON.stringify(['1Password', 'KeePass', 'LastPass', 'Bitwarden', 'Windows Security', 'Task Manager', 'Registry Editor', 'cmd', 'powershell']),
  blacklistPatterns: JSON.stringify(['.*密码.*', '.*password.*']),
  appNames: JSON.stringify({ 'Code': 'VS Code', 'chrome': 'Chrome', 'firefox': 'Firefox', 'msedge': 'Edge', 'idea64': 'IntelliJ IDEA', 'Obsidian': 'Obsidian', 'Figma': 'Figma', 'Typora': 'Typora', 'notion': 'Notion', 'Spotify': 'Spotify', 'Discord': 'Discord', 'WindowsTerminal': 'Windows Terminal' }),
  appNamePatterns: JSON.stringify([{ pattern: '^explorer$', name: '文件资源管理器' }]),
  titleApps: JSON.stringify(['Code', 'chrome', 'firefox', 'msedge', 'idea64', 'Obsidian', 'Typora', 'notion']),
};

const insertConfig = db.prepare('INSERT OR IGNORE INTO status_config (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultConfig)) {
  insertConfig.run(key, value);
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

module.exports = db;
module.exports.userCount = userCount;
