# Bluven CRM 部署与上线指南

版本：v1.0
日期：2026-11-10
读者：负责安装、上线和日常维护系统的人

---

## 1. 需要准备什么

| 项目 | 要求 |
|---|---|
| 服务器 | 一台 Linux 云服务器，建议 2 核 CPU、4 GB 内存起步，系统盘之外给资料留足空间（照片和 PDF 会持续增长，先按 100 GB 规划） |
| 软件 | Docker 和 Docker Compose 插件 |
| 域名 | 一个给 CRM 用的域名或子域名，例如 `crm.你的域名.com.au`，DNS 的 A 记录指向这台服务器 |
| 端口 | 对外开放 80 和 443 |
| 代码 | 本仓库 |

HTTPS 证书由系统自带的 Caddy 自动申请和续期，前提是域名已经解析到这台服务器，并且 80、443 端口可以从公网访问。

---

## 2. 第一次部署

在服务器上：

```bash
git clone https://github.com/DDuu123321/bluven-crm.git /opt/bluven-crm
cd /opt/bluven-crm
cp deploy/env.production.example .env
```

编辑 `.env`，至少填这几项：

| 变量 | 填什么 |
|---|---|
| `CRM_DOMAIN` | CRM 的域名，不带 `https://` |
| `POSTGRES_PASSWORD` | 数据库密码，只用字母和数字。可以用 `openssl rand -hex 24` 生成 |
| `SEED_ADMIN_EMAIL` | 第一个管理员的邮箱 |
| `SEED_ADMIN_NAME` | 管理员姓名 |
| `SEED_ADMIN_PASSWORD` | 临时密码，至少 10 位。第一次登录时系统会要求改掉 |

其余项可以先留空，见第 5 节。

启动：

```bash
docker compose up -d --build
```

第一次会构建镜像，需要几分钟。之后看状态：

```bash
docker compose ps                 # web、worker、db、caddy 应为 running，migrate 应为 exited (0)
docker compose logs -f web        # 看 web 日志
docker compose logs -f worker     # 看后台任务日志
```

浏览器打开 `https://你的域名`，用 `.env` 里的管理员邮箱和临时密码登录，按提示设置自己的密码。

`.env` 里有数据库密码等敏感信息，只留在服务器上，不要提交到仓库。

---

## 3. 上线前在系统里要做的设置

用管理员账号登录后，按顺序做：

1. **建用户。** Administration → Users → Add user。每个人一个账号，勾选角色：
   - Sales：销售，只看到自己的订单。
   - Manager：经理，看到全部订单，负责分派。
   - Finance：财务，确认定金。
   - Operations：运营，接收或退回订单。
   - Admin：管理员，管用户、线索来源和规则。
   
   一个人可以有多个角色。你给每个人设一个临时密码，当面或电话告诉对方，对方第一次登录时会被要求改密码。

2. **给 Bluven 网站发密钥。** Administration → Lead sources，找到 "Bluven website"，点 Issue token。密钥只显示这一次，复制下来交给改 Bluven 网站的人，连同 `docs/bluven-lead-forwarding-spec.md`。接口地址是 `https://你的域名/api/intake/leads`。

3. **检查交接清单。** Administration → Handoff checklist。默认必填：电费账单、安装位置照片、电表箱照片。地址完整、签字合同、定金已确认这三项是内置的，始终必填。可以按需要增减资料类型。

4. **检查丢单原因。** Administration → Lost reasons。默认给了十个，可以增删改。

5. **检查规则。** Administration → Rules。默认 5 天提醒销售、10 天提醒经理、15 天回池，定金建议比例 10%。

6. **接 Pylon（可选）。** 见第 4 节。不接也能用，报价和合同由销售手动录入和上传。

---

## 4. 接入 Pylon

Pylon 那边，进入 Settings → Integrations & API → API settings：

1. 点 Create API token，权限选 read。把得到的 token 填进服务器 `.env` 的 `PYLON_API_TOKEN`。
2. 点 Add a destination，URL 填 `https://你的域名/api/webhooks/pylon`，勾选这六类事件：
   `solar_projects.created`、`solar_projects.updated`、`solar_designs.created`、`solar_designs.updated`、`web_proposals.signed`、`gateway_payments.created`。
3. Pylon 会显示一次 secret，把它填进 `.env` 的 `PYLON_WEBHOOK_SECRET`。

然后在服务器上让新配置生效：

```bash
docker compose up -d
```

回到 CRM 的 Administration → Pylon，"Connection" 一栏两项都应显示 Configured。这个页面也列出最近收到的事件和处理结果，失败的可以点 Try again。

接好之后的效果：

- 销售在订单的 "Quote, contract & deposit" 页点 Design in Pylon，Pylon 会带着客户信息和 CRM 订单号打开。**订单号就是两边对账的依据，不要在 Pylon 里改项目的 reference number。**
- Pylon 里每做一版设计，CRM 自动出现一个报价版本。这一步不改变订单阶段。
- 客户在 Pylon 网页上签字，CRM 自动把签字 PDF 归档，订单变为 Signed。
- 客户通过 Pylon 支付网关付定金，CRM 自动生成一条待财务确认的定金。

说明：Pylon 对接是按 Pylon 的开发者文档实现的，并用模拟数据测试过，但还没有连过真实的 Pylon 账号。第一次接通后，请先用一张测试订单走一遍，在 Administration → Pylon 页面确认事件都是 Done。如果出现 Failed，把页面上的错误信息发给开发者。

---

## 5. 可选配置

### 通知邮件

系统内的通知始终有效。如果还想让通知同时发到邮箱，在 `.env` 里填 `SMTP_URL` 和 `MAIL_FROM`，然后 `docker compose up -d`。

用 Zoho 澳洲站点的例子：

```
SMTP_URL=smtps://crm%40你的域名.com.au:应用专用密码@smtp.zoho.com.au:465
MAIL_FROM=Bluven CRM <crm@你的域名.com.au>
```

邮箱里的 `@` 在这里要写成 `%40`。建议在 Zoho 里为这个发信账号生成应用专用密码。

通知产生两分钟后才发邮件；如果这期间对方已经在系统里看过了，就不再发。

### 时区和上传上限

`APP_TIMEZONE` 默认 `Australia/Sydney`，决定界面上的日期时间和"今天"是哪一天。`MAX_UPLOAD_MB` 默认 500，是单个文件的上限。如果调大，同时把 `deploy/Caddyfile` 里的 `max_size` 调到比它略大。

---

## 6. 备份与恢复

数据在两个地方：数据库（Docker 卷 `db-data`）和上传的资料（Docker 卷 `storage`）。两个都要备份。

### 备份

```bash
cd /opt/bluven-crm
./deploy/backup.sh            # 备份到 ./backups，默认保留 14 天
```

建议用 cron 每晚跑一次：

```
15 2 * * *  cd /opt/bluven-crm && ./deploy/backup.sh >> backups/backup.log 2>&1
```

**备份文件留在同一台服务器上是不够的。** 再用 rsync 或云存储工具把 `backups` 目录同步到别处。

### 恢复

恢复会覆盖现有数据。先停掉 web，让没有人在写数据，恢复完再启动：

```bash
docker compose stop web

# 数据库
docker compose exec -T db pg_restore -U bluven -d bluven --clean --if-exists < backups/db-时间戳.dump

# 资料
docker compose exec -T worker tar -C /data -xzf - < backups/storage-时间戳.tar.gz

docker compose restart worker
docker compose start web
```

数据库和资料要用同一次备份的两个文件，时间戳相同。恢复演练至少做一次，确认备份真的能用。

---

## 7. 升级

```bash
cd /opt/bluven-crm
./deploy/backup.sh                 # 先备份
git pull
docker compose up -d --build       # 重新构建并启动；数据库结构变更会自动执行
docker compose ps
```

`migrate` 这个一次性容器负责数据库结构升级，它成功退出后 web 和 worker 才会启动。

---

## 8. 日常检查

| 看什么 | 怎么看 | 正常的样子 |
|---|---|---|
| 服务是否都在 | `docker compose ps` | web、worker、db、caddy 都是 running |
| 网站是否活着 | 浏览器打开 `https://你的域名/api/intake/health` | 显示 `{"ok":true}` |
| 后台任务 | `docker compose logs --since 1h worker` | 有提醒、回池、Pylon 事件时才有日志，没有报错 |
| Pylon 事件 | CRM 的 Administration → Pylon | 没有 Failed，最近收到事件的时间合理 |
| 磁盘空间 | `df -h` | 留有余量 |

worker 负责的事：闲置 5 / 10 / 15 天的提醒和回池、暂缓到期自动恢复、待办到期提醒、通知邮件、处理 Pylon 事件。**worker 不在运行时这些都不会发生**，但不影响大家正常使用系统，恢复运行后会补上。

---

## 9. 常见问题

**打不开网站，或者证书错误。**
确认域名已解析到这台服务器，80 和 443 端口对公网开放，然后看 `docker compose logs caddy`。

**登录后马上又被退回登录页。**
`CRM_DOMAIN` 和实际访问的域名不一致，或者不是通过 HTTPS 访问。系统只在 HTTPS 下发放登录凭证。

**忘记密码。**
管理员在 Administration → Users 里点 Reset password，设一个新的临时密码。如果唯一的管理员自己忘了密码，在服务器上执行下面的命令给他设一个临时密码，登录后系统会要求改掉：

```bash
cd /opt/bluven-crm
docker compose run --rm migrate sh -c 'cd /repo/packages/core && node --import tsx src/cli/reset-password.ts 管理员邮箱 "临时密码至少10位"'
```

**Bluven 推送线索返回 401。**
密钥不对或者该来源被停用。在 Administration → Lead sources 检查，必要时 Rotate token 重新发一把，旧密钥还能再用 7 天。

**上传大文件失败。**
检查 `MAX_UPLOAD_MB` 和 `deploy/Caddyfile` 里的 `max_size`，以及磁盘空间。

**想看某张订单谁改过什么。**
经理打开订单的 History 标签页，或者在 Administration → Audit log 按订单号搜索，可以导出 CSV。
