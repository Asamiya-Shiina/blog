'use strict';

// —— IP / 属地工具 ——
// 留言板需要记录发帖人 IP（仅管理员可见）并展示属地（所有人可见）。
// 属地数据来自 geoip-lite（内置 MaxMind GeoLite2，进程内查表，无外网请求）。

// —— 属地 ——
// geoip-lite 整库约 100+MB 常驻内存：一旦 require 就立刻把整个数据库读进内存。
// 这里惰性加载——只有第一次真正要解析某个 IP 属地方才 require，避免博客一启动就白占这 100MB
//（自托管小站多数时候没有留言，属地在绝大多数情况下根本不会被用到）
let geoip;
function loadGeoip() {
  if (geoip !== undefined) return geoip;
  try { geoip = require('geoip-lite') || null; } catch { geoip = null; }
  return geoip;
}

// 从 Express req 抽出第一个 IPv4；纯 IPv6 时回退到 IPv6 字符串。
// trust proxy 已在 server.js 开启，req.ip 会沿 X-Forwarded-For 回溯。
function getClientIp(req) {
  const raw = req.ip || req.socket.remoteAddress || '';
  const m = raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return m ? m[0] : raw || '';
}

// ISO 3166-1 二字码 → 中文名（覆盖常见国家；命中不到时退回到原码）
const COUNTRY_CN = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  US: '美国', JP: '日本', KR: '韩国', KP: '朝鲜',
  GB: '英国', DE: '德国', FR: '法国', IT: '意大利', ES: '西班牙',
  RU: '俄罗斯', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰',
  IN: '印度', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南',
  ID: '印度尼西亚', PH: '菲律宾', BR: '巴西', MX: '墨西哥',
};

// MaxMind 中国省份 region code → 中文名
const CN_REGION_CN = {
  BJ: '北京', SH: '上海', TJ: '天津', CQ: '重庆',
  GD: '广东', ZJ: '浙江', JS: '江苏', SC: '四川',
  HB: '河北', HN: '湖南', HA: '河南', SD: '山东',
  LN: '辽宁', JL: '吉林', HL: '黑龙江', SX: '山西',
  SN: '陕西', GX: '广西', YN: '云南', GZ: '贵州',
  HI: '海南', FJ: '福建', GS: '甘肃', AH: '安徽',
  QH: '青海', NM: '内蒙古', XJ: '新疆', XZ: '西藏',
  NX: '宁夏', JX: '江西',
};

// 把 IP 解析成简短属地字符串，例如 "中国/北京"、"美国"。
// 查不到任何信息时返回空串（前端不渲染）。
function formatLocation(ip) {
  const g = loadGeoip();
  if (!ip || !g) return '';
  const info = g.lookup(ip);
  if (!info) return '';
  const country = COUNTRY_CN[info.country] || info.country || '';
  if (!country) return '';
  if (info.country === 'CN' && info.region && CN_REGION_CN[info.region]) {
    return `${country}/${CN_REGION_CN[info.region]}`;
  }
  return country;
}

module.exports = { getClientIp, formatLocation };