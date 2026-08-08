'use strict';

const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatDate(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}

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
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 60px 20px;
      animation: fadeUp 0.7s 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }
    .empty a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(59,130,246,0.3); }

    /* —— 文章详情页 —— */
    .post-head { margin-bottom: 40px; animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both; }
    .post-head h1 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 36px;
      line-height: 1.25;
      letter-spacing: -0.5px;
      margin: 0 0 12px;
    }
    .post-head .meta {
      color: var(--muted);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    .post-head .excerpt {
      color: var(--muted);
      font-size: 16px;
      margin: 20px 0 0;
      padding-left: 14px;
      border-left: 2px solid var(--line);
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

// 共享的浮动 UI：左上菜单、右上登录（公开页不带登录）、左下播放器
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
    <a href="/#about">关于</a>
  </nav>

  ${withLogin ? `<a href="/login/" class="login-btn">登录</a>` : ''}

  <!-- 播放器 -->
  <div class="player" id="player">
    <div class="player-cover">
      <img src="/image/IMG_20250703_100031.jpeg" alt="封面" />
    </div>
    <div class="player-info">
      <div class="player-title">歌曲名</div>
      <div class="player-progress"><div class="player-progress-fill"></div></div>
    </div>
    <button class="player-btn" id="player-btn" aria-label="播放或暂停">
      <svg class="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      <svg class="icon-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
    </button>
    <audio id="audio" src="/audio/song.mp3" preload="metadata" loop></audio>
  </div>
  <script src="/site/site.js"></script>
  `;
}

function renderListPage(posts) {
  const cards = posts.length === 0
    ? `<div class="empty">还没有发布的文章。</div>`
    : posts.map(p => `
        <article class="post-card">
          <h2><a href="/posts/${encodeURIComponent(p.slug)}/">${escapeHtml(p.title)}</a></h2>
          <div class="meta">${escapeHtml(formatDate(p.published_at || p.updated_at))}</div>
          ${p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''}
        </article>
      `).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>文章</title>
  ${SHARED_HEAD}
</head>
<body>
  <main class="wrap">
    <header class="hero">
      <h1>文章</h1>
      <p>这里收录了我写过的所有已发布文章。</p>
    </header>
    <section>${cards}</section>
  </main>
  ${renderFloatingUI()}
</body>
</html>`;
}

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
        <h1>${escapeHtml(post.title)}</h1>
        <div class="meta">${escapeHtml(formatDate(post.published_at || post.updated_at))}</div>
        ${post.excerpt ? `<p class="excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
      </header>
      <div class="post-content">${html}</div>
    </article>
  </main>
  ${renderFloatingUI()}
</body>
</html>`;
}

module.exports = { renderListPage, renderPostPage };
