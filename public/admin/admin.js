'use strict';

(() => {
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function guard() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        window.location.replace('/login/');
        return null;
      }
      if (!res.ok) throw new Error('auth check failed');
      return await res.json();
    } catch {
      window.location.replace('/login/');
      return null;
    }
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch {}
    window.location.replace('/login/');
  }

  function bindNav(user) {
    const slot = document.getElementById('admin-nav-user');
    if (slot) slot.textContent = user.username;
    const btn = document.getElementById('admin-logout');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); logout(); });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  window.admin = { api, guard, logout, bindNav, escapeHtml };

  document.addEventListener('DOMContentLoaded', async () => {
    const user = await guard();
    if (user) bindNav(user);
  });
})();
