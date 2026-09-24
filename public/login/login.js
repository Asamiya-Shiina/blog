'use strict';

// 登录页脚本：登录表单 / 首次设置切换 / 雨滴涟漪 canvas 动画

(() => {
  async function sha256(password) {
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const form = document.getElementById('login-form');
  const err  = document.getElementById('error');
  const btn  = document.getElementById('submit');
  const userEl = document.getElementById('username');
  const passEl = document.getElementById('password');

  const showError = (msg) => {
    err.textContent = msg;
    err.classList.add('is-visible');
  };
  const hideError = () => err.classList.remove('is-visible');

  // 登录模式
  function bindLogin() {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const username = userEl.value.trim();
      const password = passEl.value;
      if (!username || !password) {
        showError('请输入用户名和密码');
        return;
      }
      btn.disabled = true;
      btn.textContent = '登录中…';
      try {
        const password_hash = await sha256(password);
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(password_hash ? { username, password_hash } : { username, password }),
        });
        if (res.status === 204) {
          // 登录成功：管理员进后台，普通用户进个人主页
          try {
            const m = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
            if (m.role === 'admin') window.location.href = '/managers/';
            else window.location.href = '/me/';
          } catch {
            window.location.href = '/me/';
          }
          return;
        }
        if (res.status === 429) { showError('尝试次数过多，请稍后再试'); return; }
        if (res.status === 401) { showError('用户名或密码错误'); return; }
        showError('登录失败 (' + res.status + ')');
      } catch (e) {
        console.error('登录异常:', e);
        showError('网络错误: ' + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = '登录';
      }
    });
  }

  // 切换为创建账号模式
  function switchToSetup() {
    document.querySelector('h1').textContent = '创建管理员账号';
    const sub = document.createElement('p');
    sub.className = 'subtitle';
    sub.textContent = '首次使用，请设置管理员账户';
    document.querySelector('h1').insertAdjacentElement('afterend', sub);
    document.title = '创建账号';
    btn.textContent = '创建账号';
    document.getElementById('reg-link').style.display = 'none';

    // 添加确认密码字段
    const confirmLabel = document.createElement('label');
    confirmLabel.setAttribute('for', 'confirm');
    confirmLabel.textContent = '确认密码';
    const confirmInput = document.createElement('input');
    confirmInput.id = 'confirm';
    confirmInput.name = 'confirm';
    confirmInput.type = 'password';
    confirmInput.autocomplete = 'new-password';
    confirmInput.required = true;
    passEl.parentElement.insertBefore(confirmLabel, btn);
    passEl.parentElement.insertBefore(confirmInput, btn);
    passEl.autocomplete = 'new-password';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const username = userEl.value.trim();
      const password = passEl.value;
      const confirm = confirmInput.value;
      if (!username || !password) {
        showError('请输入用户名和密码');
        return;
      }
      if (password.length < 10) {
        showError('密码至少需要 10 个字符');
        return;
      }
      if (password !== confirm) {
        showError('两次输入的密码不一致');
        return;
      }
      btn.disabled = true;
      btn.textContent = '创建中…';
      try {
        const password_hash = await sha256(password);
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(password_hash ? { username, password_hash } : { username, password }),
        });
        if (res.status === 201) {
          window.location.href = '/managers/';
          return;
        }
        const data = await res.json().catch(() => ({}));
        showError(data.error || '创建失败 (' + res.status + ')');
      } catch (e) {
        console.error('创建异常:', e);
        showError('网络错误: ' + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = '创建账号';
      }
    });
  }

  // 启动：检测是否需要初始化
  (async () => {
    try {
      const res = await fetch('/api/setup-status');
      const data = await res.json();
      if (data.needsSetup) {
        switchToSetup();
      } else {
        bindLogin();
      }
    } catch {
      bindLogin();
    }
  })();
})();

// —— 雨滴涟漪动画 ——
(() => {
  const canvas = document.getElementById('ripples');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ripples = [];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width  = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function spawn() {
    ripples.push({
      x: Math.random() * w,
      y: Math.random() * h * 0.85,
      maxR: 70 + Math.random() * 70,
      peak:  0.55 + Math.random() * 0.30,
      life:  0,
      ttl:   90 + Math.random() * 50,
    });
    if (ripples.length > 28) ripples.shift();
  }

  let lastSpawn = 0;
  function loop(now) {
    if (document.visibilityState === 'hidden') {
      requestAnimationFrame(loop);
      return;
    }
    if (!lastSpawn) lastSpawn = now;
    if (now - lastSpawn > 280 + Math.random() * 180) {
      spawn();
      lastSpawn = now;
    }

    ctx.clearRect(0, 0, w, h);

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.life += 1;
      const t = r.life / r.ttl;
      if (t >= 1) { ripples.splice(i, 1); continue; }

      const radius = r.maxR * Math.pow(t, 0.7);
      const opacity = r.peak * Math.sin(Math.PI * t);

      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${(opacity * 0.85).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      if (radius > 14) {
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(opacity * 0.45).toFixed(3)})`;
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }

      if (t < 0.25) {
        const flash = (1 - t / 0.25) * 0.35;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2 + 4 * (1 - t / 0.25), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${flash.toFixed(3)})`;
        ctx.fill();
      }
    }

    requestAnimationFrame(loop);
  }

  if (!reduceMotion) {
    requestAnimationFrame(loop);
  } else {
    for (let k = 0; k < 6; k++) spawn();
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const radius = r.maxR * 0.7;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
})();
