'use strict';

// 首次设置页脚本：创建管理员账号

async function sha256(password) {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const form = document.getElementById('form');
const btn  = document.getElementById('btn');
const err  = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const confirm  = document.getElementById('confirm').value;

  if (password !== confirm) {
    err.textContent = '两次密码不一致';
    return;
  }

  btn.disabled = true;
  try {
    const password_hash = await sha256(password);
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password_hash }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '请求失败');
    }
    location.href = '/managers/';
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
