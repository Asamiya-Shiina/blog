FROM node:24-slim

# better-sqlite3 + bcrypt 需要编译工具
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x docker-entrypoint.sh

# 数据目录（SQLite + 上传文件），运行时挂载 volume
VOLUME /app/data

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
