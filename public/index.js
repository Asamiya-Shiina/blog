'use strict';

// 首页脚本：
// 1) 上报本次访问、拉取今日浏览人数
// 2) 已登录时把"登录"按钮替换成用户头像

(function () {
  // 上报访问（失败静默）
  fetch('/api/stats/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/' })
  });
  // 拉取今日人数
  fetch('/api/stats/today')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var el = document.getElementById('view-count');
      if (el && typeof d.count === 'number') el.textContent = d.count;
    })
    .catch(function () { /* 静默失败 */ });
})();

// 右上角：已登录则把"登录"按钮替换成用户头像
(function () {
  var loginBtn = document.getElementById('login-btn');
  var avatar = document.getElementById('user-avatar');
  var img = document.getElementById('user-avatar-img');
  var letter = document.getElementById('user-avatar-letter');
  if (!loginBtn || !avatar || !img || !letter) return;

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (u) {
      if (!u) return;
      var initial = (u.username || '?').trim().charAt(0).toUpperCase();
      if (u.avatar_url) {
        img.src = u.avatar_url;
        img.alt = u.username + ' 的头像';
        img.onload = function () { letter.style.display = 'none'; };
        img.onerror = function () { img.style.display = 'none'; };
      } else {
        img.style.display = 'none';
      }
      letter.textContent = initial;
      avatar.hidden = false;
      loginBtn.hidden = true;
    })
    .catch(function () { /* 未登录或其他错误，保持显示登录按钮 */ });
})();
