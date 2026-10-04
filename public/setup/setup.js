'use strict';

// 首次设置页脚本
// 创建站点首个管理员账号
//
// 注意：密码以明文提交。
// 服务端需要明文才能执行强度校验（长度、字母+数字、弱密码清单）——
// 若前端先做 SHA-256，服务端拿到的是恒定 64 位十六进制串，
// 所有强度规则必然通过，密码策略会形同虚设。
// 传输安全由 HTTPS 保证（本地 HTTP 开发场景本就无中间人风险）。

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
  if (password.length < 10) {
    err.textContent = '密码至少需要 10 个字符';
    return;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    err.textContent = '密码必须同时包含字母和数字';
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
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
