'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./src/db');
const authRoutes = require('./src/routes/auth');
const postsRoutes = require('./src/routes/posts');
const { verify, COOKIE_NAME } = require('./src/auth');
const { renderListPage, renderPostPage } = require('./src/views/posts');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// 解析 JSON / urlencoded body
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// 反向代理信任（部署到 Nginx/Caddy 等后面时）
app.set('trust proxy', 1);

// 后台 HTML 页面：未登录直接访问 /Asamiya/* 时重定向到登录页
// 静态资源（带扩展名的 CSS/JS/图片）放行（不带敏感内容）
function requireAdminPage(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (verify(token)) return next();
  if (/\.[a-z0-9]+$/i.test(req.path)) return next();   // 静态资源
  return res.redirect('/login/');                       // HTML 页面 / 目录
}
app.use('/Asamiya/', requireAdminPage);

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 鉴权 / 文章 / 文件路由
app.use('/api', authRoutes);
app.use('/api/posts', postsRoutes);

// —— 公开文章页（无需登录） ——
app.get(['/posts', '/posts/'], (_req, res) => {
  const rows = db.prepare(`
    SELECT slug, title, excerpt, updated_at, created_at
    FROM posts
    WHERE status = 'published'
    ORDER BY COALESCE(updated_at, created_at) DESC
  `).all();
  // 用 updated_at 当发布日期；若有需要以后加 published_at 字段
  res.type('html').send(renderListPage(rows.map(r => ({ ...r, published_at: r.updated_at }))));
});

app.get(['/posts/:slug', '/posts/:slug/'], (req, res) => {
  const slug = req.params.slug;
  const post = db.prepare(`
    SELECT slug, title, excerpt, content_md, created_at, updated_at
    FROM posts
    WHERE slug = ? AND status = 'published'
  `).get(slug);
  if (!post) return res.status(404).type('html').send(notFoundPage(slug));
  res.type('html').send(renderPostPage({ ...post, published_at: post.updated_at }));
});

function notFoundPage(slug) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>未找到文章</title>
<style>
  html,body{margin:0;padding:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#1a1a1a;background:url('/image/IMG_20250703_100031.jpeg') center/cover no-repeat fixed}
  body::before{content:'';position:fixed;inset:0;background:rgba(255,255,255,0.5);backdrop-filter:blur(8px);z-index:-1}
  .box{text-align:center;padding:32px}
  h1{font-family:Georgia,serif;font-weight:400;margin:0 0 12px}
  p{color:#6b6b6b;margin:0 0 24px}
  a{color:#3b82f6;text-decoration:none;border-bottom:1px solid rgba(59,130,246,0.3)}
  a:hover{border-bottom-color:#3b82f6}
</style></head>
<body><div class="box">
  <h1>404</h1>
  <p>找不到文章 <code>${String(slug).replace(/[<>&"]/g, '')}</code></p>
  <a href="/posts/">← 所有文章</a>
</div></body></html>`;
}

// 静态托管：admin / login 等后台页面（路径里直接挂 public/）
app.use(express.static(path.join(__dirname, 'public')));

// 首页、image/、audio/ 直接挂在根
app.use(express.static(__dirname, { index: 'index.html' }));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// 全局错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, () => {
  console.log(`blog server listening on http://localhost:${PORT}`);
});
