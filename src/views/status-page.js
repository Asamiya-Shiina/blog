'use strict';

// —— 实时状态页面视图 ——
// 公开页面，通过 SSE 接收状态更新，显示当前活跃设备信息

const { SHARED_HEAD, renderFloatingUI } = require('./posts');

// 渲染状态页：SSE 客户端通过 /site/status-client.js 接收实时更新
function renderStatusPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>状态</title>
  <meta name="robots" content="noindex" />
  ${SHARED_HEAD}
  <style>
    .status-hero { animation: fadeUp 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both; }
    .status-hero h1 {
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 400;
      font-size: 40px;
      line-height: 1.2;
      margin: 0 0 14px;
    }
    .status-hero p { color: var(--muted); margin: 0; }

    .status-panel {
      margin-top: 40px;
      padding: 32px;
      background: rgba(255, 255, 255, 0.72);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 20px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08);
      animation: fadeUp 0.9s 0.15s cubic-bezier(0.22, 0.61, 0.36, 1) both;
    }

    .status-display {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .status-icon-wrap {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.04);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 28px;
      transition: background 0.3s ease;
    }
    .status-icon-wrap.active {
      background: rgba(59, 130, 246, 0.1);
    }

    .status-info { flex: 1; min-width: 0; }

    .status-app-name {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .status-window-title {
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-device-name {
      color: var(--accent);
      font-size: 12px;
      margin-top: 4px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 24px;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ccc;
      transition: background 0.3s ease;
    }
    .status-dot.online {
      background: #22c55e;
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 4px rgba(34, 197, 94, 0.3); }
      50%      { box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); }
    }

    .status-label { font-size: 14px; color: var(--muted); }

    .status-time {
      color: var(--muted);
      font-size: 12px;
      margin-top: 16px;
      font-variant-numeric: tabular-nums;
    }

    .status-offline-msg {
      text-align: center;
      color: var(--muted);
      padding: 20px 0;
    }

    @media (max-width: 560px) {
      .status-panel { padding: 24px 20px; }
      .status-icon-wrap { width: 52px; height: 52px; font-size: 24px; }
      .status-app-name { font-size: 18px; }
    }
  </style>
</head>
<body>
  <main class="wrap narrow">
    <header class="status-hero">
      <h1>实时状态</h1>
      <p>欢迎来视奸我,谢谢喵</p>
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
