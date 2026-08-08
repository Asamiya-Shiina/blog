FROM node:18

WORKDIR /app

# 安装编译工具
RUN apt-get update && \
    apt-get install -y python3 make g++ libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
