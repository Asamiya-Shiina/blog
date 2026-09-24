'use strict';

// 后台 SMTP 配置脚本

(async function () {
  const { api, guard, bindNav } = window.admin;
  const $ = (id) => document.getElementById(id);

  const user = await guard();
  if (!user) return;
  if (user.role !== 'admin') {
    window.location.replace('/managers/');
    return;
  }
  bindNav(user);
  $('smtp-card').hidden = false;

  try {
    const cfg = await api('GET', '/api/site/smtp');
    $('smtp-state').textContent = cfg.configured
      ? '已配置：' + (cfg.host || '') + '（发件 ' + (cfg.sender || cfg.user || '') + '）'
      : '未配置 SMTP —— 新用户注册将跳过邮箱验证';
    $('smtp-host').value = cfg.host || '';
    $('smtp-port').value = cfg.port || 587;
    $('smtp-user').value = cfg.user || '';
    $('smtp-sender').value = cfg.sender || '';
    $('smtp-secure').checked = !!cfg.secure;
  } catch {}

  $('btn-smtp').addEventListener('click', async () => {
    const msg = $('smtp-msg');
    msg.className = 'msg'; msg.textContent = '';
    try {
      const cfg = await api('PUT', '/api/site/smtp', {
        host: $('smtp-host').value.trim(),
        port: parseInt($('smtp-port').value, 10) || 587,
        user: $('smtp-user').value.trim(),
        pass: $('smtp-pass').value,
        sender: $('smtp-sender').value.trim(),
        secure: $('smtp-secure').checked,
      });
      $('smtp-state').textContent = cfg.configured
        ? '已配置，注册现在需要邮箱验证'
        : '配置未完成（host / 账号 / 密码需齐全）';
      $('smtp-pass').value = '';
      msg.textContent = '已保存';
      msg.className = 'msg ok';
    } catch (e) {
      msg.textContent = e.message;
      msg.className = 'msg bad';
    }
  });
})();
