#!/usr/bin/env bash
# install.sh — one-click deploy / update for blog
#
# First run: clones the repo, generates .env with random secrets, starts containers.
# Later runs: pulls latest, restarts containers. Idempotent.
#
# Prereqs: Docker Engine + Docker Compose v2 plugin.
# No PAT needed — image is public on ghcr.io.

set -euo pipefail

REPO="https://github.com/Asamiya-Shiina/blog.git"
DIR="${BLOG_DIR:-blog}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not installed." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin missing." >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating existing $DIR/"
  (cd "$DIR" && git pull --ff-only)
else
  echo "==> Cloning $REPO -> $DIR/"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  echo "==> Generating .env"
  cp .env.example .env
  SESSION_SECRET=$(openssl rand -hex 32)
  ADMIN_PASSWORD=$(openssl rand -hex 12)
  sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" .env
  sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" .env
  rm -f .env.bak
  echo
  echo "  ADMIN_USERNAME=admin"
  echo "  ADMIN_PASSWORD=$ADMIN_PASSWORD"
  echo "  SESSION_SECRET=$SESSION_SECRET"
  echo "  ^^^ Save the password now — it won't be shown again."
fi

docker compose pull
docker compose up -d
echo
echo "==> blog up at http://localhost:3000"