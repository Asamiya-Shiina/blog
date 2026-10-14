# Asamiya-Shiina's Blog

轻量、自托管的个人博客系统。Express 5 + SQLite，原生 HTML/CSS/JS（无构建步骤），单镜像即可运行。

---

## 功能一览

### 前台

| 页面 | 路由 | 说明 |
|---|---|---|
| 首页 | `/` | 个人介绍、技能树、联系方式、今日浏览人数 |
| 文章列表 | `/posts` | 已发布文章列表，支持分类筛选 |
| 文章详情 | `/posts/:slug` | Markdown 渲染，支持 GFM |
| 搜索 | `/search` | 全文搜索，30 秒内最多 10 次 |
| 实时状态 | `/status` | SSE 推送，多设备实时显示前台窗口 |
| 留言板 | `/board` | 回复嵌套显示、IP 属地、头像 |
| 音乐播放器 | — | 可拖拽浮窗，管理员可在后台切歌 |

### 后台（`/managers/`，仅 `admin` 可达）

文章管理、分类管理、用户管理、SMTP 配置、音乐管理、实时状态配置（黑名单 / 应用名映射 / 标题规则）、仪表盘（含今日 UV）

### 个人主页（`/me/`，任意已登录用户）

头像上传（仅 JPG，≤200KB，magic-byte 校验）、昵称、签名

### 开放注册（`/register`）

滑块验证码 + 邮箱验证，注册时不设密码，由本人通过邮件链接自主设置（防账号预劫持）。

---

## 安全设计

**认证与会话**
- HMAC-SHA256 Session（httpOnly + SameSite=Lax Cookie，1 年有效期）
- 会话吊销基于单调递增的**世代号**（`users.session_epoch`），登出 / 改密码立即失效
- bcrypt 哈希（cost 12）；密码经 SHA-256 预处理绕过 72 字节限制
- 密码强度校验在服务端对明文执行，不接受预哈希值

**防御**
- Zod 输入校验 + DOMPurify HTML 消毒（全站唯一消毒入口）
- 全链路速率限制（登录 5 次 /15min，注册 5 次 /hr 按邮箱 + 30 次 /15min 按 IP，搜索 10 次 /30s，写操作 30 次 /15min 等）
- 上传走 busboy 流式解析：超限立即断流，不缓冲整个请求体
- CSP（禁止内联脚本、内联样式、`data:` 以外的所有外部资源）
- HMAC 密钥强度校验（拒绝占位符 / 低熵 / 重复字符）
- 邮箱域名白名单（主流个人邮箱，企业邮箱与一次性域名 422 拒绝）
- SMTP 密码 AES-256-GCM 加密落库，密钥由 SESSION_SECRET 派生
- 审计日志（关键操作留痕，保留 90 天，10 万行硬上限）

**上传安全**
- 头像：仅接受 JPG，内容 magic-byte 校验（防文件头欺骗）
- 音乐：magic-byte 校验，不接受非音频文件
- 磁盘文件名使用 UUID，目录遍历不可能

**桌面客户端**（`client/`，可选）

Windows 托盘应用，每 5 秒上报前台窗口 / 进程名 / 标题到 `/api/data`，支持闲置检测与黑名单过滤。

---

## 角色权限

| 角色 | 后台面板 | 管理 API | 留言板完整 IP |
|---|---|---|---|
| `admin` | ✅ | ✅ | ✅ |
| `moderator` | ❌ | ✅ | ❌ |
| `user` | ❌ | ❌ | ❌ |

> 桌面客户端仅在 admin 账号下启用。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js 24 |
| 框架 | Express 5 |
| 数据库 | SQLite（better-sqlite3，WAL + 外键约束） |
| 认证 | HMAC-SHA256 + bcrypt |
| 校验 / 消毒 | Zod + DOMPurify |
| Markdown | marked |
| 邮件 | nodemailer |
| 上传 | busboy（流式） |
| IP 属地 | geoip-lite（惰性加载，可通过 `ENABLE_GEOIP=false` 关闭） |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 |
| 桌面客户端 | Python 3 + Tkinter + PyInstaller |
| 部署 | Docker（read-only + gosu 降权） → ghcr.io |

---

## 快速开始

### Docker（推荐）

```bash
# 克隆
git clone git@github.com:Asamiya-Shiina/blog.git
cd blog

# 首次启动会自动建库并写入默认配置
docker compose up -d

# 访问 http://localhost:3000，被引导到 /setup/ 创建管理员账号
```

> ⚠️ 开放注册前需在后台配置 SMTP（管理面板 → SMTP）。未配置时 `/api/register` 明确返回 503。

> ⚠️ 生产部署请参考后文「HTTPS 与反代」，需要设置 `TRUST_PROXY=1` + `SITE_URL`。

### 本地开发

```bash
git clone git@github.com:Asamiya-Shiina/blog.git
cd blog
npm install

# 生成随机密钥
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# 开发模式（文件变更自动重启）
npm run dev
# 或直接运行
npm start
```

### 状态上报客户端（可选，需 Windows）

```bash
cd client
pip install requests pywin32 pystray pillow

# 以源码运行（调试用）
python status_client.py

# 打包为单文件 exe（产物在 client/dist/状态客户端.exe）
pyinstaller "状态客户端.spec"
```

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SESSION_SECRET` | **生产必填** | — | Session 签名密钥，同时派生 SMTP 密码加密密钥。丢失会吊销所有 token，并使已保存的 SMTP 密码无法解密 |
| `PORT` | 否 | `3000` | 监听端口 |
| `DB_PATH` | 否 | `./data/blog.sqlite` | SQLite 文件路径 |
| `NODE_ENV` | 否 | — | `production` 时错误响应只返回通用消息 |
| `TRUST_PROXY` | 否 | `false` | 反代层数（`true`/`false`/数字/`loopback`）；前置 HTTPS 反代时设为 `1` |
| `COOKIE_SECURE` | 否 | 自动判断 | 显式控制 cookie Secure 标志；不设时由当前请求是否 HTTPS 自动决定 |
| `SITE_URL` | **生产必填** | 自动 | 邮件验证链接的站点根地址（如 `https://yourblog.com`）。不设时邮件链接回落请求的 Host 头，可被攻击者伪造 |
| `ALLOWED_HOSTS` | 否 | — | 未设 `SITE_URL` 时的 Host 白名单（逗号分隔，含端口） |
| `ENABLE_GEOIP` | 否 | 开启 | 设为 `false`/`0`/`no`/`off` 关闭 IP 属地解析。geoip-lite 整库常驻约 100MB，512MB 容器建议关闭 |

---

## HTTPS 与反代

**必须设置 `TRUST_PROXY=1`**，让 Express 信任 `X-Forwarded-Proto` 与 `X-Forwarded-For`，否则：
- 留言板会显示反代的内网 IP
- 邮件验证链接回落 localhost
- cookie 不带 Secure 标志，HTTPS 登录后 HTTP 请求无法带 cookie

`TRUST_PROXY=1` 的前提：**博客 3000 端口不应直接暴露公网**，只允许反代访问，否则任何人可伪造 `X-Forwarded-For` 绕过速率限制。

### Nginx 示例

```nginx
server {
  listen 443 ssl;
  server_name yourblog.com;
  ssl_certificate     /etc/letsencrypt/live/yourblog.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourblog.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Caddy 示例（自动申请证书）

```caddyfile
yourblog.com {
  reverse_proxy localhost:3000
}
```

Caddy 的 `reverse_proxy` 默认已写入所需头部，`TRUST_PROXY=1` 直接适用。

---

## 项目结构

```
├── server.js                    # Express 入口：中间件链、路由注册、启动
├── docker-entrypoint.sh         # 容器入口：权限修复 + 密钥管理 + gosu 降权
├── Dockerfile                   # 多阶段构建（node:24-slim，gosu 降权 + 非 root）
├── docker-compose.yml           # read-only + tmpfs + 512M 内存限额
├── package.json
├── src/
│   ├── db.js                    # SQLite 初始化、建表、迁移
│   ├── auth.js                  # Session 签发/校验、密码哈希、世代号吊销、角色鉴权
│   ├── audit.js                 # 审计日志写入 + 定期清理（90d / 10 万行上限）
│   ├── captcha.js               # 滑块验证（轨迹人类性校验，防脚本绕过）
│   ├── crypto-box.js            # AES-256-GCM 加密/解密（SMTP 密码落库）
│   ├── email-policy.js          # 注册邮箱域名白名单
│   ├── ip.js                    # IP 抽取 + GeoIP 属地（惰性加载）
│   ├── mailer.js                # SMTP 配置读取 + nodemailer 邮件发送
│   ├── upload.js                # busboy 流式 multipart 解析（超限立即断流）
│   ├── status-store.js          # 实时状态内存存储 + SSE 广播
│   ├── avatar-sweep.js          # 24h 周期：孤儿头像/音乐清理 + WAL checkpoint
│   ├── db-sweep.js              # 6h 周期：page_views 30d 清理 + 过期 pending 用户
│   ├── routes/
│   │   ├── auth.js              # 登录、注册、邮箱验证、用户管理、首次设置
│   │   ├── posts.js             # 文章 CRUD
│   │   ├── categories.js        # 分类管理（列表/新建/重命名/删除）
│   │   ├── music.js             # 音乐管理 + 当前播放
│   │   ├── status.js            # 状态上报 / SSE / 管理配置
│   │   ├── stats.js             # 访问统计
│   │   └── messages.js          # 留言板（游标分页 + 属地）
│   └── views/
│       ├── posts.js             # 服务端渲染（文章列表/详情/搜索/提示页）+ 全站唯一 Markdown 消毒入口
│       └── status-page.js       # 状态页渲染
├── public/
│   ├── index/                   # 首页
│   ├── login/                   # 登录页
│   ├── setup/                   # 首次引导页
│   ├── register/                # 注册页
│   ├── verify/                  # 邮箱验证页
│   ├── me/                      # 个人主页
│   ├── board/                   # 留言板
│   ├── managers/                # 后台管理面板
│   └── site/                    # 前台公共样式与脚本
├── client/                      # Windows 状态上报客户端
│   ├── status_client.py         # 单实例托盘 + 窗口采样 + 闲置检测
│   └── 状态客户端.spec          # PyInstaller 配置
└── data/                        # 运行时数据（volume 挂载）
    ├── blog.sqlite
    ├── .session-secret
    └── uploads/{music,avatars}/
```

---

## CI/CD

推送 `main` 后，GitHub Actions 自动构建镜像并推送到 `ghcr.io/asamiya-shiina/blog`。

> ✅ workflow 全部 4 个 action（checkout / login-action / setup-buildx-action / build-push-action）均已固定到 commit SHA 并以 `# vN` 注释保留版本号，上游 tag 被恶意重写不影响构建。升级时用 `pin-github-actions` 同步即可。

---

## License

ISC
