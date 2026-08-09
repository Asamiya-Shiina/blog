FROM node:24-slim

# better-sqlite3 + bcrypt 需要编译工具
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x docker-entrypoint.sh

# 非 root 用户运行
RUN groupadd -r blog && useradd -r -g blog -d /app -s /sbin/nologin blog \
    && mkdir -p /app/data && chown -R blog:blog /app

# 数据目录（SQLite + 上传文件），运行时挂载 volume
VOLUME /app/data

EXPOSE 3000

USER blog

ENTRYPOINT ["./docker-entrypoint.sh"]
