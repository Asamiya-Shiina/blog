'use strict';

// 后台文章列表脚本：分页、筛选、删除

(() => {
  const { api, escapeHtml } = window.admin;
  const rowsEl   = document.getElementById('rows');
  const qEl      = document.getElementById('q');
  const statusEl   = document.getElementById('status');
  const categoryEl = document.getElementById('category');
  const prevBtn    = document.getElementById('prev');
  const nextBtn    = document.getElementById('next');
  const pageInfo   = document.getElementById('page-info');

  let page = 1;

  (async () => {
    try {
      const data = await api('GET', '/api/categories');
      const opts = (data.items || []).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
      categoryEl.insertAdjacentHTML('beforeend', opts);
    } catch {}
  })();

  async function load() {
    const params = new URLSearchParams({ page });
    const q = qEl.value.trim();
    if (q) params.set('q', q);
    const st = statusEl.value;
    if (st) params.set('status', st);
    const cat = categoryEl.value;
    if (cat) params.set('category_id', cat);

    rowsEl.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
    try {
      const data = await api('GET', '/api/posts?' + params);
      if (!data.items.length) {
        rowsEl.innerHTML = '<tr><td colspan="5" class="empty">没有文章。<a href="/managers/editor">写一篇 →</a></td></tr>';
      } else {
        rowsEl.innerHTML = data.items.map(p => `
          <tr class="row" onclick="window.location.href='/managers/editor?id=${p.id}'">
            <td><strong>${escapeHtml(p.title)}</strong>${p.excerpt ? `<div style="color:var(--muted);font-size:12px;margin-top:2px">${escapeHtml(p.excerpt)}</div>` : ''}</td>
            <td><span class="tag ${p.status === 'published' ? 'tag-published' : 'tag-draft'}">${p.status === 'published' ? '已发布' : '草稿'}</span></td>
            <td>${(p.categories || []).map(c => `<span class="tag">${escapeHtml(c.name)}</span>`).join(' ') || '<span style="color:var(--muted);font-size:12px">—</span>'}</td>
            <td style="color:var(--muted);font-size:13px">${(p.updated_at || '').replace('T', ' ').slice(0, 16)}</td>
            <td style="text-align:right">
              <button class="btn btn-ghost" onclick="event.stopPropagation(); window.location.href='/managers/editor?id=${p.id}'">编辑</button>
              <button class="btn btn-danger" data-id="${p.id}" data-title="${escapeHtml(p.title)}">删除</button>
            </td>
          </tr>
        `).join('');
        rowsEl.querySelectorAll('.btn-danger').forEach(b => {
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = b.dataset.id;
            const title = b.dataset.title;
            if (!confirm(`确定删除《${title}》？此操作不可恢复。`)) return;
            try {
              await api('DELETE', '/api/posts/' + id);
              load();
            } catch (err) {
              alert('删除失败：' + err.message);
            }
          });
        });
      }
      const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
      pageInfo.textContent = `第 ${page} / ${totalPages} 页 · 共 ${data.total} 篇`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= totalPages;
    } catch (err) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="empty">加载失败：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  document.getElementById('search-btn').addEventListener('click', () => { page = 1; load(); });
  qEl.addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; load(); } });
  statusEl.addEventListener('change', () => { page = 1; load(); });
  categoryEl.addEventListener('change', () => { page = 1; load(); });
  prevBtn.addEventListener('click', () => { page--; load(); });
  nextBtn.addEventListener('click', () => { page++; load(); });

  load();
})();
