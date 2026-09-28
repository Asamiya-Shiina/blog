'use strict';

// 文章页面视图模块
// 服务端渲染 HTML：文章列表、文章详情、搜索页、提示页
// 所有非 Markdown 的用户输入通过 escapeHtml 转义，Markdown 通过 DOMPurify 消毒

const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');

// 启用 GFM（表格、任务列表等）+ 换行转 <br>
marked.setOptions({ gfm: true, breaks: true });

// HTML 实体转义：用于非 Markdown 的用户输入（如标题、摘要），防止 XSS
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// 格式化日期：ISO 格式 → YYYY-MM-DD HH:mm
function formatDate(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}

// 共享 <head> 内容：CSS 变量、页面专属样式
// 页面级样式见 /site/site-pages.css
const SHARED_HEAD = `
  <link rel="stylesheet" href="/site/site.css" />
  <link rel="stylesheet" href="/site/site-pages.css" />
`;

// 共享的浮动 UI 组件：导航菜单、登录按钮、音乐播放器
// 公开页面显示登录按钮（withLogin），后台页面不显示
function renderFloatingUI({ withLogin = false } = {}) {
  return `
  <!-- 左上菜单 -->
  <button class="nav-toggle" id="nav-toggle" aria-label="菜单" aria-expanded="false">
    <span class="nav-toggle-bars" aria-hidden="true">
      <span class="nav-toggle-bar"></span>
      <span class="nav-toggle-bar"></span>
      <span class="nav-toggle-bar"></span>
    </span>
  </button>
  <nav class="nav-menu" id="nav-menu" aria-label="导航">
    <a href="/">首页</a>
    <a href="/search/">搜索</a>
    <a href="/status/">状态</a>
    <a href="/board/">留言</a>
  </nav>

  ${withLogin ? `<a href="/login/" class="login-btn">登录</a>` : ''}

  <!-- 播放器 -->
  <div class="player" id="player">
    <div class="player-cover">
      <img src="/image/IMG_20250703_100031.jpeg" alt="封面" draggable="false" />
    </div>
    <div class="player-info">
      <div class="player-title">歌曲名</div>
      <div class="player-progress"><div class="player-progress-fill"></div></div>
    </div>
    <button class="player-btn" id="player-btn" aria-label="播放或暂停">
      <svg class="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      <svg class="icon-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
    </button>
    <audio id="audio" preload="metadata" loop></audio>
  </div>
  <script src="/site/site.js"></script>
  `;
}

// 搜索按钮（浮动在页面右下角）
function renderSearchButton() {
  return `
  <a href="/search/" class="search-btn" aria-label="搜索文章">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
  </a>`;
}

// 分类标签片段：可点击跳转到对应分类归档页；无分类则返回空串
function categoryTags(list = []) {
  if (!list || list.length === 0) return '';
  return '<span class="post-cats">' +
    list.map(c => `<a class="cat-tag" href="/category/${c.id}/">${escapeHtml(c.name)}</a>`).join('') +
    '</span>';
}

// 分类侧栏：渲染「全部 / 各分类」的竖排导航，activeId 高亮当前分类
// 所有分类都展示（含暂无文章的分类）；每个分类附文章总数，空分类计数为 0。
// 桌面端为右侧独立侧栏，窄屏由 CSS 折成横排标签条（见 SHARED_HEAD）。
// totalPosts：全站去重后的已发布文章总数（按文章计数，跨分类不重复）
function categorySidebar(categories = [], activeId = null, totalPosts = 0) {
  if (!categories || categories.length === 0) return '';
  const all = `<a class="cat-side-link${activeId === null ? ' is-active' : ''}" href="/posts/">全部<span class="cat-count">${totalPosts}</span></a>`;
  const items = categories.map(c =>
    `<a class="cat-side-link${activeId === c.id ? ' is-active' : ''}" href="/category/${c.id}/">${escapeHtml(c.name)}<span class="cat-count">${c.post_count || 0}</span></a>`
  ).join('');
  return `<aside class="cat-side"><h3>分类</h3>${all}${items}</aside>`;
}

// 单篇文章卡片（列表页 / 搜索页 / 分类页共用），meta 旁带分类标签
function renderCard(p) {
  return `
        <article class="post-card">
          <h2><a href="/posts/${encodeURIComponent(p.slug)}/">${escapeHtml(p.title)}</a></h2>
          <div class="meta">${escapeHtml(formatDate(p.published_at || p.updated_at))}${categoryTags(p.categories)}</div>
          ${p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''}
        </article>`;
}

// 渲染文章列表页：卡片式布局，带入场动画
// opts: { title, heading, subheading, categories, activeCategory, emptyText }
function renderListPage(posts, opts = {}) {
  const {
    title = '文章', heading, subheading,
    categories = [], activeCategory = null,
    totalPosts = 0,
    emptyText = '还没有发布的文章。',
  } = opts;
  const cards = posts.length === 0
    ? `<div class="empty">${escapeHtml(emptyText)}</div>`
    : posts.map(renderCard).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  ${SHARED_HEAD}
</head>
<body>
  <main class="wrap wide">
    <header class="hero">
      <h1>${escapeHtml(heading || '文章')}</h1>
      <p>${escapeHtml(subheading || '这里收录了我写过的所有已发布文章。')}</p>
    </header>
    <div class="posts-layout">
      <section class="posts-main">${cards}</section>
      ${categorySidebar(categories, activeCategory, totalPosts)}
    </div>
  </main>
  ${renderSearchButton()}
  ${renderFloatingUI()}
</body>
</html>`;
}

// 渲染分类归档页：某分类下的已发布文章，含分类侧栏与空态提示
function renderCategoryPage(category, posts, categories, totalPosts = 0) {
  const name = category ? category.name : '分类';
  return renderListPage(posts, {
    title: name,
    heading: name,
    subheading: `属于「${name}」分类的文章。`,
    categories,
    activeCategory: category ? category.id : null,
    totalPosts,
    emptyText: '当前还没有文章。',
  });
}

// 渲染文章详情页：标题、日期、摘要、Markdown 正文
function renderPostPage(post) {
  const html = DOMPurify.sanitize(marked.parse(post.content_md || ''), { USE_PROFILES: { html: true } });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(post.title)}</title>
  <meta name="description" content="${escapeHtml(post.excerpt || post.title)}" />
  ${SHARED_HEAD}
</head>
<body>
  <main class="wrap wide">
    <article>
      <header class="post-head">
        <div class="title-row">
          <h1>${escapeHtml(post.title)}</h1>
          ${post.excerpt ? `<p class="excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
        </div>
        <div class="meta">${escapeHtml(formatDate(post.published_at || post.updated_at))}${categoryTags(post.categories)}</div>
      </header>
      <div class="post-content">${html}</div>
    </article>
  </main>
  ${renderFloatingUI()}
</body>
</html>`;
}

// 渲染搜索页：搜索框 + 结果列表
// 带查询词时禁用入场动画（class="searched"），结果直接显示
function renderSearchPage(q, posts) {
  const query = String(q || '');
  let body;
  if (!query) {
    body = `<div class="empty">输入关键词，搜索标题、摘要与正文。</div>`;
  } else if (posts.length === 0) {
    body = `<div class="empty">没有找到匹配 “${escapeHtml(query)}” 的文章。<br /><a href="/posts/">← 浏览全部文章</a></div>`;
  } else {
    body = posts.map(renderCard).join('');
  }

  const count = query ? `<p>共找到 ${posts.length} 篇文章。</p>` : `<p>在已发布的文章中查找。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>搜索${query ? ' · ' + escapeHtml(query) : ''}</title>
  <meta name="robots" content="noindex" />
  ${SHARED_HEAD}
</head>
<body${query ? ' class="searched"' : ''}>
  <main class="wrap">
    <header class="hero">
      <h1>搜索</h1>
      ${count}
    </header>
    <form class="search-form" action="/search/" method="get" role="search">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="搜索标题、摘要或正文…" autofocus required />
      <button type="submit">搜索</button>
    </form>
    <section>${body}</section>
  </main>
  ${renderFloatingUI()}
</body>
</html>`;
}

// 渲染提示页（限流、错误等）：居中显示标题和消息
function renderNoticePage({ title, heading, message, link = '/posts/', linkText = '← 所有文章' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/site/site.css" />
  <link rel="stylesheet" href="/site/site-pages.css" />
</head>
<body>
  <div class="notice">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="${link}">${escapeHtml(linkText)}</a>
  </div>
</body>
</html>`;
}

module.exports = { renderListPage, renderPostPage, renderSearchPage, renderNoticePage, renderCategoryPage, renderFloatingUI, SHARED_HEAD };