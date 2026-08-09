#!/bin/sh
SECRET_FILE=/app/data/.session-secret

# 优先从持久化文件读取 SESSION_SECRET
if [ -z "$SESSION_SECRET" ] && [ -f "$SECRET_FILE" ]; then
  export SESSION_SECRET=$(cat "$SECRET_FILE")
  echo "[entrypoint] Loaded SESSION_SECRET from $SECRET_FILE"
fi

# 没有则生成并持久化
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  export SESSION_SECRET
  mkdir -p /app/data
  echo "$SESSION_SECRET" > "$SECRET_FILE"
  echo "[entrypoint] Generated and saved SESSION_SECRET to $SECRET_FILE"
fi

exec node server.js
