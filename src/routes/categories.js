'use strict';

// —— 分类路由 ——
// 分类列表、新建、重命名、删除都归这儿管
// 后台维护的分类列表，给编辑器多选用，也给全站筛选用
// 所有路由都要登录（requireAuth），别忘了哦
// 注：新建/重命名经 zod 校验唯一性；删除分类时关联记录由外键 CASCADE 自动清理
// by ALyCE_Aoi
// 后台维护的分类列表，供编辑器多选与全站筛选
// 所有路由都需要登录（requireAuth）
// 注：新建/重命名经 zod 校验唯一性；删除分类时关联记录由外键 CASCADE 自动清理

const express = require('express');
const { z } = require('zod');

const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// 分类名下 z 校验：非空、去首尾空白、限长、禁止换行
const nameSchema = z.object({
  name: z.string().min(1).max(50).transform(s => s.trim()),
});

// 返回某文章关联的分类列表（供 posts 路由复用）
function getPostCategories(postId) {
  return db.prepare(`
    SELECT c.id, c.name
    FROM categories c
    JOIN post_categories pc ON pc.category_id = c.id
    WHERE pc.post_id = ?
    ORDER BY c.name
  `).all(postId);
}

// —— 分类列表 ——
// GET /api/categories：返回全部分类，附每类的文章数
router.get('/', requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.created_at,
           (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS post_count
    FROM categories c
    ORDER BY c.name
  `).all();
  res.json({ items: rows });
});

// —— 新建分类 ——
// POST /api/categories
router.post('/', requireAuth, (req, res) => {
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
  // 新建分类初始文章数为 0
  res.status(201).json({ ...row, post_count: 0 });
});

// —— 重命名分类 ——
// PUT /api/categories/:id
router.put('/:id', requireAuth, (req, res) => {
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

// —— 删除分类 ——
// DELETE /api/categories/:id：关联的 post_categories 记录由外键 CASCADE 自动删除
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
module.exports.getPostCategories = getPostCategories;