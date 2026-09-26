'use strict';

// 后台分类管理脚本

(() => {
  const { api, escapeHtml } = window.admin;
  const rowsEl = document.getElementById('rows');
  const nameEl = document.getElementById('name');
  const noticeEl = document.getElementById('notice');

  function showNotice(type, msg) {
    noticeEl.className = 'notice ' + type + ' is-visible';
    noticeEl.textContent = msg;
  }

  function render(list) {
    rowsEl.innerHTML = list.map(c => `
      <tr class="row">
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="muted-sm">${c.post_count ?? 0}</td>
        <td class="muted-sm">${(c.created_at || '').replace('T', ' ').slice(0, 16)}</td>
        <td class="t-right">
          <button class="btn btn-ghost" data-act="rename" data-id="${c.id}" data-name="${escapeHtml(c.name)}">重命名</button>
          <button class="btn btn-danger" data-act="del" data-id="${c.id}" data-name="${escapeHtml(c.name)}">删除</button>
        </td>
      </tr>
    `).join('');
    rowsEl.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const oldName = btn.dataset.name;
        if (btn.dataset.act === 'rename') {
          const next = prompt('新的分类名：', oldName);
          if (next === null) return;
          try {
            await api('PUT', '/api/categories/' + id, { name: next.trim() });
            showNotice('success', '✓ 已重命名');
            load();
          } catch (err) {
            showNotice('error', '重命名失败：' + (err.data?.error || err.message));
          }
        } else {
          if (!confirm(`确定删除分类「${oldName}」？文章不会被删除，只会移除该分类。`)) return;
          try {
            await api('DELETE', '/api/categories/' + id);
            showNotice('success', '✓ 已删除');
            load();
          } catch (err) {
            showNotice('error', '删除失败：' + err.message);
          }
        }
      });
    });
  }

  async function load() {
    rowsEl.innerHTML = '<tr><td colspan="4" class="empty">加载中…</td></tr>';
    try {
      const data = await api('GET', '/api/categories');
      if (!data.items || !data.items.length) {
        rowsEl.innerHTML = '<tr><td colspan="4" class="empty">还没有分类。在左上输入框添加一个 →</td></tr>';
      } else {
        render(data.items);
      }
    } catch (err) {
      rowsEl.innerHTML = '<tr><td colspan="4" class="empty">加载失败：' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  document.getElementById('add').addEventListener('click', async () => {
    const name = nameEl.value.trim();
    if (!name) { showNotice('error', '请输入分类名'); return; }
    try {
      await api('POST', '/api/categories', { name });
      nameEl.value = '';
      showNotice('success', '✓ 已新增分类');
      load();
    } catch (err) {
      showNotice('error', '新增失败：' + (err.data?.error || err.message));
    }
  });
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('add').click(); });

  load();
})();
