'use strict';

/**
 * 公开状态页（/status）客户端脚本
 *
 * 通过 EventSource 与 /api/data/stream 建立 SSE 长连接，接收服务端广播的
 * 当前活跃设备列表，实时渲染到页面。每台设备显示：图标、应用名、窗口标题、
 * 设备名（多设备支持）、最后更新时间。
 *
 * 与首页的实时状态卡（site.js 内嵌）逻辑一致，只是这里展示更详细。
 */

(() => {
  // DOM 引用：状态点、状态文字、内容容器
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const content = document.getElementById('status-content');

  /**
   * 应用名 → emoji 图标映射
   * key 来自桌面客户端上报的 processName（小写化），由 src/db.js 的默认 appNames 决定
   * 匹配不到的应用会回落到默认图标（💻）
   */
  const appIcons = {
    'code': '📝',
    'chrome': '🌐',
    'firefox': '🐧',
    'msedge': '🌐',
    'idea64': '⚙️',
    'obsidian': '📚',
    'figma': '🎨',
    'typora': '✍️',
    'notion': '📓',
    'spotify': '🎵',
    'discord': '💬',
    'windowsterminal': '⌨️',
    'explorer': '📂',
  };

  /** 查找 emoji 图标，未匹配返回默认电脑图标 */
  function getIcon(key) { return appIcons[key] || '💻'; }

  /** HTML 实体转义，防止应用名/窗口标题里的特殊字符破坏 DOM */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  /** 时间戳 → YYYY-MM-DD HH:mm:ss（本地时区） */
  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * 渲染整页状态
   * @param {{ devices: Array<{id, app, title, icon, updatedAt}> }} data
   *   devices 来自 src/status-store.js getPublicStatus()，按更新时间倒序
   */
  function render(data) {
    let devices = data && data.devices ? data.devices : [];

    // 休息中（break）优先级最低：统一排到列表末尾，不打断其他状态的展示
    const breaks = devices.filter(d => d.icon === 'break');
    const others = devices.filter(d => d.icon !== 'break');
    devices = others.concat(breaks);

    // 无活跃设备 → 显示"离线"
    if (devices.length === 0) {
      dot.classList.remove('online');
      label.textContent = '离线';
      content.innerHTML = '<div class="status-offline-msg">当前没有在使用任何应用。</div>';
      return;
    }

    dot.classList.add('online');
    label.textContent = `在线 (${devices.length} 台设备)`;

    let html = '';
    for (const device of devices) {
      // 休息状态（客户端检测到 5 分钟无输入）：只显示一个咖啡杯图标
      if (device.icon === 'break') {
        html += `
          <div class="status-display">
            <div class="status-icon-wrap active">☕</div>
            <div class="status-info">
              <div class="status-app-name">${escapeHtml(device.app)}</div>
            </div>
          </div>
          <div class="status-time">最后更新: ${formatTime(device.updatedAt)}</div>`;
        continue;
      }

      const icon = getIcon(device.icon);
      const titleHtml = device.title
        ? `<div class="status-window-title" title="${escapeHtml(device.title)}">${escapeHtml(device.title)}</div>`
        : '';
      // device.id 格式是 `${username}_${deviceName}`，下划线后是设备名（如 "PC"、"笔电"）
      const deviceNameHtml = device.id ? `<div class="status-device-name">${escapeHtml(device.id.split('_')[1] || '')}</div>` : '';
      html += `
        <div class="status-display">
          <div class="status-icon-wrap active">${icon}</div>
          <div class="status-info">
            <div class="status-app-name">${escapeHtml(device.app)}</div>
            ${titleHtml}
            ${deviceNameHtml}
          </div>
        </div>
        <div class="status-time">最后更新: ${formatTime(device.updatedAt)}</div>`;
    }

    content.innerHTML = html;
  }

  /** SSE 连接句柄，断线重连时先关旧的 */
  let evtSource = null;

  /**
   * 建立 SSE 连接
   *
   * - onmessage：服务端推送新状态时重渲染整页
   * - onerror：连接断开 → 标为离线 → 5 秒后重连（防抖）
   */
  function connect() {
    evtSource = new EventSource('/api/data/stream');
    evtSource.onmessage = (e) => {
      try { render(JSON.parse(e.data)); } catch {}
    };
    evtSource.onerror = () => {
      evtSource.close();
      dot.classList.remove('online');
      label.textContent = '重新连接中...';
      setTimeout(connect, 5000);
    };
  }
  connect();
})();
