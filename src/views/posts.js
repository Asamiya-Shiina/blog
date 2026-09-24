'use strict';

// —— 文章页面视图模块 ——
// 服务端渲染 HTML：文章列表、文章详情、搜索页、提示页
// 所有用户输入通过 escapeHtml 转义，Markdown 通过 DOMPurify 消毒

const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');

// GFM（表格、任务列表等）+ 换行转 <br>
marked.setOptions({ gfm: true, breaks: true });

// HTML 实体转义：防止 XSS（用于非 Markdown 的用户输入，如标题、摘要）
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
const SHARED_HEAD = `
  <link rel="stylesheet" href="/site/site.css" />
  <style>
    /* 文章列表 / 详情 的页面专属样式（共享部分在 /site/site.css） */

    .back-row { margin-bottom: 32px; }

    /* —— 列表页 —— */
    header.hero { margin-bottom: 56px; animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both; }
    header.hero h1 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 40px;
      line-height: 1.2;
      letter-spacing: -0.5px;
      margin: 0 0 14px;
    }
    header.hero p {
      color: var(--muted);
      margin: 0;
      max-width: 32em;
      animation: fadeUp 0.9s 0.15s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .post-card {
      padding: 22px 0;
      border-bottom: 1px solid var(--line);
      animation: fadeUp 0.7s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .post-card:nth-child(1) { animation-delay: 0.2s; }
    .post-card:nth-child(2) { animation-delay: 0.3s; }
    .post-card:nth-child(3) { animation-delay: 0.4s; }
    .post-card:nth-child(4) { animation-delay: 0.5s; }
    .post-card:nth-child(5) { animation-delay: 0.6s; }
    .post-card h2 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 22px;
      margin: 0 0 6px;
    }
    .post-card h2 a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s ease;
    }
    .post-card h2 a:hover { border-bottom-color: var(--fg); }
    .post-card .meta {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
      font-variant-numeric: tabular-nums;
    }
    .post-card p { color: var(--muted); margin: 0; }

    /* —— 分类标签（卡片 / 详情页内） —— */
    .post-cats { margin-left: 10px; }
    .cat-tag {
      display: inline-block;
      padding: 2px 10px;
      margin-right: 6px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--muted);
      background: rgba(0,0,0,0.04);
      border: 1px solid var(--line);
      border-radius: 999px;
      text-decoration: none;
      transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
    }
    .cat-tag:hover { color: var(--fg); border-color: var(--accent); }

    /* —— 文章列表：左文章 + 右分类侧栏 —— */
    .posts-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 200px;
      gap: 44px;
      align-items: start;
    }
    .posts-main { min-width: 0; }
    .cat-side {
      position: sticky;
      top: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 0 0 18px;
      border-left: 1px solid var(--line);
      animation: fadeUp 0.9s 0.1s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .cat-side h3 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 13px;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin: 0 0 10px;
    }
    .cat-side-link {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      font-size: 14px;
      color: var(--fg);
      border-radius: 8px;
      text-decoration: none;
      transition: background 0.2s ease, color 0.2s ease;
    }
    .cat-side-link:hover { background: rgba(0,0,0,0.04); }
    .cat-side-link.is-active {
      color: var(--accent);
      background: rgba(59,130,246,0.1);
      font-weight: 600;
    }
    .cat-count {
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
        @media (max-width: 560px) {
      .posts-layout {
        grid-template-columns: 1fr;
        gap: 18px;
      }
      .cat-side {
        position: static;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 8px;
        padding: 0;
        border-left: none;
        margin-bottom: 10px;
      }
      .cat-side h3 { width: 100%; margin-bottom: 2px; }
      .cat-side-link {
        padding: 5px 12px;
        font-size: 13px;
        border: 1px solid var(--line);
        border-radius: 999px;
      }
      .cat-side-link:hover { background: rgba(0,0,0,0.04); border-color: var(--accent); }
      .cat-side-link.is-active { border-color: var(--accent); }
    }
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 60px 20px;
      animation: fadeUp 0.7s 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .empty a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(59,130,246,0.3); }

    /* —— 文章详情页 —— */
    .post-head { margin-bottom: 32px; animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both; }
    .post-head .title-row { display: flex; align-items: baseline; gap: 14px; }
    .post-head h1 {
      /* 花体（楷体）中文字体并倾斜 */
      font-family: "STXinwei", "华文新魏", "FZXingKai-S05", "STKaiti", "华文楷体", serif;
      font-style: italic;
      font-weight: 400;
      font-size: 44px;
      line-height: 1.35;
      letter-spacing: 0;
      margin: 0;
    }
    .post-head .excerpt {
      color: var(--muted);
      font-family: "STXinwei", "华文新魏", "FZXingKai-S05", "STKaiti", "华文楷体", serif;
      font-style: italic;
      font-size: 18px;
      margin: 0 0 2px; /* 基线对齐略偏低，形成偏右下 */
      padding: 0;
      white-space: nowrap;
    }
    .post-head .excerpt::before {
      /* 两个破折号，拉开展宽避免显得短 */
      content: '————';
      letter-spacing: 0.08em;
      margin-right: 0.4em;
    }
    .post-head .meta {
      color: var(--muted);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      margin-top: 14px;
    }
    .post-content {
      font-size: 17px;
      line-height: 1.75;
      animation: fadeUp 0.9s 0.15s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .post-content h1, .post-content h2, .post-content h3, .post-content h4 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      margin: 1.4em 0 0.6em;
    }
    .post-content h1 { font-size: 28px; }
    .post-content h2 { font-size: 22px; }
    .post-content h3 { font-size: 18px; }
    .post-content p { margin: 0 0 1em; }
    .post-content a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(59,130,246,0.3);
    }
    .post-content a:hover { border-bottom-color: var(--accent); }
    .post-content img { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 1em auto; }
    .post-content code {
      background: rgba(0,0,0,0.06);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
    }
    .post-content pre {
      background: rgba(0,0,0,0.05);
      padding: 14px 16px;
      border-radius: 8px;
      overflow-x: auto;
      line-height: 1.5;
    }
    .post-content pre code { background: transparent; padding: 0; }
    .post-content blockquote {
      margin: 1em 0;
      padding: 0 1em;
      border-left: 3px solid var(--line);
      color: var(--muted);
    }
    .post-content ul, .post-content ol { padding-left: 1.5em; }
    .post-content hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
    .post-foot {
      margin-top: 56px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      animation: fadeUp 0.9s 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }

    @media (max-width: 560px) {
      header.hero h1 { font-size: 32px; }
      .post-head h1   { font-size: 28px; }
      .post-card h2   { font-size: 20px; }
    }
  </style>
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
    <a href="/#about">关于</a>
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
function categorySidebar(categories = [], activeId = null) {
  if (!categories || categories.length === 0) return '';
  const total = categories.reduce((sum, c) => sum + (c.post_count || 0), 0);
  const all = `<a class="cat-side-link${activeId === null ? ' is-active' : ''}" href="/posts/">全部<span class="cat-count">${total}</span></a>`;
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
      ${categorySidebar(categories, activeCategory)}
    </div>
  </main>
  ${renderSearchButton()}
  ${renderFloatingUI()}
</body>
</html>`;
}

// 渲染分类归档页：某分类下的已发布文章，含分类侧栏与空态提示
function renderCategoryPage(category, posts, categories) {
  const name = category ? category.name : '分类';
  return renderListPage(posts, {
    title: name,
    heading: name,
    subheading: `属于「${name}」分类的文章。`,
    categories,
    activeCategory: category ? category.id : null,
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
  <style>
    /* 首次打开搜索页保留入场动画；带查询词（已搜索过）时关掉，结果直接出现 */
    body.searched header.hero,
    body.searched header.hero p,
    body.searched .search-form,
    body.searched .post-card,
    body.searched .empty,
    body.searched .player { animation: none; }

    .search-form {
      display: flex;
      gap: 10px;
      margin-bottom: 40px;
      animation: fadeUp 0.9s 0.15s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .search-form input {
      flex: 1;
      padding: 12px 16px;
      font: inherit;
      font-size: 15px;
      color: var(--fg);
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--line);
      border-radius: 12px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .search-form input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
    .search-form button {
      padding: 12px 24px;
      font: inherit;
      font-size: 15px;
      color: #fff;
      background: var(--accent);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.15s ease;
    }
    .search-form button:hover { background: var(--accent-dark); }
    .search-form button:active { transform: scale(0.97); }
  </style>
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
  <style>
    .notice {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 32px;
      animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .notice h1 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 36px;
      margin: 0 0 12px;
    }
    .notice p { color: var(--muted); margin: 0 0 28px; max-width: 24em; }
    .notice a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(59, 130, 246, 0.3);
      transition: border-color 0.2s ease;
    }
    .notice a:hover { border-bottom-color: var(--accent); }
  </style>
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
