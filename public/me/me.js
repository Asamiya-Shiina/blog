'use strict';

// 个人主页脚本：拉取 /api/me、显示资料、修改名字/签名、上传头像、退出

(async function () {
  const $ = (id) => document.getElementById(id);
  const api = async (method, path, body) => {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error((data && data.error) || res.statusText); e.status = res.status; throw e; }
    return data;
  };

  // 登录守卫
  let me = null;
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login/'); return; }
    if (!r.ok) throw new Error('bad');
    me = await r.json();
  } catch {
    window.location.replace('/login/');
    return;
  }
  $('app').hidden = false;
  $('page-title').textContent = (me.name || me.username) + ' 的主页';
  $('username').textContent = me.username;
  $('email').textContent = me.email || '—';
  $('name').value = me.name || '';
  $('bio').value = me.bio || '';
  renderAvatar(me.avatar_url);

  function renderAvatar(url) {
    const img = $('avatar');
    if (url) { img.src = url; img.alt = '头像'; img.classList.remove('placeholder'); }
    else { img.removeAttribute('src'); img.textContent = '暂无头像'; img.classList.add('placeholder'); }
  }

  $('link-logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/logout'); } catch {}
    window.location.replace('/login/');
  });

  // 保存名字/签名
  $('btn-save').addEventListener('click', async () => {
    const msg = $('save-msg');
    msg.className = 'msg';
    try {
      const data = await api('PATCH', '/api/me', { name: $('name').value, bio: $('bio').value });
      me = { ...me, name: data.name, bio: data.bio };
      $('page-title').textContent = (data.name || data.username) + ' 的主页';
      msg.textContent = '已保存';
      msg.className = 'msg ok';
    } catch (e2) { msg.textContent = e2.message; msg.className = 'msg bad'; }
  });

  // 上传头像
  $('btn-avatar').addEventListener('click', () => $('avatar-file').click());
  $('avatar-file').addEventListener('change', async () => {
    const file = $('avatar-file').files[0];
    if (!file) return;
    const msg = $('profile-msg');
    msg.className = 'msg';
    if (file.size > 100 * 1024) { msg.textContent = '头像超过 100KB，请压缩后再上传'; msg.className = 'msg bad'; return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/me/avatar', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = data.error || ('上传失败 (' + res.status + ')'); msg.className = 'msg bad'; return; }
      renderAvatar(data.avatar_url + '?t=' + Date.now());
      me.avatar_url = data.avatar_url;
      msg.textContent = '头像已更新'; msg.className = 'msg ok';
    } catch (e3) { msg.textContent = '网络错误: ' + (e3.message || e3); msg.className = 'msg bad'; }
  });
})();
