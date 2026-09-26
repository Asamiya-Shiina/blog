'use strict';

// 后台文章编辑器脚本

(() => {
  const { api, escapeHtml } = window.admin;
  const $ = (id) => document.getElementById(id);
  const titleEl    = $('title');
  const slugEl     = $('slug');
  const statusEl   = $('status');
  const excerptEl  = $('excerpt');
  const contentEl  = $('content_md');
  const previewEl  = $('preview');
  const noticeEl   = $('notice');
  const saveBtn    = $('save');
  const pubBtn     = $('publish');
  const delBtn     = $('delete');
  const catsEl    = $('cats');
  const newCatEl  = $('new-cat');
  const addCatBtn = $('add-cat');

  let categoryIds = new Set();

  function renderCats(list, selectedSet = new Set()) {
    if (!list.length) {
      catsEl.innerHTML = '<span class="muted-sm">还没有分类，可在下方新增一个。</span>';
      return;
    }
    catsEl.innerHTML = list.map(c => `
      <label class="cat-chip">
        <input type="checkbox" data-cat-id="${c.id}" ${selectedSet.has(c.id) ? 'checked' : ''} />
        ${escapeHtml(c.name)}
      </label>
    `).join('');
  }

  async function loadCategories() {
    try {
      const data = await api('GET', '/api/categories');
      renderCats(data.items || [], categoryIds);
    } catch { catsEl.innerHTML = '<span class="danger-sm">分类加载失败</span>'; }
  }

  addCatBtn.addEventListener('click', async () => {
    const name = newCatEl.value.trim();
    if (!name) { showNotice('error', '请输入分类名'); return; }
    try {
      const created = await api('POST', '/api/categories', { name });
      categoryIds.add(created.id);
      await loadCategories();
      newCatEl.value = '';
      showNotice('success', '✓ 已新增分类');
    } catch (err) {
      showNotice('error', '新增分类失败：' + (err.data?.error || err.message));
    }
  });
  newCatEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCatBtn.click(); } });

  const postId = new URLSearchParams(location.search).get('id');
  let slugDirty = !!slugEl.value;

  function showNotice(type, msg) {
    noticeEl.className = 'notice ' + type + ' is-visible';
    noticeEl.textContent = msg;
  }
  function hideNotice() { noticeEl.className = 'notice'; }

  function slugify(input) {
    return String(input || '')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{Letter}\p{Number}\-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  }

  titleEl.addEventListener('input', () => {
    if (!slugDirty || !slugEl.value) {
      slugEl.value = slugify(titleEl.value);
      slugDirty = false;
    }
  });
  slugEl.addEventListener('input', () => { slugDirty = true; });

  let previewTimer = null;
  async function refreshPreview() {
    const md = contentEl.value;
    try {
      const { content_html } = await api('POST', '/api/posts/preview', { content_md: md });
      previewEl.innerHTML = content_html || '<div class="muted-tx">（空内容）</div>';
    } catch {
      previewEl.innerHTML = '<div class="danger-tx">预览失败</div>';
    }
  }
  contentEl.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 300);
  });

  async function save(status) {
    const title = titleEl.value.trim();
    const content_md = contentEl.value;
    const slug = slugEl.value.trim();
    const excerpt = excerptEl.value.trim() || null;
    if (!title)    { showNotice('error', '标题不能为空'); return; }
    if (!content_md) { showNotice('error', '正文不能为空'); return; }
    if (status === 'published' && !confirm('确定发布这篇文章吗？')) return;
    statusEl.value = status;
    hideNotice();
    saveBtn.disabled = pubBtn.disabled = true;
    try {
      const payload = { title, content_md, status };
      if (slug) payload.slug = slug;
      if (excerpt) payload.excerpt = excerpt;
      payload.category_ids = Array.from(catsEl.querySelectorAll('input[type=checkbox]:checked'))
        .map(cb => parseInt(cb.dataset.catId, 10))
        .filter(Number.isInteger);
      let res;
      if (postId) {
        res = await api('PUT', '/api/posts/' + postId, payload);
      } else {
        res = await api('POST', '/api/posts', payload);
      }
      showNotice('success', status === 'published' ? '✓ 已发布' : '✓ 已保存');
      if (status === 'published') {
        setTimeout(() => { location.href = '/managers/'; }, 600);
        return;
      }
      if (!postId && res.id) {
        history.replaceState(null, '', '/managers/editor?id=' + res.id);
      }
      if (res.id) {
        delBtn.style.display = '';
        delBtn.onclick = async () => {
          if (!confirm('确定删除这篇文章？')) return;
          try { await api('DELETE', '/api/posts/' + res.id); location.href = '/managers/posts'; }
          catch (e) { showNotice('error', '删除失败：' + e.message); }
        };
      }
    } catch (err) {
      showNotice('error', err.data?.details?.fieldErrors
        ? JSON.stringify(err.data.details.fieldErrors)
        : '保存失败：' + err.message);
    } finally {
      saveBtn.disabled = pubBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', () => save('draft'));
  pubBtn.addEventListener('click',  () => save('published'));

  (async () => {
    await loadCategories();
    if (postId) {
      try {
        const p = await api('GET', '/api/posts/' + postId);
        categoryIds = new Set((p.categories || []).map(c => c.id));
        await loadCategories();
        titleEl.value   = p.title;
        slugEl.value    = p.slug;
        slugDirty       = true;
        statusEl.value  = p.status;
        excerptEl.value = p.excerpt || '';
        contentEl.value = p.content_md;
        document.title  = 'Asamiya · ' + p.title;
        delBtn.style.display = '';
        delBtn.onclick = async () => {
          if (!confirm('确定删除这篇文章？')) return;
          try { await api('DELETE', '/api/posts/' + postId); location.href = '/managers/posts'; }
          catch (e) { showNotice('error', '删除失败：' + e.message); }
        };
        refreshPreview();
      } catch (err) {
        showNotice('error', '加载失败：' + err.message);
      }
    } else {
      refreshPreview();
    }
  })();
})();
