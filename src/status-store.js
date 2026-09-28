'use strict';

// 实时状态存储模块
// 内存中维护所有设备的在线状态，支持 SSE 广播
// 设备超过 45 秒未上报将自动标记为离线

// 超时阈值：45 秒无更新视为离线
const STALE_TIMEOUT_MS = 45_000;

// 设备状态存储：Map<deviceId, { active, app, title, icon, updatedAt }>
const devices = new Map();

// SSE 客户端连接池（Set 自动去重）
const sseClients = new Set();

// 清理过期设备：超过 STALE_TIMEOUT_MS 未更新的设备将被移除
function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.updatedAt > STALE_TIMEOUT_MS) {
      devices.delete(id);
    }
  }
}

// 获取公开状态：清理过期设备后，返回所有活跃设备信息
// viewer 可选：
//   - 传入当前登录用户对象时，每台设备额外返回 username 字段
//   - 未传入或匿名访问时，username 统一为 'anonymous'，仅暴露用户自愿公开的 deviceName
// 该设计可防止公开访客通过 /api/data 或 SSE 枚举在线用户名
function getPublicStatus(viewer) {
  cleanStaleDevices();
  const showUsername = !!(viewer && viewer.username);
  const activeDevices = [];
  for (const [id, device] of devices) {
    if (device.active) {
      // deviceId 格式：`${username}_${deviceName}`（下划线分隔）
      // username 不含下划线（见 src/routes/auth.js 中 usernameSchema 的正则约束），可用 lastIndexOf 切分
      const sep = id.lastIndexOf('_');
      const username = sep > 0 ? id.slice(0, sep) : id;
      const deviceName = sep > 0 ? id.slice(sep + 1) : '';
      // 匿名访客拿到的 id 去掉了用户名前缀（仅保留 deviceName），防止通过 key 枚举在线用户名
      // 前台 status-client.js / site.js 优先使用独立的 deviceName 字段，id 仅作兼容回退
      const exposedId = showUsername ? id : deviceName;
      activeDevices.push({
        id: exposedId,
        username: showUsername ? username : 'anonymous',
        deviceName,               // 设备名（用户自愿公开）
        app: device.app,
        title: device.title,
        icon: device.icon,
        updatedAt: device.updatedAt,
      });
    }
  }
  // 按更新时间倒序，最新的设备排在前面
  activeDevices.sort((a, b) => b.updatedAt - a.updatedAt);
  return { devices: activeDevices };
}

// SSE 广播：向所有连接的客户端推送最新状态
function broadcast() {
  const payload = `data: ${JSON.stringify(getPublicStatus())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// 更新设备状态：写入内存并广播给所有 SSE 客户端
// 写入前对各字段做长度截断，防止恶意超长字符串污染内存
function updateStatus(deviceId, data) {
  devices.set(deviceId, {
    active: data.active,
    app: String(data.app || '').slice(0, 100),
    title: String(data.title || '').slice(0, 300),
    icon: String(data.icon || '').slice(0, 50),
    updatedAt: Date.now(),
  });
  broadcast();
}

// 清除单个设备状态（设备离线时使用）
function clearStatus(deviceId) {
  devices.delete(deviceId);
  broadcast();
}

// 注册 SSE 客户端连接，断开时自动从连接池中移除
function addClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

// 定时清理过期设备（每 30 秒），防止僵尸设备长期占用内存
setInterval(cleanStaleDevices, 30_000);

module.exports = {
  updateStatus, clearStatus, getPublicStatus, addClient,
  // 当前 SSE 连接数（供上层做限流判断）
  get clientCount() { return sseClients.size; },
};
