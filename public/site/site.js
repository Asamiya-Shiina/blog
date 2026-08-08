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
      const distLeft = rect.left, distRight = vw - rect.right, distBottom = vh - rect.bottom;

      let targetLeft = (distLeft <= distRight) ? m : vw - pw - m;
      let targetTop  = vh - ph - m;

      if (distLeft   < SNAP_THRESHOLD) targetLeft = m;
      if (distRight  < SNAP_THRESHOLD) targetLeft = vw - pw - m;
      if (distBottom < SNAP_THRESHOLD) targetTop  = vh - ph - m;

      player.style.left = targetLeft + 'px';
      player.style.top  = targetTop  + 'px';
    }

    player.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    player.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);

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
  if (audio && btn) {
    btn.addEventListener('click', () => {
      if (audio.paused) audio.play(); else audio.pause();
    });
    audio.addEventListener('play',  () => btn.classList.add('is-playing'));
    audio.addEventListener('pause', () => btn.classList.remove('is-playing'));

    audio.addEventListener('timeupdate', () => {
      if (!isFinite(audio.duration) || audio.duration === 0) return;
      fill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
    });
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration)) bar.title = '0:00 / ' + format(audio.duration);
    });
    bar.addEventListener('click', (e) => {
      if (!isFinite(audio.duration) || audio.duration === 0) return;
      const rect = bar.getBoundingClientRect();
      audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    });

    function format(s) {
      const m = Math.floor(s / 60);
      const r = Math.floor(s % 60);
      return m + ':' + String(r).padStart(2, '0');
    }
  }
})();
