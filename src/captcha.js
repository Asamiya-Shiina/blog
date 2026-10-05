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
//
// ⚠️ 根本局限：本 captcha 把 targetX 返回给前端是设计如此（前端要据此绘制缺口），
// 攻击者一定知道 targetX，因此服务端无法靠"算法保密"防止伪造。
// 这里的轨迹校验只能抬高伪造门槛（让脚本必须仿真逼真轨迹），
// 真正的兜底是注册端点的 IP 限流（5/min，见 src/routes/auth.js）。
//
// 历史漏洞（已修复）：早期 MIN_SAMPLES=4 + 无前进量校验时，攻击者可提交
//   track = [(0,0),(0,100),(0,200),(targetX,350)]
// 直接通过——曲线整体没动，只在最后瞬移到 targetX。
// 修复后新增累计前进量、单段位移上限与速度范围约束，
// 把"瞬移式绕过"变成必须伪造一条看起来像人类的曲线。

const MIN_SAMPLES = 6;                  // 提高到 6，伪造更长轨迹更费力
const MIN_DURATION_MS = 500;            // 拖拽最短持续时间（毫秒）
const MAX_DURATION_MS = 8000;           // 最长持续时间，防止拖拽过久刷 token
const MAX_BACK_JUMP = 90;               // 允许的轻微回拽幅度（真实手指难免抖动）
const END_TOLERANCE = TOLERANCE;        // 轨迹终点须落在缺口容差内

// 新增：单段位移/间隔上限（防"按帧瞬时采样后跳跃到 targetX"）
const MAX_SINGLE_DELTA = 60;            // 单段位移上限（px）。真实手指在 ~100ms 内位移 < 60
const MAX_SINGLE_INTERVAL_MS = 250;     // 单段时间间隔上限。> 250ms 多半是停顿或采样器失活

// 新增：累计前进量校验（核心修复）
const MIN_FORWARD_PROGRESS_RATIO = 0.6; // Σ正向dx 必须 ≥ targetX × 0.6，否则视为"原地不动+终点瞬移"

// 新增：平均速度区间（防恒速线性插值脚本 / 防瞬移）
const MIN_MEAN_VELOCITY = 8;            // px/sec，过慢视为故意拖延
const MAX_MEAN_VELOCITY = 400;          // px/sec，过快视为瞬移

// 新增：速度方差下限（防"匀速直线"）
// 真实人类有加速-减速曲线（开始慢、中间快、末端再慢），最低与最高速度差应 > 阈值
const MIN_VELOCITY_RANGE = 15;          // 速度最大值-最小值 ≥ 15 px/sec 才像人

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

  // 格式校验 + 累计正向位移 + 单段约束
  let lastX = null;
  let lastT = null;
  let forwardProgress = 0;
  const velocities = [];
  for (const p of track) {
    if (!p || typeof p !== 'object') return false;
    const x = Number(p.x);
    const t = Number(p.t);
    if (!Number.isFinite(x) || !Number.isFinite(t)) return false;
    if (x < 0 || x > WIDTH) return false;
    if (lastX !== null) {
      const dt = t - lastT;
      if (dt <= 0) return false;                          // 时间必须严格递增
      if (dt > MAX_SINGLE_INTERVAL_MS) return false;      // 单段间隔过长视为采样器失活
      const dx = x - lastX;
      if (Math.abs(dx) > MAX_SINGLE_DELTA) return false;  // 单段瞬移拒绝
      if (dx < -MAX_BACK_JUMP) return false;              // 大幅回退视为脚本跳步
      if (dx > 0) forwardProgress += dx;
      velocities.push((dx * 1000) / dt);                  // 记录本段速度（px/sec，可正可负）
    }
    lastX = x;
    lastT = t;
  }

  const duration = lastT - track[0].t;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) return false;

  // 累计前进量：必须实际向前推进至少 targetX × 0.6（防"原地不动+终点瞬移到 targetX"）
  if (forwardProgress < targetX * MIN_FORWARD_PROGRESS_RATIO) return false;

  // 平均速度区间（基于累计前进量，避免被"原速回拽"稀释）
  const meanVel = (forwardProgress * 1000) / duration;
  if (meanVel < MIN_MEAN_VELOCITY || meanVel > MAX_MEAN_VELOCITY) return false;

  // 速度方差下限：真实人类有加速-减速曲线，恒速视为脚本（防御"线性插值"绕过）
  if (velocities.length >= 3) {
    let vMin = Infinity, vMax = -Infinity;
    for (const v of velocities) {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (vMax - vMin < MIN_VELOCITY_RANGE) return false;
  }

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