# Asamiya Shiina's Blog

轻量、自托管的个人博客。Express 5 + SQLite，原生 HTML/CSS/JS（无构建步骤），单镜像即跑。

## 功能

**前台**
- 首页（`/`）：个人介绍、技能树、联系方式
- 文章列表 / 详情 / 搜索 / 分类归档（服务端渲染，Markdown + GFM）
- 实时状态页（`/status`）：SSE 推送，多设备实时显示当前窗口
- 留言板（`/board`）：嵌套回复、头像、IP 属地（完整 IP 仅管理员可见）
- 可拖拽音乐播放器（管理员可在后台切歌）

**后台**（`/managers/`，仅全局管理员 `admin` 可达）
- 仪表盘、文章 CRUD（含分栏 Markdown 实时预览）、分类管理
- 用户与角色管理、SMTP 配置、音乐管理、实时状态配置（黑名单 / 应用名映射 / 标题规则）

> 管理接口（`/api/*`）对 admin / moderator 开放；但后台 HTML 面板入口已收紧为仅 `admin`。

**个人主页**（`/me/`，任意已登录用户）
- 头像上传（带校验）、名字、签名

**开放注册**（`/register`）
- 滑块验证 + 邮箱验证（站点配置 SMTP 时启用；未配置则直接激活）

**安全**
- HMAC-SHA256 Session（httpOnly + SameSite=Lax Cookie，1 年有效期；改密码 / 删用户自动吊销旧 token）
- bcrypt 哈希（cost 12，前端先 SHA-256 解决 72 字节限制）
- Zod 校验 + DOMPurify HTML 消毒
- 登录 / 注册 / 写入 / 搜索 / Setup 全链路速率限制
- CSP（script-src 'self'、style-src-attr 'none'）/ HSTS / nosniff / X-Frame-Options / Permissions-Policy
- 防用户名枚举、统一错误消息、关键操作审计日志
- 不使用任何 inline `<script>` / `onclick` / `style` 属性——所有交互走外置脚本，所有样式走 CSS 类，符合 CSP

## 角色权限

三档角色，从全局到普通用户：

| 角色 | 说明 | 后台面板 | 管理 API | 留言板完整 IP |
|---|---|---|---|---|
| `admin` | 全局管理员 | ✅ | ✅ | ✅ |
| `moderator` | 普通管理员 | ❌（入口仅 admin） | ✅ | ❌ |
| `user` | 普通用户 | ❌ | ❌ | ❌ |

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js 24 |
| 框架 | Express 5 |
| 数据库 | SQLite（better-sqlite3，WAL + 外键） |
| 认证 | HMAC-SHA256 + bcrypt |
| 校验 / 消毒 | Zod + DOMPurify |
| Markdown | marked |
| 邮件 | nodemailer（nodemailer + 加密落库的 SMTP 配置） |
| 定位 | geoip-lite（进程内 GeoIP，留言板属地） |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 |
| 部署 | Docker（read-only + gosu 降权） → ghcr.io |

## 快速开始

### Docker（推荐）

```yaml
# docker-compose.yml
services:
  blog:
    image: ghcr.io/asamiya-shiina/blog:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    environment:
      - NODE_ENV=production
```

```bash
docker compose up -d
```

首次访问 `http://localhost:3000` 会被引导到 `/setup/`，填写用户名和密码即可创建全局管理员账号。`SESSION_SECRET` 会在容器启动时自动生成并持久化到 `data/.session-secret`（重启容器不丢）。

> ⚠️ 上面的 compose 仅适合本地测试。生产部署请参考下文的「HTTPS、反代与 IP」，前置 Nginx / Caddy 反代并设 `TRUST_PROXY=1`，避免 cookie 与验证链接在网络上走错地址。

### 本地开发

```bash
git clone git@github.com:Asamiya-Shiina/blog.git
cd blog
npm install

echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# 文件变更自动重启
npm run dev
# 或生产模式
npm start
```

访问 `http://localhost:3000`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SESSION_SECRET` | Docker 自动生成 | — | Session 签名密钥；丢失会吊销所有已签发 token |
| `PORT` | 否 | `3000` | 监听端口 |
| `DB_PATH` | 否 | `./data/blog.sqlite` | SQLite 文件路径 |
| `NODE_ENV` | 否 | — | `production` 时错误响应只输出消息 |
| `TRUST_PROXY` | 否 | `false` | 反代层数（`true` / `false` / 数字 / `loopback`）；裸跑保持默认；前置 HTTPS 反代时设为 `1` |
| `COOKIE_SECURE` | 否 | 按 `req.secure` | 控制 cookie 是否带 Secure；不显式设时由 `req.secure` 自动判断 |
| `SITE_URL` | 否 | 自动 | 邮件验证链接用的站点根地址；生产设正式域名最稳（如 `https://yourblog.com`）。不设时自动跟随当前请求的协议 + Host（需反代 + `TRUST_PROXY=1`），否则回落 `http://localhost:$PORT` |

## HTTPS、反代与 IP

前置 Nginx / Caddy 做 HTTPS 反向代理时：

- **必须设 `TRUST_PROXY=1`**：让 Express 信任 `X-Forwarded-Proto`（感知外层 HTTPS，cookie 自动带 Secure）与 `X-Forwarded-For`（留言板 / 审计里的 IP 还原为访客真实公网 IP，而不是反代所在内网 IP）。
- 未设时留言板会显示反代的内网 IP（如 `192.168.1.x`），邮件链接也会回落 localhost。
- **安全前提**：开了 `TRUST_PROXY` 后，博客 `3000` 端口不应直接暴露公网，只允许反代访问，否则任何人可伪造 `X-Forwarded-For` 绕过限流。

### Cookie 行为

`COOKIE_SECURE` 不显式设置时，按当前请求是否 HTTPS 自动决定 cookie 是否带 Secure：

| 部署方式 | 是否需要改配置 |
|---|---|
| 本地 `npm run dev` 直连 `http://localhost:3000` | 无需配置，HTTP 正常登录 |
| 本地 `docker compose up` 裸跑（HTTP） | 无需配置，HTTP 正常登录 |
| **生产 HTTPS**（前置 Nginx / Caddy 反代） | 设 `TRUST_PROXY=1`，cookie 自动带 Secure |
| 生产纯 HTTP 部署 | **不推荐**——cookie 明文传输；如确需加 `COOKIE_SECURE=true`，但浏览器会拒绝在 HTTP 下回带 cookie，导致登录失败 |
| 内网 / NAS 仅本地访问 | 无需配置，HTTP 可用 |

### Nginx 反代示例

```nginx
server {
  listen 443 ssl;
  server_name yourblog.com;
  ssl_certificate     /etc/letsencrypt/live/yourblog.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourblog.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;              # 供邮件的 SITE_URL 自适应
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;  # 访客公网 IP
    proxy_set_header X-Forwarded-Proto $scheme;            # 关键：外层是 HTTPS
  }
}
```

### Caddy 反代示例（自动申请证书）

```caddyfile
yourblog.com {
  reverse_proxy localhost:3000
}
```

Caddy 的 `reverse_proxy` 默认已写入 `X-Forwarded-For` / `X-Forwarded-Proto` / `Host`，`TRUST_PROXY=1` 直接适用，无需额外配置。

## 项目结构

```
├── server.js                       # Express 入口（中间件、路由、监听）
├── docker-entrypoint.sh            # 容器入口：权限修复 + 密钥管理 + gosu 降权
├── index.html                      # 首页
├── image/                          # 前台静态图片
├── src/
│   ├── db.js                       # SQLite 初始化、建表、迁移
│   ├── auth.js                     # Session 签发 / 校验、密码哈希、角色
│   ├── audit.js                    # 审计日志（关键操作留痕 + 定期清理）
│   ├── captcha.js                  # 滑块验证（轨迹防绕过）
│   ├── crypto-box.js               # 对称加密（SMTP 密码落库）
│   ├── ip.js                       # IP 抽取 + GeoIP 属地
│   ├── mailer.js                   # SMTP 配置 + 邮件发送
│   ├── status-store.js             # 实时状态内存存储 + SSE 广播
│   ├── routes/
│   │   ├── auth.js                 # 登录、注册、用户管理、首次设置
│   │   ├── posts.js                # 文章 CRUD
│   │   ├── music.js                # 音乐管理 + 当前播放
│   │   ├── status.js               # 状态上报 / 配置 / SSE
│   │   ├── stats.js                # 访问统计
│   │   ├── categories.js           # 分类管理
│   │   └── messages.js             # 留言板
│   └── views/                      # 服务端渲染（无模板引擎，原生字符串拼接）
│       ├── posts.js
│       └── status-page.js
├── public/
│   ├── login/    setup/    register/    me/    board/
│   ├── managers/                        # 后台管理面板（含 smtp 子页）
│   └── site/                            # 前台公共样式与脚本
├── client/                             # Windows 状态上报客户端（PyInstaller 打包为 exe）
│   ├── status_client.py
│   └── 状态客户端.spec
└── data/                               # 运行时数据（volume 挂载）
    ├── blog.sqlite
    ├── .session-secret
    └── uploads/{music,avatars}/
```

## 部署细节

- 镜像以非 root 用户 `blog` 运行（`read_only: true`，仅 `/tmp` 与 `/app/data` 可写）
- `docker-entrypoint.sh` 处理 volume 权限、`SESSION_SECRET` 持久化、用 `gosu` 降权
- 首次启动自动建库、迁移、写入默认状态配置
- 任何请求在「无管理员」时统一重定向到 `/setup/`

## CI/CD

推送 `main` 后，GitHub Actions 自动构建镜像并推送到 `ghcr.io/asamiya-shiina/blog`，标签 `latest` 与 commit SHA。

## License

ISC