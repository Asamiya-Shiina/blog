# syntax=docker/dockerfile:1
# 多阶段构建：编译工具只留在 build 阶段，runtime 精简到最小。
# 体积从 ~1GB 降到约 200MB 量级。

# —— build：装编译工具，编译 better-sqlite3 / bcrypt 等原生模块 ——
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# —— runtime：不带编译器，只保留运行依赖 ——
FROM node:24-slim AS runtime
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
# gosu 降权；libstdc++6 供原生 .node 模块（better-sqlite3/bcrypt）加载
RUN apt-get update && apt-get install -y --no-install-recommends gosu libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN chmod +x docker-entrypoint.sh

# 非 root 用户运行
RUN groupadd -r blog && useradd -r -g blog -d /app -s /sbin/nologin blog \
    && mkdir -p /app/data && chown -R blog:blog /app

# 数据目录（SQLite + 上传文件），运行时挂载 volume
VOLUME /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# 不在这里设置 USER，让 entrypoint 以 root 运行以便修复权限
# entrypoint 最终会降权到 blog 用户

ENTRYPOINT ["./docker-entrypoint.sh"]