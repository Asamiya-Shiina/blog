'use strict';

// 实时状态页面视图（/status，公开页面）
// 客户端逻辑见 public/site/status-client.js。

const { SHARED_HEAD, renderFloatingUI } = require('./posts');

// 状态页 HTML 骨架。
// - #status-dot / #status-label 由 status-client.js 在 SSE 连上/断开时切换样式与文案
// - #status-content 是设备列表容器,首次连接时由客户端渲染,后续 SSE 推送做增量更新
// - noindex:该页无 SEO 价值(每几秒就变),避免被搜索引擎抓到旧快照
function renderStatusPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>状态</title>
  <meta name="robots" content="noindex" />
  ${SHARED_HEAD}
</head>
<body>
  <main class="wrap narrow">
    <header class="status-hero">
      <h1>实时状态</h1>
      <p>欢迎来视奸我，谢谢喵</p>
    </header>

    <div class="status-panel">
      <div class="status-indicator">
        <span class="status-dot" id="status-dot"></span>
        <span class="status-label" id="status-label">正在连接...</span>
      </div>
      <div id="status-content">
        <div class="status-offline-msg">加载中...</div>
      </div>
    </div>
  </main>
  ${renderFloatingUI()}
  <script src="/site/status-client.js"></script>
</body>
</html>`;
}

module.exports = { renderStatusPage };
