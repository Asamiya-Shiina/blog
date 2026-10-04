'use strict';

// 实时状态存储模块
// 内存中维护所有设备的在线状态，支持 SSE 广播
// 设备超过 45 秒未上报将自动标记为离线

// 超时阈值：45 秒无更新视为离线
const STALE_TIMEOUT_MS = 45_000;

// 设备状态存储：Map<deviceId, { active, app, title, icon, updatedAt }>
const devices = new Map();

// 设备条目硬上限
// 旧实现只靠 45 秒 TTL 清理，没有条数上限：deviceName 由客户端自选且参与 deviceId 组装，
// 一个已登录用户可以按 30 次/15 秒的节奏持续制造新 deviceId。
// 超限时按插入顺序驱逐最旧的条目（Map 迭代顺序即插入顺序）。
const MAX_DEVICES = 200;

// 单用户设备数上限：防止一个账号把整张表占满，挤掉其他用户的设备
const MAX_DEVICES_PER_USER = 10;

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

// 统计某个用户名当前占用的设备数（deviceId 格式 `${username}_${deviceName}`）
function countUserDevices(username) {
  const prefix = username + '_';
  let n = 0;
  for (const id of devices.keys()) {
    if (id.startsWith(prefix)) n += 1;
  }
  return n;
}

// 驱逐某用户最旧的设备条目，直到低于上限
function evictUserDevices(username, keepAtMost) {
  const prefix = username + '_';
  const owned = [];
  for (const [id, d] of devices) {
    if (id.startsWith(prefix)) owned.push([id, d.updatedAt]);
  }
  if (owned.length <= keepAtMost) return;
  owned.sort((a, b) => a[1] - b[1]);   // 最旧在前
  let drop = owned.length - keepAtMost;
  for (const [id] of owned) {
    if (drop <= 0) break;
    devices.delete(id);
    drop -= 1;
  }
}

// 全局超限时按插入顺序驱逐最旧的 20%
function enforceGlobalCap() {
  if (devices.size <= MAX_DEVICES) return;
  const target = Math.floor(MAX_DEVICES * 0.8);
  let drop = devices.size - target;
  for (const k of devices.keys()) {
    if (drop <= 0) break;
    devices.delete(k);
    drop -= 1;
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
// 背压处理：忽略 write() 返回值会让慢客户端把数据堆在 socket 缓冲区里，
// 设备越多 payload 越大、广播越频繁，堆积越严重。
// 这里在写缓冲超过阈值时主动断开该客户端（浏览器会自动重连并拿到全量快照）。
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;   // 1MB

function broadcast() {
  const payload = `data: ${JSON.stringify(getPublicStatus())}\n\n`;
  for (const client of sseClients) {
    try {
      if (client.writableLength > SSE_MAX_BUFFERED_BYTES) {
        // 客户端读取过慢：断开，避免服务端内存被拖垮
        sseClients.delete(client);
        client.destroy();
        continue;
      }
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// 更新设备状态：写入内存并广播给所有 SSE 客户端
// 写入前对各字段做长度截断，防止恶意超长字符串污染内存
// deviceId 形如 `${username}_${deviceName}`，username 由调用方传入用于配额控制
function updateStatus(deviceId, data) {
  const sep = deviceId.lastIndexOf('_');
  const username = sep > 0 ? deviceId.slice(0, sep) : null;

  devices.set(deviceId, {
    active: data.active,
    app: String(data.app || '').slice(0, 100),
    title: String(data.title || '').slice(0, 300),
    icon: String(data.icon || '').slice(0, 50),
    updatedAt: Date.now(),
  });

  // 配额控制：先限制单用户设备数，再兜全局上限
  if (username) evictUserDevices(username, MAX_DEVICES_PER_USER);
  enforceGlobalCap();

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
// unref：不阻塞进程退出（与其他 sweep 模块保持一致）
const staleSweepTimer = setInterval(cleanStaleDevices, 30_000);
staleSweepTimer.unref();

module.exports = {
  updateStatus, clearStatus, getPublicStatus, addClient,
  // 当前 SSE 连接数（供上层做限流判断）
  get clientCount() { return sseClients.size; },
};
