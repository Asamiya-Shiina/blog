'use strict';

(() => {
  const { api, guard, escapeHtml, bindNav, hashPassword } = window.admin;

  const setupView = document.getElementById('setup-view');
  const manageView = document.getElementById('manage-view');

  async function init() {
    // 先尝试登录态，再看 setup 状态
    const user = await guard();
    if (user) {
      bindNav(user);
      if (user.role !== 'admin') {
        // 只能看，不能管
        document.getElementById('create-toggle').hidden = true;
      }
      manageView.hidden = false;
      await loadUsers(user);
      return;
    }

    // 未登录：检查是否需要 setup
    try {
      const s = await api('GET', '/api/setup-status');
      if (s.needsSetup) {
        setupView.hidden = false;
        bindSetupForm();
        return;
      }
    } catch {}
    window.location.replace('/login/');
  }

  function bindSetupForm() {
    const form = document.getElementById('setup-form');
    const err = document.getElementById('setup-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.remove('is-visible');
      const fd = new FormData(form);
      try {
        await api('POST', '/api/setup', {
          username: fd.get('username'),
          password: fd.get('password'),
        });
        window.location.replace('/managers/');
      } catch (e2) {
        err.textContent = '创建失败：' + e2.message;
        err.classList.add('is-visible');
      }
    });
  }

  async function loadUsers(currentUser) {
    const rowsEl = document.getElementById('rows');
    const countEl = document.getElementById('count-info');
    try {
      const data = await api('GET', '/api/users');
      countEl.textContent = `共 ${data.items.length} 个账号`;
      if (!data.items.length) {
        rowsEl.innerHTML = '<tr><td colspan="4" class="empty">还没有用户。</td></tr>';
        return;
      }
      rowsEl.innerHTML = data.items.map(u => {
        const isSelf = u.id === currentUser.id;
        const canManage = currentUser.role === 'admin';
        return `
          <tr>
            <td><strong>${escapeHtml(u.username)}</strong>${isSelf ? ' <span style="color:var(--muted);font-size:12px">（你）</span>' : ''}</td>
            <td><span class="tag">${escapeHtml(u.role)}</span></td>
            <td style="color:var(--muted);font-size:13px">${(u.created_at || '').replace('T', ' ').slice(0, 16)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-ghost" data-act="reset" data-id="${u.id}" data-name="${escapeHtml(u.username)}">重置密码</button>
              ${canManage && !isSelf ? `<button class="btn btn-danger" data-act="delete" data-id="${u.id}" data-name="${escapeHtml(u.username)}">删除</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
      rowsEl.querySelectorAll('button[data-act]').forEach(b => {
        b.addEventListener('click', () => onRowAction(b, currentUser));
      });
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function onRowAction(btn, currentUser) {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    if (btn.dataset.act === 'delete') {
      if (!confirm(`确定删除账号「${name}」？此操作不可恢复。`)) return;
      try {
        await api('DELETE', '/api/users/' + id);
        loadUsers(currentUser);
      } catch (e) {
        alert('删除失败：' + e.message);
      }
    } else if (btn.dataset.act === 'reset') {
      const isSelf = String(id) === String(currentUser.id);
      let body;
      if (isSelf) {
        const op = prompt('请输入当前密码');
        if (!op) return;
        const np = prompt('请输入新密码（至少 8 位）');
        if (!np) return;
        if (np.length < 8) { alert('密码至少 8 位'); return; }
        body = {
          old_password: op,
          old_password_hash: await hashPassword(op),
          new_password: np,
          new_password_hash: await hashPassword(np),
        };
      } else {
        const np = prompt(`为「${name}」输入新密码（至少 8 位）`);
        if (!np) return;
        if (np.length < 8) { alert('密码至少 8 位'); return; }
        body = { new_password: np, new_password_hash: await hashPassword(np) };
      }
      try {
        await api('PATCH', '/api/users/' + id + '/password', body);
        alert('密码已更新');
      } catch (e) {
        alert('更新失败：' + e.message);
      }
    }
  }

  // —— 新建用户面板 ——
  const createCard = document.getElementById('create-card');
  document.getElementById('create-toggle').addEventListener('click', () => {
    createCard.hidden = false;
    createCard.querySelector('input[name=username]').focus();
  });
  document.getElementById('create-cancel').addEventListener('click', () => {
    createCard.hidden = true;
    document.getElementById('create-error').classList.remove('is-visible');
  });
  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('create-error');
    err.classList.remove('is-visible');
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const pw = fd.get('password');
      const password_hash = await hashPassword(pw);
      await api('POST', '/api/users', {
        username: fd.get('username'),
        password: pw,
        password_hash,
      });
      form.reset();
      createCard.hidden = true;
      const u = await guard();
      if (u) loadUsers(u);
    } catch (e2) {
      err.textContent = '创建失败：' + e2.message;
      err.classList.add('is-visible');
    }
  });

  init();
})();