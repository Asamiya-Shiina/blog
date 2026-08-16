'use strict';

const express = require('express');
const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');
const { z } = require('zod');

const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

marked.setOptions({ gfm: true, breaks: true });

function renderHtml(md) {
  const raw = marked.parse(md || '');
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

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

const postSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(120).optional(),
  excerpt: z.string().max(500).optional().nullable(),
  content_md: z.string().min(1).max(200_000),
  status: z.enum(['draft', 'published']).optional(),
});

const patchSchema = postSchema.partial();

// —— 列表 ——
router.get('/', requireAuth, (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = 20;

  const where = [];
  const params = [];
  if (status === 'draft' || status === 'published') {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(title LIKE ? OR excerpt LIKE ? OR content_md LIKE ?)');
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    params.push(like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

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

// —— 预览（不存）——
const previewSchema = z.object({ content_md: z.string().max(200_000) });
router.post('/preview', requireAuth, (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  res.json({ content_html: renderHtml(parsed.data.content_md) });
});

// —— 单篇 ——
router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(rowToPost(row, { withHtml: true }));
});

// —— 新建 ——
router.post('/', requireAuth, (req, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid' });
  }
  const { title, slug, excerpt, content_md, status } = parsed.data;
  const baseSlug = slug ? slugify(slug) : slugify(title);
  const finalSlug = uniqueSlug(baseSlug);

  const info = db.prepare(`
    INSERT INTO posts (slug, title, excerpt, content_md, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(finalSlug, title, excerpt || null, content_md, status || 'draft');

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToPost(row, { withHtml: true }));
});

// —— 更新 ——
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

// —— 删除 ——
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
