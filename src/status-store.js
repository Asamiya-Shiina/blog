'use strict';

const STALE_TIMEOUT_MS = 45_000;

// 存储所有设备状态 Map<deviceId, status>
const devices = new Map();

// SSE 客户端连接池
const sseClients = new Set();

function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.updatedAt > STALE_TIMEOUT_MS) {
      devices.delete(id);
    }
  }
}

function getPublicStatus() {
  cleanStaleDevices();
  const activeDevices = [];
  for (const [id, device] of devices) {
    if (device.active) {
      activeDevices.push({
        id,
        app: device.app,
        title: device.title,
        icon: device.icon,
        updatedAt: device.updatedAt,
      });
    }
  }
  // 按更新时间排序，最新的在前
  activeDevices.sort((a, b) => b.updatedAt - a.updatedAt);
  return { devices: activeDevices };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(getPublicStatus())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

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

function clearStatus(deviceId) {
  devices.delete(deviceId);
  broadcast();
}

function clearAllStatus() {
  devices.clear();
  broadcast();
}

function addClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

// 定时清理过期设备
setInterval(cleanStaleDevices, 30_000);

module.exports = { updateStatus, clearStatus, clearAllStatus, getPublicStatus, addClient };
