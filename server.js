'use strict';

// ============================================================
//  请求生命周期（一个浏览器请求从进来到回去的大致顺序）
// ============================================================
//  express 中间件按注册顺序依次执行，任何一步可终止请求：
//
//  1.  body 解析（JSON/URL编码）　→ cookieParser 把 cookie 解出来
//  2.  统一安全响应头（nosniff / CSP / X-Frame-Options 等）
//  3.  setupGuard　—— 无管理员时整个站重定向到 /setup/
//  4. /managers/* → requireAdminPage　后台页面鉴权，未登录跳 /login/
//  5.  API 路由（/api/* 下再细分）：
//        /api/*          → authRoutes   （登录 / 注册 / 用户管理）
//        /api/posts      → postsRoutes  （文章 CRUD，需登录）
//        /api/music      → musicRoutes  （公开 /active + 管理员接口）
//        /api/data       → statusRoutes （实时状态上报 / SSE / 配置）
//  6.  公开阅读页：/、/posts、/posts/:slug、/search、/status、/image、/audio
//  7.  静态资源 public/ → 兜底 404 → 全局错误处理
//
//  鉴权模型：登录成功写 httpOnly 的 `sid` cookie（HMAC 签名的 token）
//  → requireAuth 解密并查库拿到 req.user → requireAdmin 检查角色。
// ============================================================

// 加载 .env 环境变量（SESSION_SECRET、COOKIE_SECURE 等）
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./src/db');
const audit = require('./src/audit');
const authRoutes = require('./src/routes/auth');
const postsRoutes = require('./src/routes/posts');
const musicRoutes = require('./src/routes/music');
const { verify, COOKIE_NAME, optionalAuth } = require('./src/auth');

// 音乐上传目录：与 src/routes/music.js 保持一致
const MUSIC_DIR = path.join(__dirname, 'data', 'uploads', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });
// 头像目录：与 src/routes/auth.js 保持一致
const AVATAR_DIR = path.join(__dirname, 'data', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const { renderListPage, renderPostPage, renderSearchPage, renderNoticePage, renderCategoryPage } = require('./src/views/posts');
const { renderStatusPage } = require('./src/views/status-page');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// —— 首次引导守卫 ——
// 没有管理员账号时，所有请求重定向到 /setup/ 初始化页面
// 放行设置页自身、setup API 和图片资源
function setupGuard(req, res, next) {
  if (db.userCount() > 0) return next();
  if (req.path.startsWith('/setup') || req.path.startsWith('/api/setup') || req.path.startsWith('/image/')) return next();
  return res.redirect('/setup/');
}

// —— 中间件注册 ——
// JSON 请求体限制 1MB，防止恶意大 payload
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
// 解析 Cookie，供 session 验证使用
app.use(cookieParser());

// 反向代理信任层数。默认不信任任何 X-Forwarded-For（裸跑时防止客户端伪造 IP
// 绕过速率限制、污染留言属地）；前面接了 Caddy/Nginx 时再用环境变量打开
// 例：TRUST_PROXY=1 信任一层反代；TRUST_PROXY=true 完全信任
const TRUST_PROXY_RAW = process.env.TRUST_PROXY;
let trustProxy = false;
if (TRUST_PROXY_RAW === 'true') trustProxy = true;
else if (TRUST_PROXY_RAW === 'false' || TRUST_PROXY_RAW === undefined || TRUST_PROXY_RAW === '') trustProxy = false;
else if (/^\d+$/.test(TRUST_PROXY_RAW)) trustProxy = parseInt(TRUST_PROXY_RAW, 10);
else trustProxy = TRUST_PROXY_RAW;   // 其它（loopback / linklocal 等关键字）原样传给 express
app.set('trust proxy', trustProxy);

// —— 安全响应头 ——
// 所有响应统一设置安全头，防止 MIME 嗅探、点击劫持、XSS 等攻击
app.use((_req, res, next) => {
  // 禁止浏览器猜测 MIME 类型
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 禁止被嵌入 iframe（防点击劫持；CSP frame-ancestors 也会兜底）
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // 控制 Referer 信息泄露
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 禁用摄像头、麦克风、地理位置等浏览器 API
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // 显式关闭已被现代浏览器废弃的 XSS 过滤器（开着会和 CSP 互相干扰，且实现有 bug）
  res.setHeader('X-XSS-Protection', '0');
  // 内容安全策略：只允许同源资源，禁止内联脚本（脚本外置到 .js 文件后已可实施），
  // 禁止 object/embed、限定 <base>、限定表单提交目标；img 允许 data: 用于头像占位。
  // style-src 留 'unsafe-inline' 是因为各页面里有大量 <style> 块（重构到外置文件工作量过大）；
  // 但显式禁用 style-src-attr 'unsafe-inline'，杜绝 HTML style="..." 属性里的 CSS injection
  // （如 background:url(//evil/?x=...)、@import 渗出数据）——CSS injection 的主要攻击面。
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "style-src-attr 'none'; " +
    "img-src 'self' data:; " +
    "media-src 'self'; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'"
  );
  // HSTS：强制浏览器在一年内使用 HTTPS 访问
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// 首次引导守卫（放在安全头之后，路由之前）
app.use(setupGuard);

// optionalAuth：尝试解析 session，挂到 req.user；未登录则不挂
// 用于公开但需个性化的端点（/api/data 公开版按登录态决定是否暴露 username）
app.use(optionalAuth);

// —— 通用 404 HTML ——
// 与文末 catch-all 共用；后台守卫对未授权登录用户也返回这个，
// 抹掉「/managers/ 存在但被拒」与「/managers/ 不存在」的差别
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>404</title>
<link rel="stylesheet" href="/site/site.css" />
<style>
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    overflow: hidden;
  }
  .not-found {
    position: relative;
    z-index: 1;
    text-align: center;
    padding: 0 20px;
  }
  .not-found h1 {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-weight: 400;
    font-size: 56px;
    line-height: 1.2;
    margin: 0 0 24px;
  }
  .not-found p {
    color: var(--muted);
    font-size: 18px;
    margin: 0 0 32px;
  }
  .not-found a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid rgba(59, 130, 246, 0.3);
  }
  .not-found a:hover { border-bottom-color: var(--accent); }
  @media (max-width: 560px) {
    .not-found h1 { font-size: 42px; }
  }
</style>
</head>
<body>
  <div class="not-found">
    <h1>Oops! 该页面不存在</h1>
    <p>Not Found: 404...</p>
    <a href="/">← 回到首页</a>
  </div>
</body></html>`;

// —— 后台页面鉴权 ——
// /managers/* 下的所有 HTML 页面需要后台管理者（admin/moderator）登录
// 其中 /managers/users（用户与角色管理）仅全局管理员（admin）可进
// 带扩展名的静态资源（CSS/JS/图片）放行，不包含敏感内容
function requireAdminPage(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verify(token);
  if (session) {
    const row = db.prepare('SELECT role, tokens_valid_after FROM users WHERE id = ?').get(session.userId);
    if (row && session.iat >= (row.tokens_valid_after || 0) && row.role === 'admin') {
      return next();
    }
  }
  // 其他一律 404（匿名 / 普通用户 / moderator / session 无效 全抹掉入口）
  // 静态资源扩展名也不再放行，避免匿名直接拉 /managers/*.css 摸后台结构
  return res.status(404).type('html').send(NOT_FOUND_HTML);
}
app.use('/managers/', requireAdminPage);

// —— 个人主页页面鉴权 ——
// /me/* 任何已登录用户（含普通用户 user）可访问，未登录跳 /login/
// 与 requireAdminPage 一致：放行明确的静态资源扩展名，避免静态 JS/CSS 被守卫挡
function requireLoginPage(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verify(token);
  if (session) {
    const row = db.prepare('SELECT 1, tokens_valid_after FROM users WHERE id = ?').get(session.userId);
    if (row && session.iat >= (row.tokens_valid_after || 0)) return next();
  }
  if (/\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(req.path)) return next();
  return res.redirect('/login/');
}
app.use('/me/', requireLoginPage);

// —— 健康检查端点（Docker HEALTHCHECK 使用） ——
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// —— API 路由挂载 ——
app.use('/api', authRoutes);            // 登录、注册、用户管理
app.use('/api/posts', postsRoutes);     // 文章 CRUD
app.use('/api/music', musicRoutes);     // 音乐管理（公开的 /active + 管理接口）
app.use('/api/data', require('./src/routes/status'));  // 实时状态上报与查询
app.use('/api/stats', require('./src/routes/stats'));    // 访问统计
app.use('/api/categories', require('./src/routes/categories'));  // 分类管理（列表/新建/重命名/删除）
app.use('/api/messages', require('./src/routes/messages'));  // 留言板

// —— 公开文章页（无需登录） ——

// 给一组文章行附加分类 [{id,name}]，返回带 categories 的新数组
// 用一次 IN 查询拉回，避免 N+1
function withCategories(rows) {
  if (!rows || rows.length === 0) return rows || [];
  const ids = rows.map(r => r.id);
  const maps = db.prepare(`
    SELECT pc.post_id, c.id, c.name
    FROM post_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.post_id IN (${ids.map(() => '?').join(',')})
    ORDER BY c.name
  `).all(...ids);
  const map = new Map();
  for (const m of maps) {
    if (!map.has(m.post_id)) map.set(m.post_id, []);
    map.get(m.post_id).push({ id: m.id, name: m.name });
  }
  return rows.map(r => ({ ...r, categories: map.get(r.id) || [] }));
}

// 全站已发布文章总数：按文章（行）计数，跨分类不重复
function countPublishedPosts() {
  return db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'published'`).get().n;
}

// 列出全部分类（含暂无已发布文章的分类），附已发布文章数
function getPublicCategories() {
  return db.prepare(`
    SELECT c.id, c.name,
      (SELECT COUNT(*)
       FROM post_categories pc JOIN posts p ON p.id = pc.post_id
       WHERE pc.category_id = c.id AND p.status = 'published') AS post_count
    FROM categories c
    ORDER BY c.name
  `).all();
}

// 文章列表页：只展示已发布文章，按更新时间倒序
app.get(['/posts', '/posts/'], (_req, res) => {
  const rows = db.prepare(`
    SELECT id, slug, title, excerpt, updated_at, created_at
    FROM posts
    WHERE status = 'published'
    ORDER BY COALESCE(updated_at, created_at) DESC
  `).all();
  const posts = withCategories(rows).map(r => ({ ...r, published_at: r.updated_at }));
  res.type('html').send(renderListPage(posts, { categories: getPublicCategories(), totalPosts: countPublishedPosts() }));
});

// 分类归档页：某分类下的已发布文章，含分类筛选条
app.get(['/category/:id', '/category/:id/'], (req, res) => {
  const id = parseInt(req.params.id, 10);
  const category = Number.isInteger(id)
    ? db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id)
    : null;
  if (!category) return res.status(404).type('html').send(NOT_FOUND_HTML);
  const rows = db.prepare(`
    SELECT id, slug, title, excerpt, updated_at, created_at
    FROM posts
    WHERE status = 'published'
      AND id IN (SELECT post_id FROM post_categories WHERE category_id = ?)
    ORDER BY COALESCE(updated_at, created_at) DESC
  `).all(id);
  const posts = withCategories(rows).map(r => ({ ...r, published_at: r.updated_at }));
  res.type('html').send(renderCategoryPage(category, posts, getPublicCategories(), countPublishedPosts()));
});

// 文章详情页：通过 slug 查找已发布文章，不存在返回 404
app.get(['/posts/:slug', '/posts/:slug/'], (req, res) => {
  const slug = req.params.slug;
  const row = db.prepare(`
    SELECT id, slug, title, excerpt, content_md, created_at, updated_at
    FROM posts
    WHERE slug = ? AND status = 'published'
  `).get(slug);
  if (!row) return res.status(404).type('html').send(NOT_FOUND_HTML);
  const post = withCategories([row])[0];
  res.type('html').send(renderPostPage({ ...post, published_at: post.updated_at }));
});

// —— 搜索页（无需登录，仅搜已发布文章）——
// 全文 LIKE 是整表扫描，需要限流防止被恶意刷请求

// 搜索窗口：30 秒内
const SEARCH_WINDOW_MS = 30 * 1000;

// 标准化搜索词：合并空白、去首尾空格、截断到 60 字符
function normalizeQuery(raw) {
  return (typeof raw === 'string' ? raw : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// 搜索过于频繁时的提示页
function tooManySearches(res, message) {
  return res.status(429).type('html').send(renderNoticePage({
    title: '搜索太频繁',
    heading: '茶需慢慢摇，心急则味散',
    message,
    link: '/posts/',
    linkText: '← 所有文章',
  }));
}

// 搜索限流：30 秒内最多 10 次，空查询不计数
const searchLimiter = rateLimit({
  windowMs: SEARCH_WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => !normalizeQuery(req.query.q),
  handler: (_req, res) => tooManySearches(res, '搜索请求太频繁了，请稍等三十秒再试。'),
});

// 重复搜索拦截：同一 IP 在窗口内搜相同关键词直接返回提示
// 防止用户反复刷新浪费数据库查询
// 硬上限 10000：超过后按插入顺序淘汰最旧的 25%，避免恶意刷搜索把内存撑爆
const lastSearch = new Map();
const LAST_SEARCH_MAX = 10000;

function sweepLastSearch() {
  const now = Date.now();
  for (const [ip, entry] of lastSearch) {
    if (now - entry.at > SEARCH_WINDOW_MS) lastSearch.delete(ip);
  }
  if (lastSearch.size > LAST_SEARCH_MAX) {
    const drop = Math.max(1, Math.floor(lastSearch.size * 0.25));
    let i = 0;
    for (const k of lastSearch.keys()) {
      if (i >= drop) break;
      lastSearch.delete(k);
      i += 1;
    }
  }
}

function repeatSearchGuard(req, res, next) {
  const q = normalizeQuery(req.query.q);
  req.searchQuery = q;
  if (!q) return next();

  // 同步路径：>500 时也走同一份清理逻辑，保持和异步 sweep 一致
  if (lastSearch.size > 500) sweepLastSearch();

  const now = Date.now();
  const prev = lastSearch.get(req.ip);
  if (prev && prev.q === q && now - prev.at < SEARCH_WINDOW_MS) {
    return tooManySearches(res, '刚刚搜过同样的关键词了，换个词或者等三十秒再试。');
  }
  lastSearch.set(req.ip, { q, at: now });
  next();
}

// 定期清理过期的 lastSearch 条目（默认每 60 秒一次），不再每次搜索都遍历
const lastSearchSweep = setInterval(sweepLastSearch, 60_000);
lastSearchSweep.unref();   // 不阻塞进程退出

// 定期清理过期未验证的 pending 用户（验证链接 15 分钟有效，过期即视为放弃）
// 释放被锁住的 username / email，避免「没收到邮件 → 账号卡住无法重新注册」
const PENDING_SWEEP_INTERVAL_MS = 60_000;
function sweepExpiredPending() {
  try {
    const deleted = db.sweepExpiredPendingUsers();
    if (deleted.length === 0) return;
    for (const u of deleted) {
      // targetId=null：写审计时用户已删，FK 会失败；detail 里带 username/email 足够追溯
      audit.log({ actorId: null, targetId: null, action: 'user.expired', detail: { username: u.username, email: u.email } });
    }
    console.log(`[cleanup] removed ${deleted.length} expired pending user(s)`);
  } catch (e) {
    console.warn('pending user sweep failed:', e.message);
  }
}
const pendingSweep = setInterval(sweepExpiredPending, PENDING_SWEEP_INTERVAL_MS);
pendingSweep.unref();   // 不阻塞进程退出
// 启动时立即跑一次，处理上次进程残留的过期 pending
sweepExpiredPending();

// 搜索路由：限流 → 去重 → 查询 → 渲染
app.get(['/search', '/search/'], searchLimiter, repeatSearchGuard, (req, res) => {
  const q = req.searchQuery;

  let rows = [];
  if (q) {
    // 转义 LIKE 通配符（\、%、_），防止注入
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    rows = db.prepare(`
      SELECT id, slug, title, excerpt, updated_at, created_at
      FROM posts
      WHERE status = 'published'
        AND (title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR content_md LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 50
    `).all(like, like, like);
  }
  const results = withCategories(rows).map(r => ({ ...r, published_at: r.updated_at }));
  res.type('html').send(renderSearchPage(q, results));
});

// —— 实时状态页（无需登录） ——
app.get(['/status', '/status/'], (_req, res) => {
  res.type('html').send(renderStatusPage());
});

// —— 文章 / 分类 / 兜底统一用 NOT_FOUND_HTML（见上方） ——

// —— 静态文件托管 ——
// public/ 目录包含 login、setup、managers、me、register 等页面
app.use(express.static(path.join(__dirname, 'public')));

// 根级资源：首页、图片、音频（显式列出，避免暴露 data/、node_modules/）
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/image', express.static(path.join(__dirname, 'image')));
// 音频从 data/uploads/music 提供（与管理上传目录一致）
app.use('/audio', express.static(MUSIC_DIR));
// 头像从 data/uploads/avatars 提供（与上传目录一致）
app.use('/avatar', express.static(AVATAR_DIR));
// 个人主页 / 开放注册页 / SMTP 单独入口（仅管理员可达）
app.use('/me', express.static(path.join(__dirname, 'public', 'me')));
app.use('/register', express.static(path.join(__dirname, 'public', 'register')));
app.use('/board', express.static(path.join(__dirname, 'public', 'board')));
app.use('/managers/smtp', express.static(path.join(__dirname, 'public', 'managers', 'smtp')));

// —— 兜底 404（所有路由未匹配时） ——
app.use((_req, res) => {
  res.status(404).type('html').send(NOT_FOUND_HTML);
});

// —— 全局错误处理 ——
// 开发环境输出完整错误对象（含堆栈），生产环境只输出消息
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  } else {
    console.error(err.message || err);
  }
  res.status(err.status || 500).json({ error: 'internal error' });
});

// 启动 HTTP 服务
app.listen(PORT, () => {
  console.log(`blog server listening on http://localhost:${PORT}`);
});
