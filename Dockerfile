FROM node:20-alpine

WORKDIR /app

# 安装 better-sqlite3 编译依赖
RUN apk add --no-cache python3 make g++

# 先复制依赖文件，利用缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
