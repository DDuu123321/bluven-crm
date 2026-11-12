# Bluven CRM 部署与上线指南

版本：v1.1
日期：2026-11-11
读者：负责安装、上线和日常维护系统的人

---

## 1. 总览

### 地址

CRM 的地址是 **`https://crm.bluven.com.au`**。它和网站用同一个域名，做法与网站后台完全一样：

| 地址 | 是什么 | 跑在哪 |
|---|---|---|
| `www.bluven.com.au` | 网站 | Netlify |
| `cms.bluven.com.au` | 网站后台（Payload） | Railway |
| `crm.bluven.com.au` | CRM（本系统） | 见下面两种方式 |

只需要在管理 `bluven.com.au` DNS 的地方加一条 `crm` 记录，不用买新域名，也不影响网站。

CRM 不放在 `www.bluven.com.au/某个路径` 下面，原因有两个：网站在 Netlify 上，Netlify 转发不了几百 MB 的资料上传；内部系统和对外网站共用一个地址，网站上任何一处脚本漏洞都可能波及 CRM 的登录状态。

### 两种部署方式

| | 方式 A：Railway | 方式 B：自己的服务器 |
|---|---|---|
| 适合 | 已经在用 Railway 跑网站后台，想全部在网页上点完 | 有一台 Linux 服务器，愿意用命令行 |
| 怎么部署 | 连接 GitHub 仓库，推送代码即自动部署 | `docker compose up -d --build` |
| HTTPS 证书 | Railway 自动签发 | 自带的 Caddy 自动签发 |
| 资料存在哪 | Railway 磁盘（Volume），可在线扩容 | 服务器磁盘 |
| 备份 | Railway 面板里开启定时备份 | `deploy/backup.sh` 加 cron |
| 外发邮件 | Railway 屏蔽 SMTP，通过网站的邮件中继发送 | 直接 SMTP，或同样走中继 |
| 单个文件上传 | 须在 5 分钟内传完（Railway 的限制） | 默认上限 500 MB |

**建议用方式 A。** 你们的网站后台已经在 Railway 上，账号、操作习惯和排错经验都可以直接沿用。

### 哪些实测过，哪些没有

- 两种方式用的镜像都在 Docker 里构建并运行过：数据库迁移、登录、接线索、上传与缩略图、从网站拉线索、备份、恢复、命令行重置密码。
- 方式 B 的整套 Compose（含 Caddy 的 HTTPS）在本机完整跑过。
- 方式 A 用的单容器镜像在本机按 Railway 的条件跑过（平台指定端口、磁盘属主为 root、外部 Postgres）。**但没有在 Railway 平台本身部署过**，第 2 节的页面步骤是按 Railway 2026 年 11 月的官方文档写的，按钮名称可能略有出入。
- Pylon 已用真实账号只读验证过（见第 6 节）。正式域名的证书签发没有做过。客户邮件（第 7 节）是对着一个替身 Zoho 服务测的，没有连过真实的 Zoho 账号。AI 助手（第 8 节）是对着一个替身模型服务测的，没有用真实密钥调用过。从网站拉线索是对着一个按网站代码写的替身接口测的，没有连过真实的 `cms.bluven.com.au`；邮件中继同样是对着替身测的。

---

## 2. 方式 A：部署到 Railway

步骤和当初部署网站后台（`cms.bluven.com.au`）基本相同。全程在网页上操作。

### 2.1 从 GitHub 创建服务

1. 打开 Railway，进入放网站后台的那个项目（放在同一个项目里最方便，也可以新建项目）。
2. 点 **+ Create** → **GitHub Repo** → 选 `DDuu123321/bluven-crm`。如果列表里没有，按提示在 GitHub 授权页把这个仓库勾上。
3. 在服务的 **Settings → Source** 里确认分支。**Root Directory 留空**：仓库根目录有 `Dockerfile`，Railway 会自动用它构建，构建日志里会出现 "Using detected Dockerfile"。
4. 构建、启动命令都不用填。镜像启动时会自己完成三件事：升级数据库结构、写入基础数据和第一个管理员、同时启动网页服务和后台任务。

第一次构建会失败或起不来，因为还没有数据库和变量，继续往下做。

### 2.2 添加 PostgreSQL

项目画布上点 **+ Create → Database → Add PostgreSQL**，等它变绿。

CRM 用自己独立的数据库，**不要和网站后台共用同一个 Postgres**。

### 2.3 添加磁盘

资料（照片、合同、账单）存在磁盘上。不加磁盘的话，每次重新部署文件都会丢。

1. 点 CRM 服务卡片，右键或在 **Settings** 里找到 **Volume**，添加一块磁盘。
2. **Mount path 填 `/data`**。
3. 容量先用默认的，之后可以在线扩容，不需要停机。Hobby 计划默认 5 GB，Pro 默认 50 GB，Pro 可自助扩到 1 TB。

不需要设置 `RAILWAY_RUN_UID`。镜像启动时会自己把磁盘交给应用使用。

### 2.4 填变量

CRM 服务 → **Variables** → **Raw Editor**，粘贴下面整块，把 `<...>` 换成真实值：

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://crm.bluven.com.au
PORT=3000
APP_TIMEZONE=Australia/Sydney
MAX_UPLOAD_MB=200

SEED_ADMIN_EMAIL=<第一个管理员的邮箱>
SEED_ADMIN_NAME=<管理员姓名>
SEED_ADMIN_PASSWORD=<临时密码，至少 10 位，第一次登录会被要求改掉>

BLUVEN_LEADS_URL=https://cms.bluven.com.au/api/crm/leads
BLUVEN_LEADS_KEY=<见第 4 节>

MAIL_RELAY_URL=<见第 9 节，可先留空>
MAIL_RELAY_KEY=<见第 9 节，可先留空>

PYLON_API_TOKEN=
PYLON_WEBHOOK_SECRET=

ZOHO_CLIENT_ID=<见第 7 节，可先留空>
ZOHO_CLIENT_SECRET=<见第 7 节，可先留空>

ANTHROPIC_API_KEY=<见第 8 节，可先留空>
```

要点：

- `DATABASE_URL=${{Postgres.DATABASE_URL}}` 原样粘贴。如果数据库服务的名字不是 `Postgres`，把花括号里的名字改成它的名字。
- `APP_URL` 填最终的正式地址。它用于通知邮件里的链接。
- `PORT=3000` 要和下一步生成域名时选的端口一致。
- 这些值只填在 Railway 的 Variables 里，不要写进代码或文档。

保存后 Railway 会自动重新部署。

### 2.5 生成临时域名并测试

1. 服务 → **Settings → Networking → Public Networking** → **Generate Domain**，端口选 `3000`，得到 `xxxx.up.railway.app`。
2. （推荐）同一页的 **Healthcheck Path** 填 `/api/intake/health`，这样 Railway 会等新版本真正起来才切换。
3. 看 **Deployments** 里最新一次的日志，成功的标志依次是：
   - `[start] database migrations`，后面是 `All migrations have been successfully applied.`
   - `[start] reference data`，后面是 `Created the first admin account: ...`
   - `[start] web server on port 3000, worker running; files in /data/storage`
   - `worker started (...)`
4. 浏览器打开 `https://xxxx.up.railway.app/api/intake/health`，应显示 `{"ok":true}`。
5. 打开 `https://xxxx.up.railway.app`，用变量里的管理员邮箱和临时密码登录，按提示设置自己的密码。
6. 随便建一条线索，在 Documents 页上传一张照片，确认能看到缩略图。然后在 Railway 里手动 Redeploy 一次，回来看照片还在不在。在，说明文件确实存进了磁盘。

登录成功后，可以把 `SEED_ADMIN_PASSWORD` 这个变量删掉。它只在数据库里一个用户都没有时才起作用。

### 2.6 绑定 crm.bluven.com.au

1. 服务 → **Settings → Networking → Public Networking** → **+ Custom Domain**，填 `crm.bluven.com.au`，端口选 `3000`。
2. Railway 会显示要添加的 DNS 记录，现在是**两条**：一条 `CNAME`，一条用于验证归属的 `TXT`。**两条都要加**，只加 CNAME 的话域名会一直 404。
3. 到管理 `bluven.com.au` DNS 的地方，也就是当初添加 `cms` 记录的那个面板，把这两条记录原样加上。
4. 如果 DNS 在 Cloudflare：按 Railway 页面当时的提示设置代理开关。Railway 目前的说明是一级子域名可以开代理（橙色云），SSL/TLS 模式选 **Full**。
5. 等 Railway 页面上的状态变绿，证书会自动签发，一般一小时内完成。
6. 打开 `https://crm.bluven.com.au` 登录确认。

### 2.7 开启备份

数据在两个地方：Postgres 的数据库和 CRM 服务的磁盘。两个都要备份。

在 Railway 里分别打开 Postgres 服务和 CRM 服务的 **Backups** 页，各开一个每天的定时备份。恢复也在同一页操作。

**至少演练一次恢复**，确认备份真的能用。恢复数据库和恢复磁盘要选同一天的备份。

### 2.8 升级

把新代码推送到 Railway 跟踪的分支，Railway 会自动重新构建并部署。数据库结构的变更在新版本启动时自动执行。

因为挂了磁盘，重新部署时会有几十秒的中断（Railway 不允许新旧两个版本同时挂同一块磁盘）。挑没人用的时间推送。

### 2.9 在 Railway 上要知道的几件事

- **上传。** Railway 要求一个请求的上传部分在 5 分钟内完成。照片和 PDF 没问题，几百 MB 的视频在慢网络下可能失败，所以上面把 `MAX_UPLOAD_MB` 设成了 200。
- **邮件。** Railway 屏蔽了外发 SMTP（网站后台已经踩过这个坑），CRM 的通知邮件要通过网站的邮件中继发送，见第 9 节。客户邮件（第 7 节）走的是 Zoho 的网页接口，不受这个限制。系统内的通知不受影响。
- **只能跑一个副本。** 挂了磁盘的服务不能开多副本，CRM 也不需要。
- **进程。** 网页服务和后台任务在同一个容器里。任何一个意外退出，容器都会退出并由 Railway 重启。

---

## 3. 方式 B：部署到自己的服务器

### 3.1 需要准备什么

| 项目 | 要求 |
|---|---|
| 服务器 | 一台 Linux 云服务器，建议 2 核 CPU、4 GB 内存起步，给资料留足空间（先按 100 GB 规划） |
| 软件 | Docker 和 Docker Compose 插件 |
| DNS | 在管理 `bluven.com.au` 的地方加一条 A 记录：主机名 `crm`，指向这台服务器的 IP |
| 端口 | 对外开放 80 和 443 |

HTTPS 证书由自带的 Caddy 自动申请和续期，前提是 `crm.bluven.com.au` 已经解析到这台服务器，并且 80、443 端口可以从公网访问。如果 DNS 在 Cloudflare，这条记录用"仅 DNS"（灰色云）。

如果不用自带的 Caddy 而换成别的反向代理，请让它把访客的真实地址写进 `X-Real-IP` 请求头，并覆盖访客自己带来的值。CRM 用这个地址做登录限流和操作日志。自带的 Caddy 和 Railway 都已经这样做了。

### 3.2 第一次部署

```bash
git clone https://github.com/DDuu123321/bluven-crm.git /opt/bluven-crm
cd /opt/bluven-crm
cp deploy/env.production.example .env
```

编辑 `.env`，至少填这几项：

| 变量 | 填什么 |
|---|---|
| `CRM_DOMAIN` | `crm.bluven.com.au`（模板里已填好） |
| `POSTGRES_PASSWORD` | 数据库密码，只用字母和数字。可以用 `openssl rand -hex 24` 生成 |
| `SEED_ADMIN_EMAIL` | 第一个管理员的邮箱 |
| `SEED_ADMIN_NAME` | 管理员姓名 |
| `SEED_ADMIN_PASSWORD` | 临时密码，至少 10 位。第一次登录时系统会要求改掉 |

其余项见第 4、6、7 节。

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

浏览器打开 `https://crm.bluven.com.au`，用 `.env` 里的管理员邮箱和临时密码登录，按提示设置自己的密码。

`.env` 里有数据库密码等敏感信息，只留在服务器上，不要提交到仓库。

### 3.3 备份与恢复

数据在两个地方：数据库（Docker 卷 `db-data`）和上传的资料（Docker 卷 `storage`）。两个都要备份。

```bash
cd /opt/bluven-crm
./deploy/backup.sh            # 备份到 ./backups，默认保留 14 天
```

建议用 cron 每晚跑一次：

```
15 2 * * *  cd /opt/bluven-crm && ./deploy/backup.sh >> backups/backup.log 2>&1
```

**备份文件留在同一台服务器上是不够的。** 再用 rsync 或云存储工具把 `backups` 目录同步到别处。

恢复会覆盖现有数据。先停掉 web 和 worker，恢复完再启动：

```bash
docker compose stop web worker

# 数据库
docker compose exec -T db pg_restore -U bluven -d bluven --clean --if-exists < backups/db-时间戳.dump

# 资料
docker compose run --rm -T --no-deps worker tar -C /data -xzf - < backups/storage-时间戳.tar.gz

docker compose start worker web
```

数据库和资料要用同一次备份的两个文件，时间戳相同。恢复演练至少做一次。在一台全新的服务器上恢复：先按 3.2 把系统启动起来，再执行上面的步骤。

### 3.4 升级

```bash
cd /opt/bluven-crm
./deploy/backup.sh                 # 先备份
git pull
docker compose up -d --build       # 重新构建并启动；数据库结构变更会自动执行
docker compose ps
```

`migrate` 这个一次性容器负责数据库结构升级，它成功退出后 web 和 worker 才会启动。

---

## 4. 接通网站线索

网站后台已经准备好了一个给 CRM 取线索的接口（`cms.bluven.com.au/api/crm/leads`），CRM 每分钟去取一次。**网站的代码一行都不用改**，两边填同一把密钥即可。

1. 生成一把密钥。在自己电脑上运行：

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **网站后台这边**：Railway → 网站后台（CMS）服务 → Variables，把 `CRM_SYNC_KEY` 设成这把密钥。保存后它会自动重新部署。
3. **CRM 这边**：把 `BLUVEN_LEADS_KEY` 设成同一把密钥，`BLUVEN_LEADS_URL` 设成 `https://cms.bluven.com.au/api/crm/leads`。方式 A 填在 Railway 的 Variables 里，方式 B 填在 `.env` 里然后 `docker compose up -d`。
4. 登录 CRM，打开 Administration → Lead sources。最上面的 "Bluven website" 应显示绿色的 **Connected** 和最近一次检查的时间。显示红色 Failing 时，旁边会写明原因，例如密钥不一致。
5. 在网站上提交一条测试询价，一两分钟内它会出现在 CRM 的 Unassigned leads 里。

要知道的几点：

- **从接通那一刻开始取。** 接通之前网站上已有的线索不会进来。如果想把一段时间以来的旧线索也带进来，在第一次启动前设置 `BLUVEN_LEADS_SINCE`，例如 `2026-07-01T00:00:00+10:00`。这些旧线索作为"历史"进入：不进未分派池，不发通知，在 Unassigned leads 页的 Imported history 里查看。其中某个人之后再次询价时，会自动转入未分派池。
- **不会丢，也不会重复。** 网站自己保存着每条线索。CRM 停机期间的线索，恢复后下一分钟就会补上。同一条线索只会进来一次。
- **连续失败会提醒。** 连续 5 次取不到时，管理员会收到一条通知。
- **目前带过来的信息比较少。** 网站这个接口现在只给联系方式、地址和感兴趣的产品，不带电费、时间计划、备注等。想带全，需要在网站后台改十几行，写法见 `docs/bluven-lead-forwarding-spec.md`。改不改都不影响上线。

---

## 5. 上线前在系统里要做的设置

用管理员账号登录后，按顺序做：

1. **建用户。** Administration → Users → Add user。每个人一个账号，勾选角色：
   - Sales：销售，只看到自己的订单。
   - Manager：经理，看到全部订单，负责分派。
   - Finance：财务，确认定金。
   - Operations：运营，接收或退回订单。
   - Admin：管理员，管用户、线索来源和规则。

   一个人可以有多个角色。你给每个人设一个临时密码，当面或电话告诉对方，对方第一次登录时会被要求改密码。

2. **确认网站线索已接通。** Administration → Lead sources，见第 4 节。

3. **检查交接清单。** Administration → Handoff checklist。默认必填：电费账单、安装位置照片、电表箱照片。地址完整、签字合同、定金已确认这三项是内置的，始终必填。可以按需要增减资料类型。

4. **检查丢单原因。** Administration → Lost reasons。默认给了十个，可以增删改。

5. **检查规则。** Administration → Rules。默认 5 天提醒销售、10 天提醒经理、15 天回池，定金建议比例 10%。

6. **接 Pylon（可选）。** 见第 6 节。不接也能用，报价和合同由销售手动录入和上传。

7. **接客户邮件（可选）。** 见第 7 节。不接也能用，只是和客户的邮件往来不会出现在订单里。

8. **开启 AI 助手（可选）。** 见第 8 节。不开也能用，只是没有总结、回信草稿、附件识别、账单读取和交接简报。

---

## 6. 接入 Pylon

Pylon 那边，进入 Settings → Integrations & API → API settings：

1. 点 Create API token，权限选 Read。把得到的 token 填进 `PYLON_API_TOKEN`。**只做这一步，Pylon 对接就能用了**：CRM 每分钟去 Pylon 读一次新事件。
   **token 只在创建成功的那一刻显示一次**，是一长串字符，当场复制下来。关掉之后页面上只剩名称，再也看不到，Pylon 发来的通知邮件里也没有。没来得及复制的话，再建一个新的，然后在旧的那一行点右侧的 ⋮ 把它删掉。
2. 可选，想让事件几秒内到达再做：点 Add a destination，URL 填 `https://crm.bluven.com.au/api/webhooks/pylon`，勾选这六类事件：
   `solar_projects.created`、`solar_projects.updated`、`solar_designs.created`、`solar_designs.updated`、`web_proposals.signed`、`gateway_payments.created`。
   Pylon 会显示一次 secret，把它填进 `PYLON_WEBHOOK_SECRET`，同样只显示一次，当场复制。这一步要等 CRM 已经部署在上面那个地址之后才能做。不做也不影响功能，事件会在一分钟内到达。

变量填在哪：方式 A 是 Railway 的 Variables，保存后自动生效；方式 B 是服务器的 `.env`，然后执行 `docker compose up -d`。

回到 CRM 的 Administration → Pylon，"Connection" 一栏的 API token 应显示 Configured，"Reading Pylon’s events" 应显示最近一次读取的时间。这个页面也列出与订单有关的事件和处理结果，失败的可以点 Try again。

接好之后的效果：

- 销售在订单的 "Quote, contract & deposit" 页点 Design in Pylon，Pylon 会带着客户信息和 CRM 订单号打开。**订单号就是两边对账的依据，不要在 Pylon 里改项目的 reference number。**
- 项目已经在 Pylon 里、当初没带订单号的：在同一页点 Link Pylon project，粘贴这个项目在 Pylon 里的地址（浏览器地址栏里 `https://app.getpylon.com/library/...` 那一串），先点 Check 核对客户和地址，再点 Link project。它已有的设计会立刻变成报价版本；客户已经签过字的，签字 PDF 直接归档为合同。
- Pylon 里每做一版设计，CRM 自动出现一个报价版本。这一步不改变订单阶段。
- 客户在 Pylon 网页上签字，CRM 自动把签字 PDF 归档，订单变为 Signed。
- 客户通过 Pylon 支付网关付定金，CRM 自动生成一条待财务确认的定金。

说明：读取 Pylon 的事件、项目和设计，关联项目生成报价，以及已签字项目的合同归档，都已经用 Bluven 的真实 Pylon 账号验证过（只读，没有改动 Pylon 里的任何东西）。Webhook 投递和支付网关付款这两条还没有在真实账号上见过，第一次出现时请在 Administration → Pylon 页面确认事件是 Done；如果出现 Failed，把页面上的错误信息发给开发者。

---

## 7. 接入客户邮件（Zoho Mail）

接好之后，每个销售把自己的 Zoho 邮箱连到 CRM。他和客户的邮件自动出现在对应的订单里，也可以直接在订单里写信和回信，信从他自己的邮箱发出，Zoho 的已发送里照常有一份。

这里说的是**销售和客户之间的邮件**，和第 9 节的系统通知邮件是两回事，互不影响。

### 7.1 在 Zoho 里登记一次

整个公司只做一次，由管理 Zoho 的人来做：

1. 打开 `https://api-console.zoho.com.au`，用公司的 Zoho 账号登录。Bluven 的邮箱在澳大利亚数据中心，所以是 `.com.au` 这个地址。
2. 点 Add Client，类型选 **Server-based Applications**。
3. 填三项：
   - Client Name：`Bluven CRM`
   - Homepage URL：`https://crm.bluven.com.au`
   - Authorized Redirect URIs：`https://crm.bluven.com.au/api/zoho/callback`
4. 点 Create。页面给出 Client ID 和 Client Secret。
5. 把这两个值填进 `ZOHO_CLIENT_ID` 和 `ZOHO_CLIENT_SECRET`。方式 A 填在 Railway 的 Variables，保存后自动生效。方式 B 填在服务器的 `.env`，然后执行 `docker compose up -d`。

回到 CRM 的 Administration → Email，"Zoho application" 应显示 Configured。这个页面上也写着要填的回调地址，以它为准。

第 3 步的回调地址必须和 CRM 的正式地址一字不差，所以要等 CRM 已经在 `https://crm.bluven.com.au` 上能打开之后再做。

### 7.2 每个销售连接自己的邮箱

每人做一次：

1. 登录 CRM，点右上角自己的名字，选 Mailbox。
2. 点 Connect Zoho Mail。浏览器会跳到 Zoho 的登录页，用**自己的**邮箱登录，点 Accept。
3. 跳回 CRM，页面显示 Connected。最近两周和客户的邮件会在几分钟内出现在各自的订单里。

经理在 Administration → Email 能看到谁已经连接、最近一次读取的时间和状态，也可以替别人断开。

### 7.3 它读什么，不读什么

- **只保存和 CRM 里已有客户往来的邮件。** 判断依据是客户资料上的邮箱地址。邮箱里的其他邮件一概不保存。
- 读取收件箱、已发送和自己建的文件夹。不删除、不移动、不标记已读。
- 每分钟读一次。新客户的邮箱地址录进 CRM 之后，会回头把最近两周和这个地址的往来补进来。
- 客户来信时，订单的负责销售会在 CRM 里收到一条通知。
- 邮件带的附件跟着邮件保存。销售在订单的 Email 页给附件选一个资料类型，点 File，它就进了订单的资料；签字合同可以直接归档为合同。
- 销售从订单里发信时，可以勾选订单里已有的资料作为附件，单封合计不超过 20 MB。收件人里至少要有一个是客户资料上的地址，防止把客户的资料发错人。
- 运营能在自己的订单页上看这些邮件，只读。财务看不到。
- 销售随时可以自己断开。已经在订单里的邮件保留。

### 7.4 要知道的几件事

- **不要随意重新生成 Client Secret。** 各人邮箱的授权是用它加密保存的。换了之后原来的授权全部读不出来，所有人都要重新点一次 Connect。CRM 会在各人的 Mailbox 页和通知里提示。
- 某个人改了 Zoho 密码、在 Zoho 里撤销了授权、或者账号被停用，他的邮箱会显示 Needs connecting again，本人重新连接一次即可。其他人不受影响。
- 一个邮箱只能被一个 CRM 用户连接。
- 如果公司的 Zoho 账号不在澳大利亚数据中心，另外设置 `ZOHO_ACCOUNTS_URL` 和 `ZOHO_MAIL_URL`，例如 `https://accounts.zoho.com` 和 `https://mail.zoho.com`，并到对应数据中心的 API console 登记。

说明：这部分是按 Zoho 的官方接口文档写的，自动测试对着的是一个替身 Zoho 服务，**还没有连过真实的 Zoho 账号**。第一次连接时请先用一个人的邮箱试：连接、看最近的客户邮件是否出现、从订单里发一封信给自己。如果连接失败或读取失败，把 Mailbox 页或 Administration → Email 页上显示的错误信息发给开发者。

---

## 8. 开启 AI 助手

开启之后 CRM 多出五样东西：

| 功能 | 在哪 | 什么时候做 |
|---|---|---|
| 订单总结 | 订单 Overview 页最上面 | 销售点 Write a summary；客户来信后也会自动重写 |
| 回信草稿 | 订单 Email 页写信和回信的窗口里 | 销售点 Write a draft 才生成，可以先写一句想说什么 |
| 附件识别 | 订单 Email 页，客户来信的附件旁 | 邮件进来后自动看一眼，建议放进哪个资料夹 |
| 账单读取 | 订单 Overview 页右侧的 Electricity bill | 文件进了 Electricity bill 资料夹后自动读 |
| 交接简报 | 运营的订单页最上面，销售的 Handoff 页 | 推送给运营后一两分钟内自动写好 |

所有 AI 写的或读的内容，页面上都标着 Written by AI 或 Read by AI。

### 8.1 拿到密钥

AI 用的是 Anthropic 的接口，按用量付费，需要一个密钥：

1. 打开 `https://console.anthropic.com`，用公司邮箱注册并登录。
2. 在 Billing 里绑定付款方式或预充值。没有余额时接口会拒绝请求。
3. 在 API Keys 里新建一个密钥，名称写 `bluven-crm`。**密钥只在创建时显示一次**，当场复制。
4. 把它填进 `ANTHROPIC_API_KEY`。方式 A 填在 Railway 的 Variables，保存后自动生效。方式 B 填在服务器的 `.env`，然后执行 `docker compose up -d`。
5. 回到 CRM 的 Administration → AI assistant，"Key" 应显示 Configured。

密钥等同于钱包，只填在上面说的地方。不要发在聊天、邮件或代码里。泄露了就在 Anthropic 的控制台里删掉，再建一个新的。

控制台的菜单名称可能和这里写的略有出入，以页面为准。

### 8.2 它自己会做的事，都可以关

Administration → AI assistant 页面上有四个开关，只有管理员能改：

- 推送给运营时写交接简报
- 看客户邮件里的附件并建议资料夹
- 读电费账单，并填上空着的 NMI 和零售商
- 客户来信后重写订单总结

销售自己点按钮触发的功能不受这些开关影响。

同一页还有两项设置：

- **总结和简报用什么语言写**：English 或中文。回信草稿不看这个设置，它跟着客户来信的语言走。
- **24 小时内自动请求的上限**：默认 300。到了上限，自动的部分当天停下，第二天继续。销售点按钮的不计入。这是给无人值守的花费封顶用的。

### 8.3 大概花多少钱

按 token 计费，token 可以理解为字数。默认模型是 `claude-opus-5-5`，2026 年 11 月的标价是每百万输入 4 美元、每百万输出 20 美元。

粗略估计，每次请求在几美分以内：一次订单总结或交接简报约 0.02 到 0.06 美元，看一个附件或读一张账单约 0.01 到 0.03 美元，一封回信草稿约 0.02 到 0.05 美元。这是按订单资料的一般长度估的，**没有用真实账单验证过**。

Administration → AI assistant 页面列出最近 30 天每类功能的请求数、token 数和按标价估算的金额。实际金额以 Anthropic 控制台的账单为准。

想省钱可以换小一档的模型，加一个变量即可：`AI_MODEL=claude-sonnet-5-5` 的标价是默认模型的一半，`AI_MODEL=claude-haiku-5-5` 更便宜。小模型读账单和写总结的准确度会低一些，建议先用默认的跑一段时间再决定。

### 8.4 客户资料去了哪里

- 每次只把**当前这一张订单**的资料发给模型：线索内容、备注、时间线、和这位客户的邮件、报价数字。读账单和看附件时，文件本身也会发过去。
- 客户资料上登记的电话和邮箱不发。邮件正文或账单里如果本身带着电话、地址，那部分会随内容一起发出。
- 其他客户的任何内容都不会发。
- 客户写的内容在发给模型时会被标成"材料"，模型被要求不把它当成指令执行。
- 这些内容是发到 Anthropic 在境外的服务器上处理的。公司的隐私政策里应当写明客户资料会交给这样的服务处理，拿不准就问一下法律顾问。Anthropic 的商业条款写明接口的输入输出默认不用于训练模型，具体以它官网的条款为准。

### 8.5 要知道的几件事

- **AI 会出错。** 总结、简报、账单数字都只是帮人省时间的初稿，用之前要对照时间线和原文件。页面上每一处都有这句提醒。
- **它不替人做决定。** 回信草稿只填进输入框，要销售自己看过、改过、点 Send 才发出。附件只给出建议，归档要人点 File。识别成签字合同的附件也只是把 Signed contract 按钮标出来，合同归档仍然要人确认报价版本和签字日期。
- **账单只填空的。** NMI 和零售商已经有值的不覆盖，页面会提示不一致，由销售决定用哪个。账单上的地址和订单地址对不上时什么都不填，并通知负责销售。
- AI 填的值在房产信息里带着 from the bill 或 from the summary 的标记。有人手动改过之后标记消失，操作日志里两次都有记录。
- 财务看不到总结、简报和账单读取结果。运营在订单推送之后能看，不能改。
- 密钥失效或余额用完时，Administration → AI assistant 页面顶部会出现红色提示，自动的部分暂停，每 15 分钟重试一次，修好后自动补上。销售点按钮时会看到"请联系管理员"的提示。其他功能不受影响。
- 同一个文件连续失败四次，当天不再重试，避免白花钱。失败记录在同一页的 "Requests that did not succeed" 里，把那一栏的 Detail 发给开发者即可排查。

说明：这部分是按 Anthropic 官方 SDK 和接口文档写的，自动测试对着的是一个替身模型服务。**还没有用真实密钥调用过，模型实际写出来的内容质量也没有评估过。** 开启后请先在一两张真实订单上试：写一次总结，传一张真实账单看读得对不对，推送一张订单看简报。发现读错或写得不合用，把订单号和页面内容发给开发者，调整提示词即可。

---

## 9. 通知邮件、时区和上传上限

### 通知邮件

系统内的通知始终有效。如果还想让通知同时发到邮箱，有两种发法，配一种即可。

**通过网站的邮件中继（方式 A 必须用这个）。** 网站已经有一个发信中继，网站后台就是用它发邮件的。CRM 用同一个：

```
MAIL_RELAY_URL=<和网站后台 CMS 服务里的 MAIL_RELAY_URL 相同>
MAIL_RELAY_KEY=<和网站后台 CMS 服务里的 MAIL_RELAY_KEY 相同>
```

两个值到 Railway 的网站后台服务的 Variables 里照抄。发件人由中继决定，就是网站现在发通知用的那个邮箱。

**直接 SMTP（只适用于方式 B）。**

```
SMTP_URL=smtps://crm%40bluven.com.au:应用专用密码@smtp.zoho.com.au:465
MAIL_FROM=Bluven CRM <crm@bluven.com.au>
```

邮箱里的 `@` 在这里要写成 `%40`。`MAIL_FROM` 的地址必须是这个 Zoho 账号自己的邮箱或别名，否则 Zoho 会拒发。建议在 Zoho 里为这个账号生成应用专用密码。

两种都配了的话，用中继。

通知产生两分钟后才发邮件；如果这期间对方已经在系统里看过了，就不再发。发送失败会自动重试，间隔逐次拉长，大约一天后才放弃。

### 时区和上传上限

`APP_TIMEZONE` 默认 `Australia/Sydney`，决定界面上的日期时间和"今天"是哪一天。

`MAX_UPLOAD_MB` 是单个文件的上限，方式 B 默认 500。如果调大，同时把 `deploy/Caddyfile` 里的 `max_size` 调到比它略大。方式 A 建议保持 200，原因见 2.9。

---

## 10. 日常检查

| 看什么 | 怎么看 | 正常的样子 |
|---|---|---|
| 系统是否活着 | 浏览器打开 `https://crm.bluven.com.au/api/intake/health` | 显示 `{"ok":true}` |
| 服务状态 | 方式 A：Railway 面板里服务是绿色。方式 B：`docker compose ps` | 都在运行 |
| 网站线索 | CRM 的 Administration → Lead sources | "Bluven website" 显示 Connected，检查时间在几分钟内 |
| 后台任务 | 方式 A：Railway 的部署日志。方式 B：`docker compose logs --since 1h worker` | 有提醒、回池、新线索时才有日志，没有报错 |
| Pylon 事件 | CRM 的 Administration → Pylon | 没有 Failed，最近收到事件的时间合理 |
| 客户邮件 | CRM 的 Administration → Email | 每个邮箱都是 Working，Last read 在几分钟内 |
| AI 助手 | CRM 的 Administration → AI assistant | 顶部没有红色提示，Failed 一栏是 0 或很少 |
| 磁盘空间 | 方式 A：Railway 磁盘的用量。方式 B：`df -h` | 留有余量 |

后台任务负责的事：从网站取线索、闲置 5 / 10 / 15 天的提醒和回池、暂缓到期自动恢复、待办到期提醒、通知邮件、处理 Pylon 事件、读取已连接的邮箱、AI 助手自动做的那几件事。**后台任务不在运行时这些都不会发生**，但不影响大家正常使用系统，恢复运行后会补上。

---

## 11. 常见问题

**打不开，或者证书错误。**
确认 `crm` 这条 DNS 记录已生效。方式 A 看 Railway 的 Custom Domain 状态是否变绿，CNAME 和 TXT 两条记录是否都加了。方式 B 确认 80 和 443 端口对公网开放，然后看 `docker compose logs caddy`。

**登录后马上又被退回登录页。**
不是通过 HTTPS 访问，或者 `APP_URL`（方式 B 是 `CRM_DOMAIN`）没有填成 `https://` 开头的正式地址。系统只在 HTTPS 下发放登录凭证。

**Lead sources 页显示 Failing。**
页面上会写原因。最常见的是两边的密钥不一致：CRM 的 `BLUVEN_LEADS_KEY` 必须和网站后台的 `CRM_SYNC_KEY` 完全相同。提示 "not switched on there" 说明网站后台那边还没设 `CRM_SYNC_KEY`。

**忘记密码。**
管理员在 Administration → Users 里点 Reset password，设一个新的临时密码。如果唯一的管理员自己忘了密码，在服务器上执行下面的命令。系统会生成一个临时密码并只显示这一次，同时解除该账号的锁定；登录后系统会要求改掉。

方式 B：

```bash
cd /opt/bluven-crm
docker compose run --rm migrate sh -c 'cd /repo/packages/core && node --import tsx src/cli/reset-password.ts 管理员邮箱'
```

方式 A：用 Railway 的命令行工具连进 CRM 服务的容器（`railway ssh`），然后执行：

```bash
cd /repo/packages/core && node --import tsx src/cli/reset-password.ts 管理员邮箱
```

**连续输错密码后提示稍后再试。**
同一个邮箱 5 分钟内输错 5 次，会暂停几分钟。之后每再错一次，账号锁定的时间加倍，最长 15 分钟。输对一次即恢复正常。着急的话请管理员在 Users 里重置密码，重置会同时解除锁定。已经登录的人不受影响。

**上传大文件失败。**
方式 A：文件要在 5 分钟内传完，换个快一点的网络，或者把视频压缩后再传。方式 B：检查 `MAX_UPLOAD_MB` 和 `deploy/Caddyfile` 里的 `max_size`，以及磁盘空间。

**收不到通知邮件。**
方式 A 只能走邮件中继，直接填 `SMTP_URL` 是发不出去的。检查 `MAIL_RELAY_URL` 和 `MAIL_RELAY_KEY` 是否和网站后台的一致。系统内的通知不受影响。

**连接邮箱时 Zoho 提示 Invalid Redirect Uri，或者跳回来显示出错。**
Zoho 里登记的回调地址和 CRM 的地址不一致。到 `api-console.zoho.com.au` 打开那个 Client，把 Authorized Redirect URIs 改成 Administration → Email 页面上显示的那一串。提示 "already connected by another user" 说明这个邮箱已经被另一个 CRM 用户连接了。

**客户的邮件没有出现在订单里。**
先看这封信的对方地址是不是写在客户资料上，不在的话在客户资料里补上，几分钟后会自动补进来。再看 Administration → Email 里这个销售的邮箱是不是 Working。超过两周以前的旧邮件不会被读取。

**点了 Write a summary 或 Write a draft，提示助手没有设置好或暂时连不上。**
提示 "not set up" 是还没填 `ANTHROPIC_API_KEY`。提示 "its key or its settings are wrong" 是密钥不对、被删了，或者 Anthropic 账户没有余额，到 Administration → AI assistant 看红色提示里的原因。提示 "could not be reached" 是对方服务暂时繁忙，过一会儿再点。

**交接简报一直没出现。**
先看 Administration → AI assistant 里"推送时写交接简报"的开关是不是开着、自动请求有没有到当天上限。后台任务没在运行时也不会写。运营和销售都可以在简报卡片上点 Write it now 立即生成。

**想看某张订单谁改过什么。**
经理打开订单的 History 标签页，或者在 Administration → Audit log 按订单号搜索，可以导出 CSV。
