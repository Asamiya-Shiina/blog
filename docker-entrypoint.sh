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
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  export SESSION_SECRET
  mkdir -p /app/data 2>/dev/null
  if echo "$SESSION_SECRET" > "$SECRET_FILE" 2>/dev/null; then
    echo "[entrypoint] Generated and saved SESSION_SECRET to $SECRET_FILE"
  else
    echo "[entrypoint] Generated SESSION_SECRET (could not persist - check volume permissions)"
  fi
fi

# 降权到 blog 用户运行 node
exec gosu blog node server.js
