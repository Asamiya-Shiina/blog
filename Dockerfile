FROM node:20-alpine

# 安装编译工具（better-sqlite3 需要）
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 先复制依赖文件
COPY package*.json ./
RUN npm install --omit=dev

# 删除编译工具减小镜像
RUN apk del python3 make g++

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
