'use strict';

// 实时状态存储模块
// 内存中维护所有设备的在线状态，支持 SSE 广播
// 设备超过 45 秒未上报将自动标记为离线

// 超时阈值：45 秒无更新视为离线
const STALE_TIMEOUT_MS = 45_000;

// 设备状态存储：Map<`username\0deviceName`,
//   { username, deviceName, active, app, title, icon, updatedAt }>
// 归属信息（username/deviceName）为记录的一等字段，key 仅保证唯一性
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

// 设备 key：`username + NUL + deviceName`
// 旧实现用 `${username}_${deviceName}` 拼接再 lastIndexOf('_') 切回来，
// 而 username 与 deviceName 都允许下划线 → 切分必然串号，且配额前缀匹配可被
// “deviceName 换前缀”绕过、跨用户误驱逐。现改为记录结构化字段（见下），
// key 只负责唯一性：username 不含 NUL（auth 正则白名单），前段永远无歧义，
// deviceName 内容任意（含 NUL/下划线）也不会影响归属判断。
function deviceKey(username, deviceName) {
  return username + '\u0000' + deviceName;
}

// 清理过期设备:超过 STALE_TIMEOUT_MS 未更新的设备视为掉线,从 Map 移除。
// Map 遍历顺序即插入顺序 → 早掉线设备先被遍历,因此先被清理;
// 这里不主动遍历删除「老于 X 秒前」的项,因为所有设备的过期判定都是同一阈值。
function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.updatedAt > STALE_TIMEOUT_MS) {
      devices.delete(id);
    }
  }
}

// 驱逐某用户最旧的设备条目,直到不超 keepAtMost。
// 按记录上的 username 字段精确匹配(旧实现的前缀匹配会把 alice_bob 算进 alice,
// 也会被 deviceName 换前缀切出的假"用户桶"绕过)。
// 排序用 updatedAt 而非插入顺序:用户主动离线后再次上线应该刷新其「最新」位,
// 防止「谁先来谁占位」导致频繁切换设备的活跃用户被反复踢出。
function evictUserDevices(username, keepAtMost) {
  const owned = [];
  for (const [id, d] of devices) {
    if (d.username === username) owned.push([id, d.updatedAt]);
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

// 全局超限时按插入顺序驱逐最旧的 20%。
// 为什么是 0.8 而非砍到上限:留 20% 缓冲意味着新一轮上报立刻超限前有一段窗口,
// 否则每次 updateStatus 都会触发 enforceGlobalCap,sort 与遍历成本持续叠加。
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

// 获取公开状态:清理过期设备后,返回所有活跃设备信息。
// viewer 可选:
//   - 传入当前登录用户对象时,每台设备额外返回 username 字段
//   - 未传入或匿名访问时,username 统一为 'anonymous',仅暴露用户自愿公开的 deviceName
//
// 为什么 username 受 viewer 控制:防止公开访客通过 /api/data 或 SSE 枚举在线用户名。
// 管理员面板另走需鉴权接口 /api/data/admin,不受此匿名化影响。
function getPublicStatus(viewer) {
  cleanStaleDevices();
  const showUsername = !!(viewer && viewer.username);
  const activeDevices = [];
  for (const device of devices.values()) {
    if (device.active) {
      // 归属信息直接取记录字段（结构化存储，不再从 key 字符串切分，
      // 旧实现的 lastIndexOf('_') 在 deviceName 含下划线时会串号）
      const { username, deviceName } = device;
      // 匿名访客拿到的 id 去掉了用户名前缀（仅保留 deviceName），防止通过 key 枚举在线用户名
      // 前台 status-client.js / site.js 优先使用独立的 deviceName 字段，id 仅作兼容回退
      const exposedId = showUsername ? `${username}_${deviceName}` : deviceName;
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

// SSE 广播:向所有连接的客户端推送最新状态。
// 背压处理:忽略 write() 返回值会让慢客户端把数据堆在 socket 缓冲区里,
// 设备越多 payload 越大、广播越频繁,堆积越严重。
// 这里在写缓冲超过阈值时主动断开该客户端(浏览器会自动重连并拿到全量快照)。
//
// 阈值 1MB 经验值:活跃设备约 20 台时单次 payload ~5-30KB,1MB 缓冲可承受
// 几十轮推送而不会成为瓶颈;再大就开始反向影响服务端 socket 内存。
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

// 更新设备状态:写入内存并广播给所有 SSE 客户端。
// 写入前对各字段做长度截断,防止恶意超长字符串污染内存。
//
// username 来自会话(服务端可信),deviceName 来自客户端,两者分开存储、不拼接切分。
// 截断长度经验值:
//   app 100    → 进程名通常 < 50
//   title 300  → 浏览器标签页标题 < 200
//   deviceName 50 → 用户自取,约束在 50 内足以区分多设备
function updateStatus(username, deviceName, data) {
  const name = String(deviceName).slice(0, 50);
  devices.set(deviceKey(username, name), {
    username,
    deviceName: name,
    active: data.active,
    app: String(data.app || '').slice(0, 100),
    title: String(data.title || '').slice(0, 300),
    icon: String(data.icon || '').slice(0, 50),
    updatedAt: Date.now(),
  });

  // 配额控制：先限制单用户设备数，再兜全局上限
  evictUserDevices(username, MAX_DEVICES_PER_USER);
  enforceGlobalCap();

  broadcast();
}

// 清除单个设备状态（设备离线时使用）
function clearStatus(username, deviceName) {
  devices.delete(deviceKey(username, String(deviceName).slice(0, 50)));
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
