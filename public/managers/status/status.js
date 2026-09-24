'use strict';

// 后台状态管理脚本：实时状态展示 + 黑名单/映射等配置

(async () => {
  const { api, escapeHtml, bindNav } = window.admin;
  let user;
  try { user = await window.admin.guard(); } catch { return; }
  bindNav(user);

  let config = {};

  function showNotice(msg, type = 'info') {
    const el = document.getElementById('notice');
    el.textContent = msg;
    el.className = 'notice is-visible ' + type;
    setTimeout(() => el.classList.remove('is-visible'), 3000);
  }

  async function loadStatus() {
    try {
      const data = await api('GET', '/api/data');
      const el = document.getElementById('current-status');
      const devices = data && data.devices ? data.devices : [];
      if (devices.length === 0) {
        el.innerHTML = '<p><em>离线</em></p>';
      } else {
        el.innerHTML = devices.map(d => `
          <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line)">
            <p><strong>在线</strong> - ${escapeHtml(d.app)}</p>
            ${d.title ? '<p>' + escapeHtml(d.title) + '</p>' : ''}
            <p class="help">设备: ${escapeHtml(d.id)} · 最后更新: ${new Date(d.updatedAt).toLocaleString()}</p>
          </div>
        `).join('');
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function loadConfig() {
    try {
      config = await api('GET', '/api/data/admin/config');
      renderConfig();
    } catch (e) {
      console.error(e);
    }
  }

  async function saveConfig() {
    try {
      await api('POST', '/api/data/admin/config', config);
      showNotice('配置已保存', 'success');
    } catch (e) {
      showNotice('保存失败', 'error');
    }
  }

  function renderConfig() {
    const bl = document.getElementById('blacklist-list');
    bl.innerHTML = (config.blacklist || []).map(item => `
      <span class="tag">${escapeHtml(item)} <span class="tag-remove" data-action="removeBlacklist" data-value="${escapeHtml(item)}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';

    const patterns = document.getElementById('patterns-list');
    patterns.innerHTML = (config.blacklistPatterns || []).map(item => `
      <span class="tag"><code>${escapeHtml(item)}</code> <span class="tag-remove" data-action="removePattern" data-value="${escapeHtml(item)}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';

    const mappings = document.getElementById('mapping-list');
    mappings.innerHTML = Object.entries(config.appNames || {}).map(([k, v]) => `
      <span class="tag">${escapeHtml(k)} → ${escapeHtml(v)} <span class="tag-remove" data-action="removeMapping" data-key="${escapeHtml(k)}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';

    const appPatterns = document.getElementById('app-patterns-list');
    appPatterns.innerHTML = (config.appNamePatterns || []).map((item, i) => `
      <span class="tag"><code>${escapeHtml(item.pattern)}</code> → ${escapeHtml(item.name)} <span class="tag-remove" data-action="removeAppPattern" data-index="${i}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';

    const titleApps = document.getElementById('title-apps-list');
    titleApps.innerHTML = (config.titleApps || []).map(item => `
      <span class="tag">${escapeHtml(item)} <span class="tag-remove" data-action="removeTitleApp" data-value="${escapeHtml(item)}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';

    const titleAppPatterns = document.getElementById('title-app-patterns-list');
    titleAppPatterns.innerHTML = (config.titleAppPatterns || []).map((item, i) => `
      <span class="tag"><code>${escapeHtml(item.pattern)}</code> <span class="tag-remove" data-action="removeTitleAppPattern" data-index="${i}">×</span></span>
    `).join('') || '<span class="help">暂无</span>';
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tag-remove');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'removeBlacklist') {
      config.blacklist = (config.blacklist || []).filter(b => b !== btn.dataset.value);
      await saveConfig();
    } else if (action === 'removePattern') {
      config.blacklistPatterns = (config.blacklistPatterns || []).filter(p => p !== btn.dataset.value);
      await saveConfig();
    } else if (action === 'removeMapping') {
      delete config.appNames[btn.dataset.key];
      await saveConfig();
    } else if (action === 'removeAppPattern') {
      const idx = parseInt(btn.dataset.index, 10);
      config.appNamePatterns = (config.appNamePatterns || []).filter((_, i) => i !== idx);
      await saveConfig();
    } else if (action === 'removeTitleApp') {
      config.titleApps = (config.titleApps || []).filter(p => p !== btn.dataset.value);
      await saveConfig();
    } else if (action === 'removeTitleAppPattern') {
      const idx = parseInt(btn.dataset.index, 10);
      config.titleAppPatterns = (config.titleAppPatterns || []).filter((_, i) => i !== idx);
      await saveConfig();
    }
  });

  document.getElementById('blacklist-input').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const input = document.getElementById('blacklist-input');
    const item = input.value.trim();
    if (!item) return;
    if (!config.blacklist) config.blacklist = [];
    if (!config.blacklist.includes(item)) {
      config.blacklist.push(item);
      await saveConfig();
    }
    input.value = '';
  });

  document.getElementById('pattern-input').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const input = document.getElementById('pattern-input');
    const item = input.value.trim();
    if (!item) return;
    if (!config.blacklistPatterns) config.blacklistPatterns = [];
    if (!config.blacklistPatterns.includes(item)) {
      config.blacklistPatterns.push(item);
      await saveConfig();
    }
    input.value = '';
  });

  document.getElementById('mapping-key').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const key = document.getElementById('mapping-key').value.trim();
    const value = document.getElementById('mapping-value').value.trim();
    if (!key || !value) return;
    if (!config.appNames) config.appNames = {};
    config.appNames[key] = value;
    await saveConfig();
    document.getElementById('mapping-key').value = '';
    document.getElementById('mapping-value').value = '';
  });

  document.getElementById('app-pattern-regex').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const regex = document.getElementById('app-pattern-regex').value.trim();
    const name = document.getElementById('app-pattern-name').value.trim();
    if (!regex || !name) return;
    try { new RegExp(regex); } catch (e) { showNotice('正则语法错误: ' + e.message, 'error'); return; }
    if (!config.appNamePatterns) config.appNamePatterns = [];
    config.appNamePatterns.push({ pattern: regex, name });
    await saveConfig();
    document.getElementById('app-pattern-regex').value = '';
    document.getElementById('app-pattern-name').value = '';
  });

  document.getElementById('title-app-input').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const input = document.getElementById('title-app-input');
    const item = input.value.trim();
    if (!item) return;
    if (!config.titleApps) config.titleApps = [];
    if (!config.titleApps.includes(item)) {
      config.titleApps.push(item);
      await saveConfig();
    }
    input.value = '';
  });

  document.getElementById('title-app-pattern-input').closest('.toolbar').querySelector('button').addEventListener('click', async () => {
    const input = document.getElementById('title-app-pattern-input');
    const regex = input.value.trim();
    if (!regex) return;
    try { new RegExp(regex); } catch (e) { showNotice('正则语法错误: ' + e.message, 'error'); return; }
    if (!config.titleAppPatterns) config.titleAppPatterns = [];
    config.titleAppPatterns.push({ pattern: regex });
    await saveConfig();
    input.value = '';
  });

  await Promise.all([loadStatus(), loadConfig()]);
  setInterval(loadStatus, 5000);
})();
