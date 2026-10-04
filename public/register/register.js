'use strict';

// 注册页脚本：滑块验证 + 提交注册
// 注意：注册阶段不收集密码——密码在邮箱验证通过后于 /verify/ 页面设置

(function () {
  const form = document.getElementById('reg-form');
  const err = document.getElementById('error');
  const ok = document.getElementById('ok');
  const btn = document.getElementById('submit');
  const track = document.getElementById('track');
  const handle = document.getElementById('handle');
  const notch = document.getElementById('notch');
  const label = document.getElementById('captcha-label');

  let captcha = null;
  let dragging = false;
  let verifiedX = null;
  let verifiedTrace = null; // 验证通过时的拖动轨迹（发给后端做反脚本校验）
  let dragTrace = [];       // 当前这次拖拽实时采集的采样点 {x, t}

  const showErr = (m) => { err.textContent = m; err.classList.add('is-visible'); };
  const hideErr = () => err.classList.remove('is-visible');
  const showOk = (m) => { ok.textContent = m; ok.classList.add('is-visible'); };

  async function loadCaptcha() {
    try {
      const res = await fetch('/api/captcha');
      captcha = await res.json();
      form.hidden = false;
    } catch {
      showErr('无法加载验证码，请刷新重试');
      return;
    }
    const trackW = track.clientWidth;
    const scale = trackW / captcha.width;
    const notchX = captcha.targetX * scale;
    const notchW = captcha.sliderWidth * scale;
    const handleW = notchW;
    notch.style.left = notchX + 'px';
    notch.style.width = notchW + 'px';
    notch.style.display = 'block';
    handle.style.left = '0px';
    handle.style.width = handleW + 'px';
    const maxLeft = trackW - handleW;
    verifiedX = null;
    verifiedTrace = null;
    dragTrace = [];
    label.className = 'captcha-label';
    label.textContent = '安全验证：把滑块拖到缺口位置';
    handle.classList.remove('verified', 'invalid');
    handle.style.animation = '';
    track.classList.remove('verified-hide');

    const setPos = (clientX) => {
      const rect = track.getBoundingClientRect();
      let pos = clientX - rect.left - handleW / 2;
      pos = Math.max(0, Math.min(maxLeft, pos));
      handle.style.left = pos + 'px';
      // 采集拖动轨迹（captcha 坐标系，供后端校验这是一次真实拖拽而非脚本）
      const t = Date.now();
      const last = dragTrace[dragTrace.length - 1];
      // 同一毫秒触发的连续 move 事件需去重，确保服务端「时间严格递增」的判定不被误伤
      if (!last || t > last.t) dragTrace.push({ x: pos / scale, t });
    };

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragTrace = [];
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPos(e.clientX);
    });
    handle.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      setPos(e.clientX);
      const pos = parseFloat(handle.style.left) || 0;
      if (Math.abs(pos - notchX) <= 14) {
        verifiedX = pos / scale;
        verifiedTrace = dragTrace.length ? dragTrace.slice() : [{ x: verifiedX, t: Date.now() }];
        label.textContent = '验证成功';
        label.classList.add('ok');
        handle.classList.add('verified');
        track.classList.add('verified-hide');
        setTimeout(() => track.parentElement.classList.add('gone'), 1200);
      } else {
        label.textContent = '验证失败，请重新验证';
        label.classList.add('bad');
        handle.classList.add('invalid');
        setTimeout(loadCaptcha, 550);
      }
    });
  }
  loadCaptcha();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideErr();
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();

    if (!username || !email) { showErr('请填写用户名和邮箱'); return; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) { showErr('用户名只能含字母、数字、下划线、连字符'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('邮箱格式不正确'); return; }
    if (!captcha) { showErr('验证码未加载，请稍等'); return; }
    if (typeof verifiedX !== 'number') { showErr('请先把滑块拖到缺口位置'); return; }

    btn.disabled = true;
    btn.textContent = '注册中…';
    try {
      // 注册不再提交密码：密码在邮件验证通过后由本人设置
      // （这样即使他人用你的邮箱注册，也无法预置一个自己知道的密码）
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, captcha_token: captcha.token, captcha_x: verifiedX, captcha_track: verifiedTrace }),
      });
      if (res.status === 201) {
        // 注册成功：等待用户去邮箱点击验证链接并设置密码
        showOk('注册成功，验证邮件已发送。请到邮箱点击链接设置密码完成激活（15 分钟内有效）。');
        form.querySelectorAll('input').forEach(i => i.value = '');
        return;
      }
      const data = await res.json().catch(() => ({}));
      const msgMap = {
        409: '用户名或邮箱已存在',
        429: '操作太频繁，请稍后再试',
        400: '请求不合法，请检查输入',
        503: data.error || '站点暂时无法注册，请稍后再试',
      };
      showErr(data.error === 'captcha failed' ? '验证码校验失败，请重新拖动' : (msgMap[res.status] || (data.error || '注册失败 (' + res.status + ')')));
      loadCaptcha();
    } catch (err2) {
      console.error('注册异常:', err2);
      showErr('网络错误: ' + (err2.message || err2));
    } finally {
      btn.disabled = false;
      btn.textContent = '注册';
    }
  });
})();
