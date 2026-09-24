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
  -- 用户表：三档角色（admin 全局管理员 / moderator 普通管理员 / user 普通用户）
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user'
                     CHECK (role IN ('admin','moderator','user')),
    email          TEXT UNIQUE,                   -- 注册邮箱（未配置 SMTP 时可不填）
    status         TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','pending')),  -- pending=待邮箱验证
    verify_token   TEXT,                          -- 邮箱验证令牌
    verify_expires TEXT,                          -- 验证令牌到期时间
    name           TEXT,                          -- 名字（个人主页）
    bio            TEXT,                          -- 签名（个人主页）
    avatar_filename TEXT,                         -- 头像磁盘文件名
    hash_version   INTEGER NOT NULL DEFAULT 1,    -- 密码哈希方案版本
    created_at     TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))  -- 北京时间
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  -- 注意：email 索引不在此建，旧库迁移前尚无 email 列；统一在下方迁移后创建

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

  -- 音乐库：管理处上传的音频文件
  CREATE TABLE IF NOT EXISTS music (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL UNIQUE,                 -- 磁盘文件名（随机生成）
    original_name TEXT NOT NULL,                        -- 用户上传时的原始文件名
    title         TEXT NOT NULL,                        -- 显示标题（默认取自 original_name）
    mime          TEXT NOT NULL,                        -- MIME 类型
    size_bytes    INTEGER NOT NULL,                     -- 文件大小
    created_at    TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_music_created ON music(created_at DESC);

  -- 音乐设置：单行表，存当前激活的歌曲
  -- id 固定为 1，只允许一条记录
  CREATE TABLE IF NOT EXISTS music_settings (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    active_id INTEGER REFERENCES music(id) ON DELETE SET NULL
  );
  -- 初始化单行
  INSERT OR IGNORE INTO music_settings (id, active_id) VALUES (1, NULL);

  -- 分类表：后台维护的分类名（article categorization）
  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,                -- 分类名
    created_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );

  -- 文章分类关联表：一篇文章可关联多个分类（多对多）
  -- 删除文章/分类时自动清理关联记录（外键 CASCADE）
  CREATE TABLE IF NOT EXISTS post_categories (
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, category_id)
  );
  -- 按分类索引，加速按分类筛选文章
  CREATE INDEX IF NOT EXISTS idx_post_categories_cat
    ON post_categories(category_id);

  -- 页面访问记录：用于统计今日浏览人数
  -- 每页包含路径、访客 IP、访问时间
  CREATE TABLE IF NOT EXISTS page_views (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL,                       -- 访问路径
    ip         TEXT NOT NULL,                       -- 访客 IP
    viewed_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))  -- 北京时间
  );
  -- 按时间索引，加速今日统计查询
  CREATE INDEX IF NOT EXISTS idx_page_views_at ON page_views(viewed_at);
  -- 按 IP+时间索引，加速去重计数
  CREATE INDEX IF NOT EXISTS idx_page_views_ip_at ON page_views(ip, viewed_at);

  -- 留言板：用户之间 / 用户与站主的简短对话，支持嵌套回复
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,  -- NULL = 顶层留言
    content     TEXT NOT NULL,                     -- 留言内容
    ip          TEXT,                              -- 发帖人 IP（管理员可见，其他人只看属地）
    created_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
`);

// —— 数据库迁移 ——

// 迁移 1：users 表添加 hash_version 列，区分密码哈希方案
// 1 = bcrypt(明文)（旧方案）
// 2 = bcrypt(sha256(明文))（当前方案，解决 bcrypt 72 字节限制）
try {
  db.exec(`ALTER TABLE users ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1`);
} catch (_) { /* 列已存在则忽略 */ }

// 迁移 2：users 表结构升级（开放注册 + 个人主页）
// 旧表 role 仅允许 'admin'，且缺 email/status/verify/name/bio/avatar 列。
// SQLite 改 CHECK 约束必须重建表，这里检测到缺 email 列即触发一次性重建。
const userCols = db.pragma('table_info(users)').map(c => c.name);
if (!userCols.includes('email')) {
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.transaction(() => {
    db.exec(`
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        username       TEXT NOT NULL UNIQUE,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL DEFAULT 'user'
                         CHECK (role IN ('admin','moderator','user')),
        email          TEXT UNIQUE,
        status         TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','pending')),
        verify_token   TEXT,
        verify_expires TEXT,
        name           TEXT,
        bio            TEXT,
        avatar_filename TEXT,
        hash_version   INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
      );
      INSERT INTO users (id, username, password_hash, role, hash_version, created_at)
        SELECT id, username, password_hash, role, hash_version, created_at FROM users_old;
      DROP TABLE users_old;
      CREATE INDEX idx_users_username ON users(username);
      CREATE INDEX idx_users_email ON users(email);
    `);
  })();
  db.exec(`PRAGMA foreign_keys = ON`);
}

// 保证 email 索引存在（全新库或迁移后都成立）
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
} catch (_) { /* 列尚不存在则忽略，等迁移后再建 */ }

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
