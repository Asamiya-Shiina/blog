'use strict';

// —— 实时状态存储 ——
// 内存中维护所有设备的在线状态，支持 SSE 广播
// 设备超过 45 秒未上报则自动标记为离线

// 超时阈值：45 秒无更新视为离线
const STALE_TIMEOUT_MS = 45_000;

// 设备状态存储 Map<deviceId, { active, app, title, icon, updatedAt }>
const devices = new Map();

// SSE 客户端连接池（Set 自动去重）
const sseClients = new Set();

// 清理过期设备：超过 STALE_TIMEOUT_MS 未更新的设备移除
function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.updatedAt > STALE_TIMEOUT_MS) {
      devices.delete(id);
    }
  }
}

// 获取公开状态：清理过期设备后，返回所有活跃设备的信息
function getPublicStatus() {
  cleanStaleDevices();
  const activeDevices = [];
  for (const [id, device] of devices) {
    if (device.active) {
      activeDevices.push({
        id,            // deviceId（用户名_设备名）
        app: device.app,
        title: device.title,
        icon: device.icon,
        updatedAt: device.updatedAt,
      });
    }
  }
  // 按更新时间倒序，最新的在前
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
// 数据在写入前做长度截断，防止恶意超长字符串
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

// 清除单个设备状态（离线）
function clearStatus(deviceId) {
  devices.delete(deviceId);
  broadcast();
}

// 清除所有设备状态（管理操作）
function clearAllStatus() {
  devices.clear();
  broadcast();
}

// 注册 SSE 客户端连接，断开时自动移除
function addClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

// 定时清理过期设备（每 30 秒），防止僵尸设备占用内存
setInterval(cleanStaleDevices, 30_000);

module.exports = {
  updateStatus, clearStatus, clearAllStatus, getPublicStatus, addClient,
  // 当前 SSE 连接数（用于限流判断）
  get clientCount() { return sseClients.size; },
};
