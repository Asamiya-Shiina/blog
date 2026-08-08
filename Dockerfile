FROM node:20-slim

WORKDIR /app

# 安装编译工具
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package*.json ./
RUN npm install --omit=dev

# 清理编译工具
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
