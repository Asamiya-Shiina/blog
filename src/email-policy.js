'use strict';

// —— 注册邮箱后缀白名单 ——
// 只放行国内/外主流个人邮箱；一次性 / 匿名 / 企业 / 学校邮箱一律拒绝。
// 维持成本：主流服务域名极少变动，写死比建可配置项更稳。

const ALLOWED_DOMAINS = new Set([
  // Google
  'gmail.com',
  // Microsoft (Outlook / Hotmail / Live / MSN)
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  // Yahoo
  'yahoo.com', 'yahoo.cn', 'yahoo.com.cn',
  // 腾讯 (qq.com + vip.qq.com 个人版；exmail.qq.com 是企业版，故意不放行)
  'qq.com', 'vip.qq.com',
  // 网易
  '163.com', '126.com', 'yeah.net',
  // 新浪
  'sina.com', 'sina.cn',
  // 搜狐
  'sohu.com',
  // 腾讯 (foxmail 别名)
  'foxmail.com',
  // 中国移动
  '139.com',
  // 阿里
  'aliyun.com',
]);

// 判断一个邮箱是否属于白名单域名
// 入参在 zod 阶段已经被 trim + toLowerCase，这里仍做一次防御性处理
function isDomainAllowed(email) {
  if (typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return ALLOWED_DOMAINS.has(domain);
}

module.exports = { isDomainAllowed, ALLOWED_DOMAINS };