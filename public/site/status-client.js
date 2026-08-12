'use strict';

(() => {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const content = document.getElementById('status-content');

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

  function getIcon(key) { return appIcons[key] || '💻'; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function render(data) {
    // data 现在是 { devices: [...] } 格式
    const devices = data && data.devices ? data.devices : [];

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
      // 休息状态特殊显示
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

  let evtSource = null;
  function connect() {
    evtSource = new EventSource('/api/status/stream');
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
