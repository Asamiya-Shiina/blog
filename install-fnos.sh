#!/usr/bin/env bash
# install-fnos.sh — 飞牛 NAS 一键部署脚本（HTTP 9900 端口，无反代无 HTTPS）
#
# 用法（在一台全新的 fnos 上跑这一行即可）：
#   curl -fsSL https://raw.githubusercontent.com/Asamiya-Shiina/blog/main/install-fnos.sh | bash
#
# 行为：
#   - 在 $BLOG_DIR（默认 /vol1/docker/blog）创建工作目录
#   - 从 GitHub 拉取 docker-compose.yml（如不存在）
#   - 检查 .env；缺失时通过 stdin 粘贴导入
#   - docker compose pull && up -d
#
# 前提：fnos 上已装 docker + docker compose v2 插件

set -euo pipefail

BLOG_DIR="${BLOG_DIR:-/vol1/docker/blog}"
RAW_BASE="https://raw.githubusercontent.com/Asamiya-Shiina/blog/main"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not installed." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin missing." >&2
  exit 1
fi

mkdir -p "$BLOG_DIR"
cd "$BLOG_DIR"

if [ ! -f docker-compose.yml ]; then
  echo "==> 下载 docker-compose.yml"
  curl -fsSL "$RAW_BASE/docker-compose.yml" -o docker-compose.yml
fi

if [ ! -f .env ]; then
  echo "==> 现有 .env 未发现"
  echo "    请粘贴 .env 内容到下方（粘贴后回车，再按 Ctrl+D 结束）："
  echo "    ------------------- 起点 -------------------"
  cat > .env
  echo "    ------------------- 终点 -------------------"
  echo "==> .env 已保存"
fi

mkdir -p data

docker compose pull
docker compose up -d

cat <<EOF

==> 部署完成
    博客地址：http://你的域名:9900
    管理后台：http://你的域名:9900/admin
    查看日志：cd $BLOG_DIR && docker compose logs -f

EOF
