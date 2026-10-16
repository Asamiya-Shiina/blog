'use strict';

// 注册邮箱域名白名单。
// 仅放行国内外主流个人邮箱；一次性、匿名、企业及学校邮箱一律拒绝。
//
// 为什么写死而非配置项：
//   1) 主流邮箱服务商域名变更频率极低,迁移一次站点升级足以覆盖;
//   2) 写成配置意味着后台可改 → 攻击者拿到 admin 后可临时加入自己的域名,
//      给站主之外的人发验证邮件,变成「账号预劫持」中转站。
// 维护操作:增删域名直接改本文件,无需数据迁移或默认值重建。

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

// 判断邮箱是否落在白名单内。
// 入参在 zod 阶段已被 trim + toLowerCase,此处再防御性处理一次,
// 防止后续调用方跳过 zod 直接传原始字符串(例如 admin 接口 / 测试代码)。
// lastIndexOf('@@') 而非 indexOf:容忍邮件地址中出现的 '@'(RFC 不允许但部分客户端会尝试)。
function isDomainAllowed(email) {
  if (typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return ALLOWED_DOMAINS.has(domain);
}

module.exports = { isDomainAllowed, ALLOWED_DOMAINS };