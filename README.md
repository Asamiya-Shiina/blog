# Asamiya Shiina's Blog

一个轻量、自托管的个人博客系统，带后台管理面板。无构建步骤，无前端框架，开箱即用。

## 功能

**前台**
- 首页：个人介绍、技能展示、联系方式
- 文章列表与详情页（服务端渲染）
- Markdown 渲染（支持 GFM）
- 可拖拽的音乐播放器

**后台管理** (`/Asamiya/`)
- 仪表盘：文章统计、快捷操作
- 文章管理：分页列表、搜索、状态筛选（草稿/已发布）
- Markdown 编辑器：分栏实时预览
- 用户管理：创建账号、重置密码、删除用户

**安全**
- HMAC-SHA256 Session 认证（httpOnly Cookie，30 天有效期）
- bcrypt 密码哈希（cost 12）
- Zod 请求校验 + DOMPurify HTML 消毒
- 登录/注册/写入速率限制
- 安全响应头（X-Content-Type-Options、X-Frame-Options 等）
- 防用户名枚举

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js 24 |
| 框架 | Express 5 |
| 数据库 | SQLite（better-sqlite3，WAL 模式） |
| 认证 | HMAC-SHA256 + bcrypt |
| 校验 | Zod |
| Markdown | marked |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 |
| 部署 | Docker + GitHub Actions → ghcr.io |

## 快速开始

### Docker 部署（推荐）

```bash
# docker-compose.yml
services:
  blog:
    image: ghcr.io/asamiya-shiina/blog:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

首次访问会引导你创建管理员账号。`SESSION_SECRET` 会在容器启动时自动生成并持久化到 `data/.session-secret`。

### 本地开发

```bash
# 要求 Node.js >= 24
git clone git@github.com:Asamiya-Shiina/blog.git
cd blog
npm install

# 创建 .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# 开发模式（文件变更自动重启）
npm run dev

# 生产模式
npm start
```

访问 `http://localhost:3000` 开始使用。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SESSION_SECRET` | 是 | Docker 自动生成 | Session 签名密钥 |
| `PORT` | 否 | `3000` | 监听端口 |
| `DB_PATH` | 否 | `./data/blog.sqlite` | 数据库文件路径 |
| `COOKIE_SECURE` | 否 | `false` | 设为 `true` 以启用 Secure Cookie（HTTPS 环境） |

## 项目结构

```
├── src/
│   ├── server.js          # Express 入口
│   ├── db.js              # SQLite 初始化与 Schema
│   ├── auth.js            # 认证逻辑（Session、密码、中间件）
│   ├── routes/
│   │   ├── auth.js        # 认证 API（登录、注册、用户管理）
│   │   └── posts.js       # 文章 API（CRUD、搜索）
│   └── views/
│       └── posts.js       # 前台页面服务端渲染
├── public/
│   ├── Asamiya/           # 后台管理面板
│   ├── login/             # 登录页
│   ├── setup/             # 初始化设置页
│   └── site/              # 前台公共样式与脚本
├── index.html             # 首页
├── Dockerfile
├── docker-compose.yml
└── docker-entrypoint.sh   # 容器入口（权限修复、密钥管理、降权运行）
```

## CI/CD

推送到 `main` 分支后，GitHub Actions 自动构建 Docker 镜像并推送到 `ghcr.io/asamiya-shiina/blog`，标签为 `latest` 和 commit SHA。

## License

MIT
