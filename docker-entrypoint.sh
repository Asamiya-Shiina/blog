#!/bin/sh

# 修复 data 目录权限（volume 挂载时可能由 root 创建）
if [ -d /app/data ]; then
  chown -R blog:blog /app/data 2>/dev/null || true
fi

SECRET_FILE=/app/data/.session-secret

# 优先从持久化文件读取 SESSION_SECRET
if [ -z "$SESSION_SECRET" ] && [ -f "$SECRET_FILE" ]; then
  export SESSION_SECRET=$(cat "$SECRET_FILE")
  echo "[entrypoint] Loaded SESSION_SECRET from $SECRET_FILE"
fi

# 没有则生成（尝试持久化，失败则仅内存）
# 生成的 32 字节随机串经 hex 编码为 64 字符，足以防离线字典与彩虹表攻击；
# 若 env 里以弱值传入（如 "change-me" / "secret"），仍以原值启动但打 WARNING。
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  export SESSION_SECRET
  mkdir -p /app/data 2>/dev/null
  if echo "$SESSION_SECRET" > "$SECRET_FILE" 2>/dev/null; then
    echo "[entrypoint] Generated and saved SESSION_SECRET to $SECRET_FILE"
  else
    echo "[entrypoint] Generated SESSION_SECRET (could not persist - check volume permissions)"
  fi
else
  if [ "${#SESSION_SECRET}" -lt 32 ]; then
    echo "[entrypoint][WARN] SESSION_SECRET is too short (${#SESSION_SECRET} chars, recommend >= 32). HMAC signing key weak against offline attacks."
  fi
fi

# 降权到 blog 用户运行 node
exec gosu blog node server.js
