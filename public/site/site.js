'use strict';

(() => {
  // —— 滚动揭示 ——
  const targets = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    targets.forEach(el => io.observe(el));
  }

  // —— 播放器：拖动 + 吸边 ——
  const player = document.getElementById('player');
  if (player) {
    // 封面图不可被拖走：阻止原生图片拖拽（配合 img 的 draggable=false）
    player.addEventListener('dragstart', (e) => {
      if (e.target && e.target.tagName === 'IMG') e.preventDefault();
    });
    const MARGIN_DESKTOP = 36;
    const MARGIN_MOBILE  = 20;
    const SNAP_THRESHOLD = 6;
    const getMargin = () => window.innerWidth <= 560 ? MARGIN_MOBILE : MARGIN_DESKTOP;

    function syncFromBottom() {
      const rect = player.getBoundingClientRect();
      const m = getMargin();
      player.style.left = rect.left + 'px';
      player.style.top  = (window.innerHeight - rect.height - m) + 'px';
      player.style.bottom = 'auto';
    }
    syncFromBottom();

    let dragging = false, moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onDown(e) {
      const t = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      startX = t.clientX; startY = t.clientY;
      startLeft = parseFloat(player.style.left) || 0;
      startTop  = parseFloat(player.style.top)  || 0;
      player.classList.add('is-dragging');
    }
    function onMove(e) {
      if (!dragging) return;
      const t = e.touches ? e.touches[0] : e;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const m = getMargin();
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = player.offsetWidth, ph = player.offsetHeight;
      const newLeft = Math.max(m, Math.min(startLeft + dx, vw - pw - m));
      const newTop  = Math.max(m, Math.min(startTop  + dy, vh - ph - m));
      player.style.left = newLeft + 'px';
      player.style.top  = newTop  + 'px';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      player.classList.remove('is-dragging');

      const m = getMargin();
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = player.offsetWidth, ph = player.offsetHeight;
      const rect = player.getBoundingClientRect();
      const distLeft = rect.left, distRight = vw - rect.right;

      // 合并吸边逻辑：先按"离谁更近"决定左右，再按阈值贴边（避免两套分支冲突）
      let targetLeft = (distLeft <= distRight) ? m : vw - pw - m;
      let targetTop  = vh - ph - m;

      if (distLeft   < SNAP_THRESHOLD) targetLeft = m;
      if (distRight  < SNAP_THRESHOLD) targetLeft = vw - pw - m;

      player.style.left = targetLeft + 'px';
      player.style.top  = targetTop  + 'px';
    }

    player.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 手机端禁用拖动；触屏桌面（如 Surface / iPad 横屏）也允许拖动。
    // 用 matchMedia 区分触屏设备，比 `innerWidth > 560` 更准确。
    const isCoarsePointer = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (!isCoarsePointer) {
      player.addEventListener('touchstart', onDown, { passive: true });
      window.addEventListener('touchmove', onMove, { passive: true });
      window.addEventListener('touchend', onUp);
    }

    player.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    });

    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        const m = getMargin();
        const vw = window.innerWidth, vh = window.innerHeight;
        const pw = player.offsetWidth, ph = player.offsetHeight;
        const rect = player.getBoundingClientRect();
        const wasLeft = rect.left < vw - rect.right;
        player.style.left = (wasLeft ? m : vw - pw - m) + 'px';
        player.style.top  = (vh - ph - m) + 'px';
      }, 120);
    });
  }

  // —— 顶部菜单 ——
  const navToggle = document.getElementById('nav-toggle');
  const navMenu   = document.getElementById('nav-menu');
  if (navToggle && navMenu) {
    const setOpen = (open) => {
      navToggle.classList.toggle('is-open', open);
      navMenu.classList.toggle('is-open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!navToggle.classList.contains('is-open'));
    });
    document.addEventListener('click', (e) => {
      if (!navToggle.contains(e.target) && !navMenu.contains(e.target)) setOpen(false);
    });
    navMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => setOpen(false));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  // —— 音频控制 ——
  const audio = document.getElementById('audio');
  const btn   = document.getElementById('player-btn');
  const fill  = document.querySelector('.player-progress-fill');
  const bar   = document.querySelector('.player-progress');
  const titleEl = document.querySelector('.player-title');
  if (audio && btn) {
    // userWantsPlay：『用户是否在听』。自动暂停不会清零，只有手动暂停才清零，
    // 从而站内跳转/回到前台时仍知道「用户想继续听」。
    let userWantsPlay = false;
    btn.addEventListener('click', () => {
      if (!audio.src) return;  // 没有选中歌曲时不响应
      if (audio.paused) { userWantsPlay = true;  audio.play().catch(() => {}); }
      else              { userWantsPlay = false; audio.pause(); setPausedFlag(true); }
    });
    audio.addEventListener('play', () => {
      btn.classList.add('is-playing');
      userWantsPlay = true;
      setPausedFlag(false);           // 用户又开始听了，撤销「手动暂停过」
    });
    audio.addEventListener('pause', () => btn.classList.remove('is-playing'));

    audio.addEventListener('timeupdate', () => {
      if (!isFinite(audio.duration) || audio.duration === 0) return;
      fill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
    });
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration)) {
        bar.title = '0:00 / ' + format(audio.duration);
      }
    });

    // —— 手动暂停记录（Cookie，3 天） ——
    // 只记一件事：用户上次是否手动按过暂停。记录了 3 天，期间再次访问就不自动播放；
    // 用户重新点播放后撤销，过期自然失效。不记录歌曲/进度。
    const PAUSED_COOKIE = 'playerPaused';
    const PAUSED_MAX_AGE = 3 * 24 * 3600;   // 3 天
    function setPausedFlag(paused) {
      try {
        if (paused) {
          document.cookie = `${PAUSED_COOKIE}=1; path=/; max-age=${PAUSED_MAX_AGE}`;
        } else {
          document.cookie = `${PAUSED_COOKIE}=; path=/; max-age=0`;
        }
      } catch {}
    }
    function hasPausedFlag() {
      return document.cookie
        .split(';')
        .some(c => c.trim().startsWith(PAUSED_COOKIE + '='));
    }
    // 进度条只读：禁止点击/拖动跳转
    bar.addEventListener('click',     (e) => { e.preventDefault(); e.stopPropagation(); });
    bar.addEventListener('mousedown',  (e) => { e.preventDefault(); e.stopPropagation(); });
    bar.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });

    function format(s) {
      const m = Math.floor(s / 60);
      const r = Math.floor(s % 60);
      return m + ':' + String(r).padStart(2, '0');
    }

    // 加载 + 切换当前播放歌曲
    // 返回当前活跃歌曲对象；没有则返回 null
    async function loadActiveSong() {
      try {
        const res = await fetch('/api/music/active', { credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = await res.json();
        return data.song || null;
      } catch {
        return null;
      }
    }

    function applySong(song) {
      if (!song || !song.src) {
        audio.removeAttribute('src');
        audio.load();
        btn.disabled = true;
        btn.title = '尚未选择歌曲';
        if (titleEl) titleEl.textContent = '尚未选择歌曲';
        return;
      }
      // 同一首歌不重置 src，避免打断正在播放的进度
      const curSrc = audio.getAttribute('src');
      if (curSrc !== song.src) {
        audio.src = song.src;
        audio.load();
      }
      btn.disabled = false;
      btn.title = '';
      if (titleEl) titleEl.textContent = song.title || '未命名';
    }

    // —— 自动播放 ——
    // 浏览器默认拦截『有声自动播放』（需用户手势才能出声）。
    // 策略：加载后先尝试一次；此后持续监听各种用户手势，一旦用户
    // 有点击/按键等交互就立即开播，监听一直保持到真正响起来为止。
    function tryAutoplay() {
      if (btn.disabled) return;                  // 尚未选择歌曲
      if (!audio.paused) return;                 // 已在播放
      audio.play().catch(() => { /* 拦截则继续等手势 */ });
    }

    const GESTURES = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];
    function onUserGesture(e) {
      // 播放按钮自带播放/暂停切换逻辑，点它会与这里的全局手势重复触发
      // （按下触发 play，松开又触发 pause）。忽略按钮上的事件，让它自管。
      if (btn.contains(e.target)) return;
      // 用户上一页手动暂停过：不让随手点击又把音乐拉起来
      if (!userWantsPlay) return;
      tryAutoplay();
    }

    // 已开始播放后不再需要手势兜底，移除监听
    audio.addEventListener('play', () => {
      GESTURES.forEach(evt => window.removeEventListener(evt, onUserGesture));
    }, { once: true });
    GESTURES.forEach(evt =>
      window.addEventListener(evt, onUserGesture, { passive: true })
    );

    // 首次加载：决定是否自动开播——只在『上次手动暂停过』时保持暂停
    function resumeLastPlayback(song) {
      if (!song) return false;          // 没有歌曲
      return !hasPausedFlag();          // 上次手动暂停过则不开播（3 天内）
    }
    loadActiveSong().then((song) => {
      applySong(song);
      // 上次手动暂停过 → 不自动播；否则尝试自动开播（手势兜底）
      userWantsPlay = resumeLastPlayback(song);
      if (userWantsPlay) tryAutoplay();
    });
    // —— 页面失焦自动暂停 / 回焦自动播放 ——
    // 切走标签页或切到其他窗口时暂停，切回来接着播。
    // 只用 autoPaused 标记分辨「因失焦而暂停」，避免用户手动暂停后也被莫名续播。
    let autoPaused = false;

    function maybePauseTrack() {
      // 用户没在听（从未播或手动暂停过）就不处理；只有确认用户在听才失焦暂停
      if (btn.disabled || !userWantsPlay || audio.paused) return;
      audio.pause();
      autoPaused = true;                          // 仅真正暂停时才标记
    }
    function maybeResumeTrack() {
      if (btn.disabled) return;
      if (audio.paused && autoPaused) {           // 仅恢复「因失焦被自动暂停」的播放
        audio.play().catch(() => {});
      }
      autoPaused = false;
    }

    // 切标签页/最小化：document 可见性变化
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        maybePauseTrack();
      } else {
        maybeResumeTrack();
        // 标签页回到前台时重新拉一次（管理员刚换歌能立即生效）
        loadActiveSong().then(applySong);
      }
    });
    // 切到其他应用窗口：浏览器失去窗口焦点
    window.addEventListener('blur',  maybePauseTrack);
    window.addEventListener('focus', maybeResumeTrack);
  }

  // —— 实时状态 ——
  const statusSection = document.getElementById('status-section');
  const statusBody = document.getElementById('status-body');
  if (statusSection && statusBody) {
    const appIcons = {
      'code': '📝',
      'chrome': '🌐',
      'firefox': '🐧',
      'msedge': '🌐',
      'idea64': '⚙️',
      'obsidian': '📚',
      'figma': '🎨',
      'typora': '✍️',
      'notion': '📓',
      'spotify': '🎵',
      'discord': '💬',
      'windowsterminal': '⌨️',
      'explorer': '📂',
    };

    function getIcon(iconKey) {
      return appIcons[iconKey] || '💻';
    }

    function updateStatusCard(data) {
      // data 现在是 { devices: [...] } 格式，只显示最新的一个
      const devices = data && data.devices ? data.devices : [];

      if (devices.length === 0) {
        statusBody.classList.remove('is-active');
        statusBody.innerHTML = `
          <div class="status-offline">
            <span class="status-dot"></span>
            <span>当前离线</span>
          </div>`;
        return;
      }

      statusBody.classList.add('is-active');
      // 休息中（break）优先级最低：只要还有其他状态，就优先显示其他状态的最新设备
      const device = devices.find(d => d.icon !== 'break') || devices[0];

      // 休息状态特殊显示
      if (device.icon === 'break') {
        const host = device.id ? (device.id.split('_')[1] || '') : '';
        const hostHtml = host
          ? `<div class="status-window-title" title="${escapeAttr(host)}">${escapeHtml(host)}</div>`
          : '';
        statusBody.innerHTML = `
          <span class="status-dot"></span>
          <div class="status-app-icon">☕</div>
          <div class="status-info">
            <div class="status-app-name">${escapeHtml(device.app)}</div>
            ${hostHtml}
          </div>`;
        return;
      }

      const icon = getIcon(device.icon);
      const safeTitle = (device.title != null && device.title !== '') ? String(device.title) : '';
      const titleHtml = safeTitle
        ? `<div class="status-window-title" title="${escapeAttr(safeTitle)}">${escapeHtml(safeTitle)}</div>`
        : '';
      statusBody.innerHTML = `
        <span class="status-dot"></span>
        <div class="status-app-icon">${icon}</div>
        <div class="status-info">
          <div class="status-app-name">${escapeHtml(device.app)}</div>
          ${titleHtml}
        </div>`;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }
    // escapeAttr 与 escapeHtml 完全等价（双重转义会把 `&quot;` 变成 `&amp;quot;`）。
    // 这里保留同名引用以免外部模板爆改，所有调用点统一走 escapeHtml。
    const escapeAttr = escapeHtml;

    let evtSource = null;
    let sseBackoffMs = 1000;
    const SSE_MAX_BACKOFF = 30000;
    function connectSSE() {
      evtSource = new EventSource('/api/data/stream');
      evtSource.onmessage = (e) => {
        // 收到一条正常消息，重置退避
        sseBackoffMs = 1000;
        try {
          const data = JSON.parse(e.data);
          updateStatusCard(data);
        } catch {}
      };
      evtSource.onerror = () => {
        evtSource.close();
        setTimeout(connectSSE, sseBackoffMs);
        // 指数退避，封顶 30s，避免被网关拒后无限打
        sseBackoffMs = Math.min(sseBackoffMs * 2, SSE_MAX_BACKOFF);
      };
    }
    connectSSE();
  }
})();
