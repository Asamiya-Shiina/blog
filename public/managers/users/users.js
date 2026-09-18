'use strict';

/**
 * 用户管理页（/managers/users）脚本
 *
 * 这个页面有两个角色：
 *
 * 1. 首次引导（无任何账号）：显示 setup 表单，调 POST /api/setup 创建首个管理员
 * 2. 正常管理（已登录）：
 *    - admin：可以新建用户、重置他人密码、删除他人账号
 *    - 非 admin：只能重置自己密码，不能管别人（前端也会隐藏对应按钮）
 */

(() => {
  // 从共用工具库解构
  const { api, guard, escapeHtml, bindNav, hashPassword } = window.admin;

  // 两个视图区块：setup 表单 / 管理表格
  const setupView = document.getElementById('setup-view');
  const manageView = document.getElementById('manage-view');

  /**
   * 页面初始化：
   *   1. 先调 guard() 试登录态
   *   2. 已登录 → 显示管理视图、加载用户列表
   *   3. 未登录且 needsSetup → 显示 setup 表单
   *   4. 其他情况 → 跳登录页
   */
  async function init() {
    const user = await guard();
    if (user) {
      bindNav(user);
      if (user.role !== 'admin') {
        // 非管理员：不能新建用户
        document.getElementById('create-toggle').hidden = true;
      }
      manageView.hidden = false;
      await loadUsers(user);
      return;
    }

    // 未登录：检查是否处于"无管理员可登录"状态，需要 setup
    try {
      const s = await api('GET', '/api/setup-status');
      if (s.needsSetup) {
        setupView.hidden = false;
        bindSetupForm();
        return;
      }
    } catch {}
    // 其他情况（数据库存在管理员但当前未登录）：跳登录页
    window.location.replace('/login/');
  }

  /**
   * 绑定首次引导表单提交：
   *   POST /api/setup { username, password }
   *   成功后服务端写 cookie 并 201，返回后浏览器跳后台首页
   */
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

  /**
   * 加载并渲染用户列表
   *
   * 表格列：用户名、角色、创建时间、操作
   * 操作按钮根据当前用户角色与目标用户关系动态生成：
   *   - 重置密码：所有人都有（自己需要旧密码，别人不需要）
   *   - 删除：只有 admin 能看到，且不能删自己
   *
   * @param {{ id: number, role: string }} currentUser guard() 拿到的当前登录用户
   */
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
      // 给所有操作按钮绑事件
      rowsEl.querySelectorAll('button[data-act]').forEach(b => {
        b.addEventListener('click', () => onRowAction(b, currentUser));
      });
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
    }
  }

  /**
   * 操作按钮回调（重置密码 / 删除）
   *
   * 用 prompt() 而非自定义弹窗是为了不引入额外依赖。
   * 生产环境可换成 modal 提升 UX。
   *
   * @param {HTMLButtonElement} btn 触发按钮（带 data-act / data-id / data-name）
   * @param {{ id: number, role: string }} currentUser 当前登录用户
   */
  async function onRowAction(btn, currentUser) {
    const id = btn.dataset.id;
    const name = btn.dataset.name;

    if (btn.dataset.act === 'delete') {
      // 删除：双确认（confirm + 不可恢复提示）
      if (!confirm(`确定删除账号「${name}」？此操作不可恢复。`)) return;
      try {
        await api('DELETE', '/api/users/' + id);
        loadUsers(currentUser);
      } catch (e) {
        alert('删除失败：' + e.message);
      }

    } else if (btn.dataset.act === 'reset') {
      // 重置密码：自己需旧密码（服务端强校验），别人无需旧密码
      const isSelf = String(id) === String(currentUser.id);
      let body;
      if (isSelf) {
        const op = prompt('请输入当前密码');
        if (!op) return;
        const np = prompt('请输入新密码（至少 8 位）');
        if (!np) return;
        if (np.length < 8) { alert('密码至少 8 位'); return; }
        // 同时传明文和 SHA-256，服务端优先用 hash
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

  // —— 新建用户面板（仅 admin 可见）——
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
      // 重新拉当前用户（虽然不会变）以刷新列表
      const u = await guard();
      if (u) loadUsers(u);
    } catch (e2) {
      err.textContent = '创建失败：' + e2.message;
      err.classList.add('is-visible');
    }
  });

  init();
})();