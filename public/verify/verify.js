'use strict';

// 邮箱验证页脚本
//
// 流程：
//   1. 从 URL 读取 token → GET /api/verify?token=... 校验
//   2. 有效：显示设置密码表单
//   3. 提交：POST /api/verify { token, password } → 服务端校验强度、哈希、
//      原子激活并直接签发会话 → 跳转个人主页
//
// 注意：密码以明文提交（服务端需要明文才能做强度校验），
// 依赖 HTTPS 保护传输——与注册/登录页原先的预哈希方案相比并未降低实际安全性。
//
// CSP 约束：本站禁止内联脚本与内联样式属性，所有交互均在此文件中绑定。

(function () {
  const $ = (id) => document.getElementById(id);
  const markEl = $('mark');
  const headingEl = $('heading');
  const messageEl = $('message');
  const form = $('verify-form');
  const actions = $('actions');
  const actionPrimary = $('action-primary');
  const usernameEl = $('v-username');
  const formMsg = $('form-msg');
  const submitBtn = $('submit');
  const passEl = $('password');
  const confirmEl = $('confirm');

  const token = new URLSearchParams(window.location.search).get('token') || '';

  function showResult(ok, heading, message, actionHref, actionText) {
    markEl.textContent = ok ? '✓' : '×';
    markEl.className = 'mark ' + (ok ? 'ok' : 'bad');
    headingEl.textContent = heading;
    messageEl.textContent = message;
    if (actionHref) {
      actionPrimary.href = actionHref;
      actionPrimary.textContent = actionText || '继续';
      actions.hidden = false;
    }
  }

  function setFormMsg(text, kind) {
    formMsg.textContent = text;
    formMsg.className = 'form-msg' + (kind ? ' ' + kind : '');
  }

  if (!token) {
    showResult(false, '链接无效', '链接中缺少验证令牌，请回到邮件复制完整链接，或重新发起一次注册。', '/login/', '去登录');
    return;
  }

  // 第一步：校验令牌
  (async function checkToken() {
    let data;
    try {
      const res = await fetch('/api/verify?token=' + encodeURIComponent(token), {
        credentials: 'same-origin',
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.valid) {
        showResult(false, '链接已失效',
          data.error || '验证链接不存在、已被使用或已超过 15 分钟有效期。',
          '/register/', '重新注册');
        return;
      }
    } catch {
      showResult(false, '网络错误', '无法连接服务器，请稍后重试。', '/verify/?token=' + encodeURIComponent(token), '重试');
      return;
    }

    // 令牌有效：显示设置密码表单
    markEl.textContent = '✓';
    markEl.className = 'mark ok';
    headingEl.textContent = '邮箱已验证';
    messageEl.textContent = '最后一步：设置你的登录密码。';
    usernameEl.textContent = data.username || '';
    form.hidden = false;
    actions.hidden = false;
    actionPrimary.href = '/login/';
    actionPrimary.textContent = '已有密码？去登录';
    passEl.focus();
  })();

  // 第二步：设置密码并激活
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMsg('');

    const password = passEl.value;
    const confirm = confirmEl.value;
    if (password.length < 10) { setFormMsg('密码至少需要 10 个字符', 'bad'); return; }
    if (!/[a-zA-Z]/.test(password)) { setFormMsg('密码必须包含字母', 'bad'); return; }
    if (!/[0-9]/.test(password)) { setFormMsg('密码必须包含数字', 'bad'); return; }
    if (password !== confirm) { setFormMsg('两次输入的密码不一致', 'bad'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormMsg(data.error || ('设置失败 (' + res.status + ')'), 'bad');
        // 链接失效类错误：收起表单，给出可行的下一步
        if (res.status === 400 && /失效|已被使用/.test(data.error || '')) {
          form.hidden = true;
          showResult(false, '链接已失效', data.error, '/register/', '重新注册');
        }
        return;
      }
      // 成功：服务端已签发会话，直接进入个人主页
      setFormMsg('设置成功，正在进入个人主页…', 'ok');
      form.hidden = true;
      markEl.textContent = '✓';
      markEl.className = 'mark ok';
      headingEl.textContent = '账号已激活';
      messageEl.textContent = '现在可以开始使用了。';
      window.location.href = '/me/';
    } catch (err) {
      setFormMsg('网络错误：' + (err.message || err), 'bad');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '设置密码并登录';
    }
  });
})();
