'use strict';

// 自写滑块验证模块
// 用于注册反滥用。后端生成随机目标坐标 targetX，前端据此在轨道上绘制缺口，
// 用户将滑动手柄拖到缺口位置后提交坐标，后端在容差范围内判定是否通过。
// 一次性使用、5 分钟过期，状态存储于内存 Map（单进程）。

const crypto = require('node:crypto');

const TOLERANCE = 25;          // 判定容差（px）
const TTL_MS = 5 * 60 * 1000;  // 5 分钟过期时间
const MAX_ITEMS = 2000;        // 内存中 token 上限，超过则清理
const WIDTH = 280;             // 轨道宽度（px）
const SLIDER_W = 52;           // 滑块与缺口宽度（px）
const MIN_X = 20;
const MAX_X = WIDTH - SLIDER_W - 20;

// 拖动轨迹（反脚本）校验参数
// 仅比对最终坐标很容易被脚本绕过：攻击者只需读取 targetX 再原样提交即可
// 这里要求客户端上报一段完整拖动轨迹（时间递增的位置采样），校验其符合
// 人类拖拽特征（样本数、持续时长、单调推进、终点落入缺口），
// 将破解门槛从「一行 curl」抬至「至少仿真一段逼真轨迹」
const MIN_SAMPLES = 4;         // 至少需要多少个采样点
const MIN_DURATION_MS = 350;   // 拖拽最短持续时间（毫秒）；脚本无法瞬时完成
const MAX_DURATION_MS = 8000;  // 最长持续时间，防止拖拽过久刷 token
const MAX_BACK_JUMP = 90;      // 允许的轻微回拽幅度（真实手指难免出现抖动）
const END_TOLERANCE = TOLERANCE; // 轨迹终点也须落在缺口容差内

const store = new Map();       // token -> { targetX, ip, expiresAt }

// 从 req 提取 IP 字符串（req.ip 已由 X-Forwarded-For 解析）
// 注意：必须与 verify 调用方传入的 IP 使用同一提取逻辑，否则绑定关系失效
function ipOf(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
}

// 创建验证：生成 token 与目标坐标，并将发起请求的 IP 绑定到该 token
// 后续 verify 必须在同一 IP 上提交，否则直接判定失败，
// 防止「A 设备解一次、B 设备提交」的跨机器盗用
function create(req) {
  // 使用 CSPRNG 而非 Math.random()：
  // Math.random 输出可预测，攻击者在采集若干样本后可推断下一次的目标坐标
  const targetX = crypto.randomInt(MIN_X, MAX_X);
  const token = crypto.randomUUID();
  store.set(token, { targetX, ip: ipOf(req), expiresAt: Date.now() + TTL_MS });
  return { token, targetX, width: WIDTH, sliderWidth: SLIDER_W };
}

// 校验拖动轨迹是否符合「人类拖拽」特征
// targetX 为缺口在 captcha 坐标系下的目标坐标（与 create 返回给前端的一致）
function playsHuman(track, targetX) {
  if (!Array.isArray(track) || track.length < MIN_SAMPLES) return false;
  let lastX = null;
  let lastT = null;
  for (const p of track) {
    if (!p || typeof p !== 'object') return false;
    const x = Number(p.x);
    const t = Number(p.t);
    if (!Number.isFinite(x) || !Number.isFinite(t)) return false;
    if (x < 0 || x > WIDTH) return false;
    if (lastX !== null) {
      if (t <= lastT) return false;                 // 时间必须严格递增
      if (x < lastX - MAX_BACK_JUMP) return false;  // 大幅回退视为脚本跳步
    }
    lastX = x;
    lastT = t;
  }
  const duration = lastT - track[0].t;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) return false;
  if (Math.abs(lastX - targetX) > END_TOLERANCE) return false;
  return true;
}

// 校验：一次性消费（无论对错都销毁）
// 过期、不存在、IP 不匹配、轨迹不符或超出容差均判定失败
function verify(token, submittedX, track, req) {
  if (!token || typeof token !== 'string') return false;
  const entry = store.get(token);
  store.delete(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  // IP 绑定校验：解 captcha 的 IP 与提交时的 IP 必须一致
  const submitIp = ipOf(req);
  if (entry.ip && submitIp && entry.ip !== submitIp) return false;
  const x = Number(submittedX);
  if (!Number.isFinite(x)) return false;
  if (Math.abs(x - entry.targetX) > TOLERANCE) return false;
  // 仅比对坐标仍不够，需附上一段人类拖拽轨迹，否则视为脚本
  return playsHuman(track, entry.targetX);
}

// 超过上限时清理过期项，防止内存无界增长
// 注意：绝不能用 store.clear() —— Map 的迭代顺序是插入顺序，
// 超限时整表清空会连带清掉其他用户尚未使用的有效 token，
// 攻击者只要刷满 2000 条就能让所有正常访客的验证码失效（注册被 DoS）。
// 这里按插入顺序逐个驱逐最旧的条目，只牺牲最早的一批。
function sweep() {
  if (store.size < MAX_ITEMS) return;
  const now = Date.now();
  // 先清过期项（不影响任何人）
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
  // 仍然超限：按插入顺序驱逐最旧的，直到回到上限的 80%
  if (store.size >= MAX_ITEMS) {
    const target = Math.floor(MAX_ITEMS * 0.8);
    let drop = store.size - target;
    for (const k of store.keys()) {
      if (drop <= 0) break;
      store.delete(k);
      drop -= 1;
    }
  }
}

module.exports = { create, verify, sweep, WIDTH };

// 定期主动清理过期项（默认每 60s 一次），
// 避免在没有 create 调用的时段下，失效 token 持续占用内存
const sweepTimer = setInterval(sweep, 60_000);
sweepTimer.unref();