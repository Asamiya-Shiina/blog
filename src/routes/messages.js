'use strict';

// 留言板路由
//
// 接口说明：
//   GET    /api/messages        公开：嵌套列表（顶层 + replies）。管理员响应额外携带 IP。
//   POST   /api/messages        登录 + 限流：新建留言或回复。
//   DELETE /api/messages/:id    登录：作者本人或管理员可删。
//
// 属地由 geoip-lite 在服务端解析，前端不感知；IP 仅管理员可见。
// 留言内容禁止零宽字符与控制字符（除常见换行 / 制表外），防止混淆、绕过审核以及对前端渲染的注入攻击
// 留言内容长度限制 2000 字符，防止刷屏与 SQLite 被塞爆
// 留言写操作限流：15 分钟内最多 30 次，防止刷屏
// by ALyCE_Aoi

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../auth');
const { getClientIp, formatLocation } = require('../ip');

const router = express.Router();

// 留言写操作限流：15 分钟内最多 30 次，防止刷屏
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// 留言读限流：每 IP 每分钟最多 60 次
// 该端点是公开且免登录的，且每行都会触发 geoip 属地解析，
// 无限流时可被反复调用消耗 CPU（属地为惰性加载，首次加载约 100MB）
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// 删除限流：15 分钟最多 30 次，防止高频删除
const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// 将数据库行映射为对外暴露的留言对象
// is_owner 让前端直接判断是否可删除，无需再次比对 user_id
// avatar_url 始终返回（头像本身是公开资源）；ip 仅管理员可见
function shapeMessage(row, viewer) {
  const isAdmin = viewer && viewer.role === 'admin';
  return {
    id: row.id,
    parent_id: row.parent_id,
    user_id: row.user_id,
    username: row.username,
    name: row.name,            // 个人主页昵称（前台优先展示），未设置时为空
    role: row.role,
    avatar_url: row.avatar_filename ? `/avatar/${encodeURIComponent(row.avatar_filename)}` : null,
    content: row.content,
    location: formatLocation(row.ip),
    ip: isAdmin ? row.ip : undefined,
    created_at: row.created_at,
    is_owner: !!(viewer && viewer.id === row.user_id),
  };
}

const SELECT_SQL = `
  SELECT m.id, m.user_id, m.parent_id, m.content, m.ip, m.created_at,
         u.username, u.name, u.role, u.avatar_filename
    FROM messages m
    JOIN users u ON u.id = m.user_id
`;

// GET /api/messages：嵌套列表（分页）
//
// 为什么要分页：
//   旧实现无 LIMIT 全表返回，且每行都调用 formatLocation —— 这会触发 geoip-lite
//   惰性加载（实测 RSS +101.7MB，常驻不可回收）。公开且无限流的端点叠加无界查询，
//   是配合上传 OOM 打出服务中断的最省力路径。
//
// 分页语义（游标式，避免深分页 OFFSET 扫描）：
//   默认取最新的一页（200 条顶层留言，含其回复）
//   传 before=<id> 可继续向前翻（加载更多）：返回 id < before 的更新一页
//   响应带 has_more，前端据此决定是否显示"加载更多"
const PAGE_SIZE = 200;

// 单页最多返回的留言总数（含回复），防止某条顶层留言回复极多时单页过大
const MAX_ROWS = PAGE_SIZE * 3;

router.get('/', readLimiter, (req, res) => {
  const before = parseInt(req.query.before, 10);
  const useCursor = Number.isInteger(before) && before > 0;

  // 先取一页顶层留言（parent_id IS NULL），再取这些顶层留言的全部回复
  // 这样回复不会把分页游标打乱，也不会出现"父留言不在本页"的孤儿
  const tops = useCursor
    ? db.prepare(`
        SELECT id FROM messages
        WHERE parent_id IS NULL AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(before, PAGE_SIZE)
    : db.prepare(`
        SELECT id FROM messages
        WHERE parent_id IS NULL
        ORDER BY id DESC LIMIT ?
      `).all(PAGE_SIZE);

  if (tops.length === 0) {
    return res.json({ messages: [], has_more: false, next_before: null });
  }

  const topIds = tops.map(t => t.id);
  const placeholders = topIds.map(() => '?').join(',');
  // 取这些顶层留言本身 + 它们的全部回复（回复按时间正序展示更自然）
  const rows = db.prepare(`
    ${SELECT_SQL}
    WHERE m.id IN (${placeholders}) OR m.parent_id IN (${placeholders})
    ORDER BY m.created_at ASC
  `).all(...topIds, ...topIds).slice(0, MAX_ROWS);

  const viewer = req.user || null;     // 允许未登录查看列表
  const byId = new Map();
  const orderedTops = [];
  for (const r of rows) {
    const shaped = shapeMessage(r, viewer);
    shaped.replies = [];
    byId.set(r.id, shaped);
  }
  // 按 tops 的顺序（id 倒序 = 时间倒序）组装，回复挂到父级之下
  for (const id of topIds) {
    const shaped = byId.get(id);
    if (shaped) orderedTops.push(shaped);
  }
  for (const r of rows) {
    if (r.parent_id != null) {
      const parent = byId.get(r.parent_id);
      if (parent) parent.replies.push(byId.get(r.id));
      // 父级不在本页时丢弃（分页边界正常现象，不会出现孤儿展示）
    }
  }

  // 是否还有更早的顶层留言
  const oldest = topIds[topIds.length - 1];
  const more = db.prepare(
    'SELECT 1 FROM messages WHERE parent_id IS NULL AND id < ? LIMIT 1'
  ).get(oldest);

  res.json({
    messages: orderedTops,
    has_more: !!more,
    next_before: more ? oldest : null,
  });
});

// 过滤零宽字符与控制字符（除常见换行 / 制表外）
// 用于防止内容混淆、绕过审核以及对前端渲染的注入攻击
// 覆盖范围：零宽空格、连字、不连字、连接符、左右向控制符、双向控制符、BOM、ASCII 控制字符
const FORBIDDEN_CONTENT = /[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// POST /api/messages：新建或回复
const createSchema = z.object({
  content: z.string().trim().min(1).max(2000)
    .refine(s => !FORBIDDEN_CONTENT.test(s), { message: 'content contains forbidden control characters' }),
  parent_id: z.number().int().positive().optional().nullable(),
});

router.post('/', requireAuth, writeLimiter, (req, res) => {
  // 未上传头像的用户不能发布留言（头像作为身份标识）
  if (!req.user.avatar_filename) {
    return res.status(403).json({ error: '请先在个人主页上传头像' });
  }

  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid request', detail: parsed.error.issues });

  // 回复目标必须存在；不允许无限嵌套（回复的回复也仅挂在顶层之下）
  if (parsed.data.parent_id) {
    const parent = db.prepare('SELECT id, parent_id FROM messages WHERE id = ?').get(parsed.data.parent_id);
    if (!parent) return res.status(404).json({ error: 'parent not found' });
    if (parent.parent_id) parsed.data.parent_id = parent.parent_id;
  }

  const ip = getClientIp(req);
  const info = db.prepare(`
    INSERT INTO messages (user_id, parent_id, content, ip)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, parsed.data.parent_id || null, parsed.data.content, ip || null);

  const row = db.prepare(SELECT_SQL + ' WHERE m.id = ?').get(info.lastInsertRowid);
  res.status(201).json({ message: shapeMessage(row, req.user) });
});

// DELETE /api/messages/:id：作者本人或管理员
router.delete('/:id', requireAuth, deleteLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  res.status(204).end();
});

module.exports = router;