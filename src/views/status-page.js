'use strict';

/**
 * 实时状态页面视图（/status）
 *
 * 公开页面（无需登录），通过 SSE 接收 /api/data/stream 的状态更新，
 * 显示当前活跃设备信息。每台设备显示：图标、应用名、窗口标题、设备名。
 *
 * 客户端逻辑见 public/site/status-client.js。
 */

const { SHARED_HEAD, renderFloatingUI } = require('./posts');

/**
 * 渲染状态页 HTML
 *
 * @returns {string} 完整的 HTML 文档字符串
 */
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
