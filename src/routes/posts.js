'use strict';

// 文章路由（全部 requireManager）

const express = require('express');
const { z } = require('zod');

const db = require('../db');
const { requireManager } = require('../auth');
const { sanitizeMarkdown } = require('../views/posts');
const { getPostCategories } = require('./categories');

const router = express.Router();

// Markdown 渲染统一走 src/views/posts.js 的 sanitizeMarkdown()
// 该函数是全站唯一的消毒入口，避免两处配置分叉（历史上公开文章页曾漏掉
// FORBID_ATTR:['style']，导致同一篇文章在 API 与网页上渲染结果不一致）
function renderHtml(md) {
  return sanitizeMarkdown(md);
}

// 生成 URL 友好的 slug。
// 规则链:
//   1) 全小写(URL 不区分大小写,但保留原始大小写会让搜索引擎抓两遍)
//   2) 空白 / 下划线 → 连字符(允许中文标题直接转拼音或保留为单字)
//   3) 仅保留 Unicode 字母数字 + 连字符(\p{Letter} 含中文,保证中文标题可工作)
//   4) 合并连续连字符、去首尾连字符
//   5) 截断到 80 字符(slug 长度合理上限,URL 美观)
// 空结果(纯符号标题)回落 'post-' + 时间戳,保证唯一性同时给个能点击的 URL。
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

// 确保 slug 唯一:若已存在则追加数字后缀(my-post → my-post-2 → my-post-3)。
// excludeId 用于排除当前正在编辑的文章自身(避免与「自己」的 slug 撞)。
// 循环而非一次性取 max:并发场景下其它请求可能在你 SELECT 与 INSERT 之间
// 抢先一步占号,while + 重新检查是天然的乐观锁。
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

// 整体替换某文章的分类关联(传入空数组可清空分类)。
// 用 DELETE + INSERT 而非「diff 更新」:文章分类数量通常 < 10,
// 全删全插的固定成本与 diff 相当,逻辑简单不易出 bug。
// 去重(传入重复 ID 会撞 post_categories 复合主键):前端表单可能因用户多次点选
// 提交重复,这里用 Set 在入库前去重一次。
function setPostCategories(postId, categoryIds) {
  db.prepare('DELETE FROM post_categories WHERE post_id = ?').run(postId);
  const ins = db.prepare('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)');
  for (const id of [...new Set(categoryIds || [])]) ins.run(postId, id);
}

// 返回请求中不存在的分类 ID。
// 预校验原因:把可预见的外键错误挡在事务外,返回精确 400 而不是让 SQLite
// 抛错变 500。注意这只是乐观检查 —— 分类在校验与写入之间被并发删除的情况
// 仍可能命中,事务层有 isFkError 兜底返回 400(见下方 POST/PUT 路由)。
function missingCategoryIds(categoryIds) {
  const ids = [...new Set(categoryIds || [])];
  if (ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT id FROM categories WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const have = new Set(rows.map(r => r.id));
  return ids.filter(id => !have.has(id));
}

// SQLite 外键约束错误（预校验后仍可能命中：分类在校验与写入之间被并发删除）
function isFkError(e) {
  return !!e && e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
}

// 分类参数预校验：存在性 + 统一 400 响应
function checkCategoryIds(res, categoryIds) {
  if (categoryIds === undefined) return true;
  const missing = missingCategoryIds(categoryIds);
  if (missing.length) {
    res.status(400).json({ error: 'invalid category_ids', missing });
    return false;
  }
  return true;
}

// 一次性查询多篇文章的分类映射:{ postId: [{id,name}, ...] }
// 通过单次 IN 查询拉回所有 post 的分类,避免列表接口的 N+1 查询。
// 排序在 SQL 层做 c.name,前端无需再排序。
// 返回 Map 而非数组:调用方按 postId 取值,O(1) 复杂度。
function categoriesForPosts(postIds) {
  const ids = [...new Set(postIds.filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT pc.post_id, c.id, c.name
    FROM post_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.post_id IN (${ids.map(() => '?').join(',')})
    ORDER BY c.name
  `).all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.post_id)) map.set(r.post_id, []);
    map.get(r.post_id).push({ id: r.id, name: r.name });
  }
  return map;
}

// 将数据库行映射为对外暴露的文章对象。
// withHtml=true 时额外渲染 content_html(供编辑器预览使用);
// 列表接口默认不渲染,避免 marked + DOMPurify 在列表中跑一遍产生无用开销。
// categories 走 getPostCategories(单文章)而非 categoriesForPosts(批量):
// 单文章详情接口的访问频率远低于列表,N+1 成本可接受。
function rowToPost(row, { withHtml = false } = {}) {
  if (!row) return null;
  const post = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || '',
    content_md: row.content_md,
    status: row.status,
    categories: getPostCategories(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withHtml) post.content_html = renderHtml(row.content_md);
  return post;
}

// Zod 校验 Schema

// 新建文章：标题与内容必填
const postSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(120).optional(),
  excerpt: z.string().max(500).optional().nullable(),
  content_md: z.string().min(1).max(200_000),    // 内容上限 200KB
  status: z.enum(['draft', 'published']).optional(),
  category_ids: z.array(z.number().int().positive()).optional(),
});

// 更新文章：所有字段均可选（partial）
const patchSchema = postSchema.partial();

// 列表查询
// GET /api/posts：分页查询文章，支持按状态与关键词筛选
router.get('/', requireManager, (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category_id = parseInt(req.query.category_id, 10);
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = 20;

  // 动态构建 WHERE 子句（参数化，防止 SQL 注入）
  const where = [];
  const params = [];
  if (status === 'draft' || status === 'published') {
    where.push('status = ?');
    params.push(status);
  }
  if (Number.isInteger(category_id)) {
    where.push('EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = posts.id AND pc.category_id = ?)');
    params.push(category_id);
  }
  if (q) {
    where.push('(title LIKE ? OR excerpt LIKE ? OR content_md LIKE ?)');
    // 转义 LIKE 通配符（\、%、_），与公共搜索实现保持一致
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    params.push(like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 查询总数与分页数据
  const total = db.prepare(`SELECT COUNT(*) AS n FROM posts ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, slug, title, excerpt, status, created_at, updated_at
    FROM posts
    ${whereSql}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  // 一次性查询本页所有文章的分类，按 post_id 聚合成映射
  const catMap = categoriesForPosts(rows.map(r => r.id));

  res.json({
    items: rows.map(r => ({
      id: r.id, slug: r.slug, title: r.title,
      excerpt: r.excerpt || '',
      status: r.status,
      categories: catMap.get(r.id) || [],
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    total,
    page,
    page_size: pageSize,
  });
});

// Markdown 预览
// POST /api/posts/preview：渲染 Markdown 为 HTML，不持久化
const previewSchema = z.object({ content_md: z.string().max(200_000) });
router.post('/preview', requireManager, (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
  res.json({ content_html: renderHtml(parsed.data.content_md) });
});

// 查询单篇
// GET /api/posts/:id：返回文章详情（含渲染后的 HTML）
router.get('/:id', requireManager, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(rowToPost(row, { withHtml: true }));
});

// 新建文章
// POST /api/posts：创建新文章，默认状态为 draft
router.post('/', requireManager, (req, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid' });
  }
  const { title, slug, excerpt, content_md, status, category_ids } = parsed.data;
  if (!checkCategoryIds(res, category_ids)) return;
  // slug 优先使用手动指定值，否则从标题生成
  const baseSlug = slug ? slugify(slug) : slugify(title);
  const finalSlug = uniqueSlug(baseSlug);

  // 事务：文章 INSERT + 分类关联必须原子——任何一步失败整体回滚，
  // 不留无分类的幽灵文章（失败时客户端收到 4xx，库中也不能有半截数据）
  let newId;
  try {
    newId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO posts (slug, title, excerpt, content_md, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(finalSlug, title, excerpt || null, content_md, status || 'draft');
      setPostCategories(info.lastInsertRowid, category_ids);
      return Number(info.lastInsertRowid);
    })();
  } catch (e) {
    if (isFkError(e)) return res.status(400).json({ error: 'invalid category_ids' });
    throw e;
  }

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(newId);
  res.status(201).json(rowToPost(row, { withHtml: true }));
});

// 更新文章
// PUT /api/posts/:id：部分更新，仅修改提交的字段
router.put('/:id', requireManager, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid' });
  }
  const patch = parsed.data;

  // 合并字段：提交的字段覆盖原值，未提交的保持不变
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
    // slug 发生变化时检查唯一性
    if (nextSlug !== existing.slug) nextSlug = uniqueSlug(nextSlug, id);
  }
  // 分类预校验放在任何写入之前：坏 ID 时正文/分类都不该动
  if (!checkCategoryIds(res, patch.category_ids)) return;

  // 事务：UPDATE + 分类替换原子提交——避免“正文已保存、分类被清空”的半提交中间态
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE posts
        SET title = ?, slug = ?, excerpt = ?, content_md = ?, status = ?, updated_at = datetime('now', '+8 hours')
        WHERE id = ?
      `).run(next.title, nextSlug, next.excerpt, next.content_md, next.status, id);

      // 分类：提交了 category_ids 才进行替换，未提交则保持原状
      if (patch.category_ids !== undefined) setPostCategories(id, patch.category_ids);
    })();
  } catch (e) {
    if (isFkError(e)) return res.status(400).json({ error: 'invalid category_ids' });
    throw e;
  }

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json(rowToPost(row, { withHtml: true }));
});

// 删除文章
// DELETE /api/posts/:id
router.delete('/:id', requireManager, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
