'use strict';

// 留言板脚本：渲染留言列表、嵌套回复、发布/删除/回复

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(t) {
  if (!t) return '';
  // 服务端是北京时间（+8h），按字符串直接展示 yyyy-mm-dd hh:mm
  return t.replace('T', ' ').slice(0, 16);
}
function roleTagClass(role) { return role === 'admin' ? 'admin' : role === 'moderator' ? 'moderator' : ''; }
function roleTagLabel(role) { return role === 'admin' ? '管理员' : role === 'moderator' ? '版主' : ''; }

let me = null;       // 当前登录用户
let messages = [];   // 顶层留言 + 嵌套 replies

async function fetchMe() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.ok) me = await r.json();
  } catch {}
}

async function fetchMessages() {
  const r = await fetch('/api/messages');
  const d = await r.json();
  messages = d.messages || [];
}

function renderMessage(m, isChild) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.dataset.id = m.id;

  const tag = roleTagLabel(m.role) ? `<span class="role-tag ${roleTagClass(m.role)}">${roleTagLabel(m.role)}</span>` : '';
  // 优先展示个人主页昵称，未设置时退回账号名
  const displayName = m.name || m.username;
  const avatar = m.avatar_url
    ? `<img class="avatar" src="${escapeHtml(m.avatar_url)}" alt="" />`
    : `<div class="avatar" aria-hidden="true"></div>`;
  const loc = m.location ? `<span class="loc">${escapeHtml(m.location)}</span>` : '';
  const ipAdmin = (me && me.role === 'admin' && m.ip) ? `<span class="loc">IP ${escapeHtml(m.ip)}</span>` : '';

  const canDelete = m.is_owner || (me && me.role === 'admin');
  const actions = [];
  if (me && !isChild) actions.push(`<button class="reply-btn">回复</button>`);
  if (canDelete) actions.push(`<button class="del">删除</button>`);

  wrap.innerHTML = `
    <div class="meta">
      ${avatar}
      <div class="meta-text">
        <span class="name">${escapeHtml(displayName)}</span>${tag}
        <span class="time-loc">${formatTime(m.created_at)}${loc ? ' · ' + loc : ''}</span>
        ${ipAdmin}
      </div>
    </div>
    <div class="content">${escapeHtml(m.content)}</div>
    <div class="actions">${actions.join('')}</div>
    <div class="reply-form" data-parent="${m.id}">
      <textarea placeholder="回复 ${escapeHtml(displayName)}…" maxlength="2000"></textarea>
      <div class="error"></div>
      <div class="actions-row">
        <button class="btn btn-sm reply-submit">发送</button>
        <button class="btn btn-ghost btn-sm reply-cancel">取消</button>
      </div>
    </div>
    ${!isChild && m.replies && m.replies.length ? '<div class="replies"></div>' : ''}
  `;

  const replyBtn = wrap.querySelector('.reply-btn');
  if (replyBtn) replyBtn.addEventListener('click', () => {
    const f = wrap.querySelector('.reply-form');
    f.classList.toggle('is-open');
    if (f.classList.contains('is-open')) f.querySelector('textarea').focus();
  });
  const delBtn = wrap.querySelector('.del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('删除这条留言？回复也会一起被删。')) return;
    const r = await fetch(`/api/messages/${m.id}`, { method: 'DELETE' });
    if (r.ok) await reload();
    else alert('删除失败');
  });

  const replyForm = wrap.querySelector('.reply-form');
  if (replyForm) {
    replyForm.querySelector('.reply-cancel').addEventListener('click', () => {
      replyForm.classList.remove('is-open');
      replyForm.querySelector('textarea').value = '';
      replyForm.querySelector('.error').textContent = '';
    });
    replyForm.querySelector('.reply-submit').addEventListener('click', async () => {
      const ta = replyForm.querySelector('textarea');
      const err = replyForm.querySelector('.error');
      const text = ta.value.trim();
      if (!text) { err.textContent = '内容不能为空'; return; }
      err.textContent = '';
      replyForm.querySelector('.reply-submit').disabled = true;
      try {
        const r = await fetch('/api/messages', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, parent_id: m.id }),
        });
        if (!r.ok) { err.textContent = (await r.json()).error || '失败'; return; }
        ta.value = '';
        replyForm.classList.remove('is-open');
        await reload();
      } finally {
        replyForm.querySelector('.reply-submit').disabled = false;
      }
    });
  }

  if (!isChild && m.replies && m.replies.length) {
    const repliesWrap = wrap.querySelector('.replies');
    for (const c of m.replies) repliesWrap.appendChild(renderMessage(c, true));
  }
  return wrap;
}

function render() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!messages.length) {
    list.innerHTML = '<div class="empty">还没有留言，来当第一个吧 ✨</div>';
    return;
  }
  for (const m of messages) list.appendChild(renderMessage(m, false));
}

async function reload() {
  await fetchMessages();
  render();
}

document.getElementById('composer-btn').addEventListener('click', async () => {
  const ta = document.getElementById('composer-text');
  const err = document.getElementById('composer-error');
  const text = ta.value.trim();
  if (!text) { err.textContent = '内容不能为空'; return; }
  err.textContent = '';
  const btn = document.getElementById('composer-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/messages', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (r.status === 401) { window.location.href = '/login/'; return; }
    if (!r.ok) { err.textContent = (await r.json()).error || '失败'; return; }
    ta.value = '';
    await reload();
  } finally {
    btn.disabled = false;
  }
});

(async function init() {
  await fetchMe();
  if (me) {
    if (!me.avatar_url) {
      document.getElementById('avatar-hint').hidden = false;
    } else {
      document.getElementById('composer').hidden = false;
    }
  } else {
    document.getElementById('login-hint').hidden = false;
  }
  await reload();
})();
