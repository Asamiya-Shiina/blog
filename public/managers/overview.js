'use strict';

// 后台首页脚本：拉取已发布/草稿数量，并展示最近更新的文章

(async () => {
  const { api } = window.admin;
  try {
    const [pub, draft] = await Promise.all([
      api('GET', '/api/posts?status=published&page=1').catch(() => ({ total: 0, items: [] })),
      api('GET', '/api/posts?status=draft&page=1').catch(() => ({ total: 0, items: [] })),
    ]);
    document.getElementById('stat-published').textContent = pub.total;
    document.getElementById('stat-draft').textContent     = draft.total;

    const recent = [...pub.items, ...draft.items]
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 6);
    const wrap = document.getElementById('recent');
    if (recent.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有文章。<a href="/managers/editor">写一篇 →</a></div>';
    } else {
      wrap.innerHTML = recent.map(p => `
        <div class="row-item" data-id="${p.id}">
          <span class="tag ${p.status === 'published' ? 'tag-published' : 'tag-draft'}">${p.status === 'published' ? '已发布' : '草稿'}</span>
          <span class="title">${window.admin.escapeHtml(p.title)}</span>
          <span class="row-meta">${(p.updated_at || '').replace('T', ' ').slice(0, 16)}</span>
        </div>
      `).join('');
    }
    // 行可点跳转编辑器（不能用内联 onclick，违反 CSP style-src-attr / 内联事件限制）
    wrap.addEventListener('click', (e) => {
      const row = e.target.closest('.row-item');
      if (row) window.location.href = '/managers/editor?id=' + row.dataset.id;
    });
  } catch (e) {
    console.error(e);
  }
})();
