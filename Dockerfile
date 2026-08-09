FROM node:24-slim

# better-sqlite3 + bcrypt 需要编译工具 + gosu 用于降权
RUN apt-get update && apt-get install -y python3 make g++ gosu && rm -rf /var/lib/apt/lists/*

# 设置时区为北京时间
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

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

# 不在这里设置 USER，让 entrypoint 以 root 运行以便修复权限
# entrypoint 最终会降权到 blog 用户

ENTRYPOINT ["./docker-entrypoint.sh"]
