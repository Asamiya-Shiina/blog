'use strict';

// 流式 multipart/form-data 解析
//
// 背景与设计取舍：
// 旧实现把 Node 请求流包装成 Web Request 后调用 undici 的 formData()。
// 那个 API 会把整个请求体缓冲进内存【之后】调用方才能拿到文件字节，
// 因此"最大 200KB / 15MB"的检查发生在内存已经被花掉之后。
// 实测：一个 96MiB 的请求体使 RSS 从 49MB 涨到 439MB（约 4 倍放大），
// 而 NODE_OPTIONS=--max-old-space-size 完全无效（数据在 ArrayBuffer/外部内存里）。
// 唯一约束是容器内存限额，越界即 OOM kill —— 单个未认证请求即可打挂服务。
//
// 这里改用 busboy 做真正的流式解析：
//   - 单文件超过上限时立即停止接收并销毁请求（不再继续缓冲）
//   - 只保留字段元信息，不保留未通过校验的数据
//   - 同时限制文件数、字段数、总字段体积，防止用大量小字段绕过
//
// 重要（稳定性）：busboy 在流被提前销毁时会向 FileStream 发出 'error'
// （"Unexpected end of file"）。若没有监听器，Node 会把它升级为
// uncaughtException 直接【终止进程】——即攻击者只需发起一个大上传然后断开
// 就能打挂服务。因此所有子流都必须挂 error 监听，且销毁路径必须全包 try/catch。
//
// 返回 { ok:true, file, fields } 或 { ok:false, status, error }

const Busboy = require('busboy');

const DEFAULT_LIMITS = {
  maxFileBytes: 200 * 1024,   // 单文件字节上限
  maxFiles: 1,                // 只接受一个文件
  maxFields: 10,              // 普通字段数量上限
  maxFieldBytes: 64 * 1024,   // 单个字段值字节上限
};

function parseMultipart(req, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: {
          fileSize: limits.maxFileBytes,
          files: limits.maxFiles,
          fields: limits.maxFields,
          fieldSize: limits.maxFieldBytes,
          parts: limits.maxFiles + limits.maxFields + 4,
        },
      });
    } catch {
      // multipart 头缺失/不合法
      try { req.resume(); } catch { /* 忽略 */ }
      return done({ ok: false, status: 400, error: 'invalid multipart payload' });
    }

    let aborted = false;
    const fileStreams = new Set();

    // 统一的失败出口：停止读取并让请求侧断开。
    // 全程 try/catch —— 清理路径绝不能抛出，否则会变成 uncaughtException。
    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.unpipe(bb); } catch { /* 忽略 */ }
      try { bb.destroy(); } catch { /* busboy 销毁时的同步异常 */ }
      try { req.destroy(); } catch { /* 忽略 */ }
      done({ ok: false, status, error });
    };

    let fileInfo = null;
    const fields = Object.create(null);
    let fileCount = 0;

    bb.on('file', (name, stream, info) => {
      // 关键：必须在任何操作之前挂上 error 监听，
      // 否则提前销毁该子流会触发未处理的 'error' 事件并终止进程
      fileStreams.add(stream);
      stream.on('error', (err) => {
        // 审计 H6：至少记日志，让运维能看到流式上传中的瞬时错误
        // 真正的清理/响应仍由 fail()/close() 路径负责
        const msg = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
        console.warn('[upload] file stream error:', msg);
      });

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        stream.resume();
        return fail(400, 'too many files');
      }
      if (name !== 'file') {
        stream.resume();
        return;
      }

      const chunks = [];
      let total = 0;
      let truncated = false;
      fileInfo = {
        mime: String(info.mimeType || '').toLowerCase(),
        filename: info.filename || '',
        buffer: null,
        truncated: false,
      };

      stream.on('data', (c) => {
        if (truncated || aborted) return;
        total += c.length;
        // 双保险：busboy 的 fileSize 也会触发 'limit'
        if (total > limits.maxFileBytes) {
          truncated = true;
          return;
        }
        chunks.push(c);
      });
      stream.on('limit', () => {
        truncated = true;
        fail(413, 'file too large');
      });
      stream.on('end', () => {
        if (truncated || aborted) return;
        fileInfo.buffer = Buffer.concat(chunks, total);
        fileInfo.truncated = false;
      });
    });

    bb.on('field', (name, val) => {
      // 拒绝原型污染键名
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;
      fields[name] = typeof val === 'string' ? val : String(val);
    });

    bb.on('filesLimit', () => { if (!aborted) fail(400, 'too many files'); });
    bb.on('fieldsLimit', () => { if (!aborted) fail(400, 'too many fields'); });
    bb.on('partsLimit', () => { if (!aborted) fail(400, 'too many parts'); });
    // busboy 自身的解析错误（畸形 multipart 等），不视为致命
    bb.on('error', () => { if (!aborted) fail(400, 'invalid multipart payload'); });

    bb.on('close', () => {
      if (aborted) return;
      if (!fileInfo) return done({ ok: false, status: 400, error: 'file is required' });
      if (fileInfo.truncated) return done({ ok: false, status: 413, error: 'file too large' });
      if (!fileInfo.buffer || fileInfo.buffer.length === 0) {
        return done({ ok: false, status: 400, error: 'empty file' });
      }
      done({ ok: true, file: fileInfo, fields });
    });

    // 请求侧中断：客户端提前断开（攻击者也会这么干），必须干净收场
    req.on('aborted', () => { if (!aborted) fail(400, 'request aborted'); });
    req.on('error', () => { if (!aborted) fail(400, 'request error'); });

    try {
      req.pipe(bb);
    } catch {
      fail(400, 'invalid multipart payload');
    }
  });
}

module.exports = { parseMultipart };
