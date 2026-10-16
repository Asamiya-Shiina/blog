'use strict';

// 分类路由（全部 requireManager）
// 删除分类时关联记录由外键 CASCADE 自动清理

const express = require('express');
const { z } = require('zod');

const db = require('../db');
const { requireManager } = require('../auth');

const router = express.Router();

// 分类名校验 schema:1-50 字符、trim 后非空。
// max(50) 经验值:UI 侧栏一行能放下的最长分类名;再长会换行影响布局。
// transform trim:避免前后空白造成「看似不存在实则撞名」的歧义(z.string().min(1)
// 在 trim 前判长度,但 trim 后可能变空 → 这里二次判在调用方)。
const nameSchema = z.object({
  name: z.string().min(1).max(50).transform(s => s.trim()),
});

// 查询某文章关联的分类列表(供 posts 路由复用,挂在 router 上 export 出去)。
// 单文章查询走该函数,批量走 posts.js 内部的 categoriesForPosts(N+1 优化版)。
function getPostCategories(postId) {
  return db.prepare(`
    SELECT c.id, c.name
    FROM categories c
    JOIN post_categories pc ON pc.category_id = c.id
    WHERE pc.post_id = ?
    ORDER BY c.name
  `).all(postId);
}

// 分类列表
// GET /api/categories：返回全部分类，附带每类的已关联文章数
router.get('/', requireManager, (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.created_at,
           (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS post_count
    FROM categories c
    ORDER BY c.name
  `).all();
  res.json({ items: rows });
});

// 新建分类
// POST /api/categories
router.post('/', requireManager, (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.name) {
    return res.status(400).json({ error: 'invalid name' });
  }
  const name = parsed.data.name;
  const exists = db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ error: 'name already exists' });

  const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  const row = db.prepare('SELECT id, name, created_at FROM categories WHERE id = ?')
    .get(info.lastInsertRowid);
  // 新建分类的文章数默认为 0
  res.status(201).json({ ...row, post_count: 0 });
});

// 重命名分类
// PUT /api/categories/:id
router.put('/:id', requireManager, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const existing = db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.name) {
    return res.status(400).json({ error: 'invalid name' });
  }
  const name = parsed.data.name;
  const clash = db.prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?').get(name, id);
  if (clash) return res.status(409).json({ error: 'name already exists' });

  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
  const row = db.prepare('SELECT id, name, created_at FROM categories WHERE id = ?').get(id);
  const n = db.prepare('SELECT COUNT(*) AS n FROM post_categories WHERE category_id = ?').get(id).n;
  res.json({ ...row, post_count: n });
});

// 删除分类
// DELETE /api/categories/:id：关联的 post_categories 记录由外键 CASCADE 自动清理
router.delete('/:id', requireManager, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
module.exports.getPostCategories = getPostCategories;