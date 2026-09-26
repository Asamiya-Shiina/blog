'use strict';

// —— 自写滑块验证 ——
// 注册反滥用。后端生成随机目标坐标 targetX,前端据此在轨道上画缺口,
// 用户把滑动手柄拖到缺口处再松手,提交最终坐标,后端在容差内判定通过。
// 一次性使用、5 分钟过期,内存 Map 存储(单进程)。

const crypto = require('node:crypto');

const TOLERANCE = 25;          // 判定容差(px)
const TTL_MS = 5 * 60 * 1000;  // 5 分钟过期
const MAX_ITEMS = 2000;        // 上限,超限清理
const WIDTH = 280;             // 轨道宽(px)
const SLIDER_W = 52;           // 滑块/缺口宽(px)
const MIN_X = 20;
const MAX_X = WIDTH - SLIDER_W - 20;

// —— 拖动轨迹(反脚本)校验参数 ——
// 仅仅比对最终坐标太容易被脚本「读到 targetX 再原样提交」就绕过。
// 这里要求客户端上报一段完整拖动轨迹（时间递增的位置采样），校验它符合同一个
// 人类拖拽的特征（样本数、持续时长、单向推进、终点落在缺口内），把破解门槛从
// 「一行 curl」抬到「至少仿真一段逼真轨迹」。
const MIN_SAMPLES = 4;         // 至少多少个采样点
const MIN_DURATION_MS = 350;   // 拖拽至少持续多少毫秒（脚本一瞬不可能）
const MAX_DURATION_MS = 8000;  // 上限，防拖太久刷 token
const MAX_BACK_JUMP = 90;      // 允许的轻微回拽（真实手指难免抖一下）
const END_TOLERANCE = TOLERANCE; // 轨迹终点也须落入缺口的容差内

const store = new Map();       // token -> { targetX, ip, expiresAt }

// 从 req.ip（已经是 X-Forwarded-For 解析后的最终 IP）抽出 IP 字符串
// 注意：必须和 verify 调用方传入的 IP 用同一份提取逻辑，否则绑不上
function ipOf(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
}

// 创建：生成 token 与目标坐标，并把发起请求的 IP 绑定到 token
// 后续 verify 必须在同一 IP 上提交，否则直接失败——防止「A 机器解一次、B 机器提交」
function create(req) {
  // 用 CSPRNG 而不是 Math.random()：Math.random 的输出可预测，
  // 攻击者拿到几张目标图后能推断下一个 token 的位置
  const targetX = crypto.randomInt(MIN_X, MAX_X);
  const token = crypto.randomUUID();
  store.set(token, { targetX, ip: ipOf(req), expiresAt: Date.now() + TTL_MS });
  return { token, targetX, width: WIDTH, sliderWidth: SLIDER_W };
}

// 校验拖动轨迹是否符合同一个「人类拖拽」的特征。
// targetX 是缺口在 captcha 坐标系下的目标坐标（与 create 返回给前端的一致）。
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
      if (x < lastX - MAX_BACK_JUMP) return false;  // 大幅回退＝脚本跳步
    }
    lastX = x;
    lastT = t;
  }
  const duration = lastT - track[0].t;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) return false;
  if (Math.abs(lastX - targetX) > END_TOLERANCE) return false;
  return true;
}

// 校验:一次性消费(无论对错都销毁),过期/不存在/IP 不匹配/轨迹不符/超出容差都失败
function verify(token, submittedX, track, req) {
  if (!token || typeof token !== 'string') return false;
  const entry = store.get(token);
  store.delete(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  // IP 绑定校验：解 captcha 的 IP 跟提交时的 IP 必须一致
  const submitIp = ipOf(req);
  if (entry.ip && submitIp && entry.ip !== submitIp) return false;
  const x = Number(submittedX);
  if (!Number.isFinite(x)) return false;
  if (Math.abs(x - entry.targetX) > TOLERANCE) return false;
  // 仅比对坐标还不够，必须附上一段人类拖拽轨迹，否则视为脚本
  return playsHuman(track, entry.targetX);
}

// 超过上限时清理过期项,防止内存增长
function sweep() {
  if (store.size < MAX_ITEMS) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
  if (store.size > MAX_ITEMS) store.clear();
}

module.exports = { create, verify, sweep, WIDTH };

// 定期主动清理过期项（默认每 60s 一次），避免没有 create 调用时
// 内存里堆积一堆失效 token 占着位置
const sweepTimer = setInterval(sweep, 60_000);
sweepTimer.unref();