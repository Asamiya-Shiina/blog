'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./src/db');
const authRoutes = require('./src/routes/auth');
const postsRoutes = require('./src/routes/posts');
const { verify, COOKIE_NAME } = require('./src/auth');
const { renderListPage, renderPostPage, renderSearchPage, renderNoticePage } = require('./src/views/posts');
const { renderStatusPage } = require('./src/views/status-page');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// 首次引导：没有管理员时跳转到设置页
function setupGuard(req, res, next) {
  if (db.userCount() > 0) return next();
  // 放行设置页自身、setup API、静态资源
  if (req.path.startsWith('/setup') || req.path.startsWith('/api/setup') || req.path.startsWith('/image/')) return next();
  return res.redirect('/setup/');
}

// 解析 JSON / urlencoded body
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// 反向代理信任（部署到 Nginx/Caddy 等后面时）
app.set('trust proxy', 1);

// 安全响应头
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// 首次引导：没有管理员时跳转到设置页
app.use(setupGuard);

// 后台 HTML 页面：未登录直接访问 /managers/* 时重定向到登录页
// 静态资源（带扩展名的 CSS/JS/图片）放行（不带敏感内容）
function requireAdminPage(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (verify(token)) return next();
  // 仅放行明确的静态资源扩展名，避免 /managers/secret.txt 等绕过认证
  if (/\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(req.path)) return next();
  return res.redirect('/login/');
}
app.use('/managers/', requireAdminPage);

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 鉴权 / 文章 / 文件路由
app.use('/api', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/status', require('./src/routes/status'));

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

// —— 搜索页（无需登录，仅搜已发布文章）——
// 全文 LIKE 是整表扫描，限流避免被刷
const SEARCH_WINDOW_MS = 30 * 1000;

function normalizeQuery(raw) {
  return (typeof raw === 'string' ? raw : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function tooManySearches(res, message) {
  return res.status(429).type('html').send(renderNoticePage({
    title: '搜索太频繁',
    heading: '茶需慢慢摇，心急则味散',
    message,
    link: '/posts/',
    linkText: '← 所有文章',
  }));
}

const searchLimiter = rateLimit({
  windowMs: SEARCH_WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // 空查询不查库，不占额度
  skip: req => !normalizeQuery(req.query.q),
  handler: (_req, res) => tooManySearches(res, '搜索请求太频繁了，请稍等三十秒再试。'),
});

// 同一个关键词在窗口内重复搜索没有新结果，直接拦下
const lastSearch = new Map();

function repeatSearchGuard(req, res, next) {
  const q = normalizeQuery(req.query.q);
  req.searchQuery = q;
  if (!q) return next();

  const now = Date.now();
  if (lastSearch.size > 500) {
    for (const [ip, entry] of lastSearch) {
      if (now - entry.at > SEARCH_WINDOW_MS) lastSearch.delete(ip);
    }
  }

  const prev = lastSearch.get(req.ip);
  if (prev && prev.q === q && now - prev.at < SEARCH_WINDOW_MS) {
    return tooManySearches(res, '刚刚搜过同样的关键词了，换个词或者等三十秒再试。');
  }
  lastSearch.set(req.ip, { q, at: now });
  next();
}

app.get(['/search', '/search/'], searchLimiter, repeatSearchGuard, (req, res) => {
  const q = req.searchQuery;

  let rows = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    rows = db.prepare(`
      SELECT slug, title, excerpt, updated_at, created_at
      FROM posts
      WHERE status = 'published'
        AND (title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR content_md LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 50
    `).all(like, like, like);
  }
  res.type('html').send(renderSearchPage(q, rows.map(r => ({ ...r, published_at: r.updated_at }))));
});

// —— 实时状态页（无需登录） ——
app.get(['/status', '/status/'], (_req, res) => {
  res.type('html').send(renderStatusPage());
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
  <p>找不到文章 <code>${String(slug).replace(/[<>&"']/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[ch]))}</code></p>
  <a href="/posts/">← 所有文章</a>
</div></body></html>`;
}

// 静态托管：admin / login 等后台页面
app.use(express.static(path.join(__dirname, 'public')));

// 根级静态资源（显式列出，避免暴露 data/、node_modules/ 等目录）
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// 全局错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`blog server listening on http://localhost:${PORT}`);
});
