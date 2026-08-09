#!/bin/sh
# 自动生成 SESSION_SECRET（如果未提供）
if [ -z "$SESSION_SECRET" ]; then
  export SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "[entrypoint] SESSION_SECRET not set, generated a random one"
fi

exec node server.js
