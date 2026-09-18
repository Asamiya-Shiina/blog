'use strict';

/**
 * 后台管理共用工具库
 *
 * 每个后台页面（/managers/*）都会通过 <script src="/managers/admin.js"> 引入。
 * 该脚本在 window 上挂载 window.admin 命名空间，提供：
 *
 *   - api()          fetch 封装，自动 JSON、统一错误抛出
 *   - guard()        鉴权守卫：未登录跳 /login/，已登录返回用户对象
 *   - logout()       退出登录并跳转
 *   - bindNav()      顶栏显示当前用户 + 绑定退出按钮
 *   - escapeHtml()   HTML 实体转义，把后端数据插入 innerHTML 前防 XSS
 *   - hashPassword() 浏览器端 SHA-256（避免明文密码走网络）
 *
 * 页面级脚本通过 const { api, guard, ... } = window.admin; 解构后使用。
 * 引入顺序：每个后台页面应先加载 admin.js，再加载自身脚本。
 */

(() => {
  /**
   * 发起 HTTP 请求，自动处理 JSON 与错误
   *
   * @param {string} method  GET / POST / PUT / PATCH / DELETE
   * @param {string} path    形如 '/api/posts' 的相对路径
   * @param {*}      [body]  可选请求体，会自动 JSON.stringify
   * @returns {Promise<*>}   响应体（204 返回 null）
   * @throws  {Error}        非 2xx 时抛出，err.status / err.data 带状态码与响应
   */
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * 鉴权守卫：检查当前会话是否有效
   *
   * 任何后台页面在脚本顶部应先调用 await guard()：
   *   - 未登录（401）或鉴权失败 → 跳 /login/，返回 null
   *   - 已登录 → 返回用户对象 { id, username, role }
   *
   * 注意：本函数失败时会改变 location，调用方只需 await 后判断返回值。
   */
  async function guard() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        // 未登录：跳登录页（replace 防止回退回到原页）
        window.location.replace('/login/');
        return null;
      }
      if (!res.ok) throw new Error('auth check failed');
      return await res.json();
    } catch {
      // 网络错误 / 5xx 也一律视为未登录
      window.location.replace('/login/');
      return null;
    }
  }

  /** 退出登录：调 /api/logout 清 cookie，然后跳 /login/（即使失败也跳转） */
  async function logout() {
    try { await api('POST', '/api/logout'); } catch {} // 忽略错误，目标都是回登录页
    window.location.replace('/login/');
  }

  /**
   * 绑定顶栏用户名 + 退出按钮
   *
   * 约定 DOM：#admin-nav-user 显示 username，#admin-logout 是退出按钮。
   * 每个后台页面 <header> 里都有这两个元素，调用一次即可。
   *
   * @param {{ username: string }} user guard() 返回的用户对象
   */
  function bindNav(user) {
    const slot = document.getElementById('admin-nav-user');
    if (slot) slot.textContent = user.username;
    const btn = document.getElementById('admin-logout');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); logout(); });
  }

  /**
   * HTML 实体转义，防止把后端返回的字符串直接插入 innerHTML 时产生 XSS
   *
   * 用于标题、用户名、应用名等非 Markdown 的纯文本字段。
   * 文章正文走 marked + DOMPurify，不经过这里。
   */
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /**
   * 浏览器端 SHA-256：把明文密码先哈希再发送
   *
   * 服务端的 bcrypt(sha256(明文), 12) 方案要求客户端也先 SHA-256 一遍，
   * 这样网络上传输的永远是 64 位十六进制哈希，避免明文泄露。
   * 失败的 Promise 由调用方处理。
   */
  async function hashPassword(password) {
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 暴露到全局，供页面脚本 window.admin.* 解构
  window.admin = { api, guard, logout, bindNav, escapeHtml, hashPassword };

  /**
   * DOM 就绪后自动执行一次 guard + bindNav：
   *   - 已登录 → 顶栏显示用户名、绑定退出按钮
   *   - 未登录 → guard() 内已跳走
   *
   * 页面级脚本若需要"未登录时展示不同视图"（如 /managers/users 的首次引导），
   * 可调用 guard() 拿到 user 后自行分支。
   */
  document.addEventListener('DOMContentLoaded', async () => {
    const user = await guard();
    if (user) bindNav(user);
  });
})();
