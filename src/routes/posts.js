'use strict';

// —— 文章路由 ——
// 处理：文章列表、单篇查询、新建、更新、删除、预览
// 所有路由都需要登录（requireAuth）

const express = require('express');
const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');
const { z } = require('zod');

const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// 启用 GFM（GitHub Flavored Markdown）和换行转 <br>
marked.setOptions({ gfm: true, breaks: true });

// Markdown → HTML，经过 DOMPurify 消毒防止 XSS
function renderHtml(md) {
  const raw = marked.parse(md || '');
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

// 生成 URL 友好的 slug：小写、连字符分隔、去除特殊字符
function slugify(input) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || 'post-' + Date.now();
}

// 确保 slug 唯一：如果已存在则追加数字后缀（如 my-post-2）
function uniqueSlug(base, excludeId) {
  let slug = base;
  let n = 1;
  const stmt = excludeId
    ? db.prepare('SELECT 1 FROM posts WHERE slug = ? AND id != ?')
    : db.prepare('SELECT 1 FROM posts WHERE slug = ?');
  while (true) {
    const row = excludeId ? stmt.get(slug, excludeId) : stmt.get(slug);
    if (!row) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

// 数据库行 → 文章对象
// withHtml=true 时额外渲染 content_html（用于编辑器预览）
function rowToPost(row, { withHtml = false } = {}) {
  if (!row) return null;
  const post = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || '',
    content_md: row.content_md,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withHtml) post.content_html = renderHtml(row.content_md);
  return post;
}

// —— Zod 校验 Schema ——

// 新建文章：标题和内容必填
const postSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(120).optional(),
  excerpt: z.string().max(500).optional().nullable(),
  content_md: z.string().min(1).max(200_000),    // 内容上限 200KB
  status: z.enum(['draft', 'published']).optional(),
});

// 更新文章：所有字段可选（partial）
const patchSchema = postSchema.partial();

// —— 列表查询 ——
// GET /api/posts：分页查询文章，支持按状态和关键词筛选
router.get('/', requireAuth, (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = 20;

  // 动态构建 WHERE 子句（参数化，防 SQL 注入）
  const where = [];
  const params = [];
  if (status === 'draft' || status === 'published') {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(title LIKE ? OR excerpt LIKE ? OR content_md LIKE ?)');
    // 转义 LIKE 通配符（\、%、_），与公共搜索保持一致
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    params.push(like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 查询总数和分页数据
  const total = db.prepare(`SELECT COUNT(*) AS n FROM posts ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, slug, title, excerpt, status, created_at, updated_at
    FROM posts
    ${whereSql}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  res.json({
    items: rows.map(r => ({
      id: r.id, slug: r.slug, title: r.title,
      excerpt: r.excerpt || '',
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    total,
    page,
    page_size: pageSize,
  });
});

// —— Markdown 预览 ——
// POST /api/posts/preview：渲染 Markdown 为 HTML，不保存
const previewSchema = z.object({ content_md: z.string().max(200_000) });
router.post('/preview', requireAuth, (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  res.json({ content_html: renderHtml(parsed.data.content_md) });
});

// —— 查询单篇 ——
// GET /api/posts/:id：返回文章详情（含渲染后的 HTML）
router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(rowToPost(row, { withHtml: true }));
});

// —— 新建文章 ——
// POST /api/posts：创建新文章，默认状态为 draft
router.post('/', requireAuth, (req, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid' });
  }
  const { title, slug, excerpt, content_md, status } = parsed.data;
  // slug 优先使用手动指定值，否则从标题生成
  const baseSlug = slug ? slugify(slug) : slugify(title);
  const finalSlug = uniqueSlug(baseSlug);

  const info = db.prepare(`
    INSERT INTO posts (slug, title, excerpt, content_md, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(finalSlug, title, excerpt || null, content_md, status || 'draft');

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToPost(row, { withHtml: true }));
});

// —— 更新文章 ——
// PUT /api/posts/:id：部分更新，只修改提交的字段
router.put('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid' });
  }
  const patch = parsed.data;

  // 合并：提交的字段覆盖原值，未提交的保持不变
  const next = {
    title: patch.title ?? existing.title,
    excerpt: patch.excerpt !== undefined ? patch.excerpt : existing.excerpt,
    content_md: patch.content_md ?? existing.content_md,
    status: patch.status ?? existing.status,
  };
  let nextSlug = existing.slug;
  if (patch.slug !== undefined) {
    nextSlug = slugify(patch.slug);
    if (!nextSlug) return res.status(400).json({ error: 'invalid slug' });
    // slug 变更时检查唯一性
    if (nextSlug !== existing.slug) nextSlug = uniqueSlug(nextSlug, id);
  }

  db.prepare(`
    UPDATE posts
    SET title = ?, slug = ?, excerpt = ?, content_md = ?, status = ?, updated_at = datetime('now', '+8 hours')
    WHERE id = ?
  `).run(next.title, nextSlug, next.excerpt, next.content_md, next.status, id);

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json(rowToPost(row, { withHtml: true }));
});

// —— 删除文章 ——
// DELETE /api/posts/:id
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
