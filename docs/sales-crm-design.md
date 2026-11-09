# Bluven CRM 销售侧设计文档

版本：v0.3（设计定稿，尚未开工）
日期：2026-11-09
范围：销售业务全流程，外加运营"接收 / 退回订单"的最小界面。运营侧其余功能另行设计。

---

## 1. 目标与边界

Bluven 是一家澳洲住宅光伏 / 储能安装商。CRM 要解决的问题：

1. 线索从 Bluven 平台和外部渠道进入，去重后分派给销售。
2. 销售在 CRM 里完成全部跟进：邮件（Zoho）、电话记录、待办、资料归档。
3. 方案一律在 Pylon 设计，报价版本自动回流到 CRM；报价多数由销售从 CRM 用邮件发给客户，客户签字后邮件回传，签约以 CRM 内归档的合同为准。
4. 定金由财务确认到账。
5. 资料齐全后一键推送运营，运营可接收或退回。
6. AI 自动总结往来、抽取关键信息、整理资料，让销售和运营都能快速接手。

销售侧的终点：运营接收订单。尾款由运营在安装完成后向客户收取，不在本文范围内。

界面语言：英文。文档与内部沟通：中文。

---

## 2. 角色与权限

| 角色 | 可见范围 | 主要操作 |
|---|---|---|
| Sales（销售） | 只看自己名下的客户 / 订单，看不到同事的 | 跟进、记录、上传资料、推送运营、补件重推 |
| Manager（经理） | 全部客户 / 订单 | 分派、改派、批量转移、配置清单和丢单原因、看仪表盘和日志 |
| Finance（财务，独立账号） | 处于"定金待确认"的订单 + 订单只读 | 确认 / 驳回到账 |
| Ops（运营） | 只看已推送给运营的订单 | 接收、退回；查看交接包、资料、邮件时间线、AI 总结 |
| Admin（管理员） | 全部 | 用户、角色、系统配置 |

权限按"权限点"实现，一个用户可以同时持有多个角色（例如经理兼管理员）。
运营在订单推送之前看不到它的任何内容，包括邮件。

---

## 3. 数据模型

### 3.1 三层结构：客户、房产、订单

```
Customer（客户，人）
 └── Property（房产，地址）
      └── Order（订单，一次销售机会；从线索进来那一刻起就是一张订单，只是阶段不同）
```

- 同一客户可以有多处房产，每处房产可以有多张订单（例如两年后加装电池）。
- 走流程、推运营、算转化率的单位都是 Order。
- 邮件和时间线挂在 Customer 上，自动关联到唯一进行中的 Order；有多张进行中订单时由销售手动打标。

### 3.2 实体清单

| 实体 | 关键字段 | 说明 |
|---|---|---|
| User | name, email, roles[], isActive, zohoMailbox | 系统用户 |
| Customer | firstName, lastName, emails[], phones[], notes, createdFromSource | 邮箱和电话都是多值，带 isPrimary |
| Property | customerId, addressLine1, suburb, state, postcode, country, propertyType, lat/lng, nmi, retailer, phase, roofType, notes | nmi（电表号）、retailer 可由 AI 从账单抽取 |
| Order | customerId, propertyId, orderNo, stage, sideState, ownerId, source, externalLeadId, leadDetails(json), lostReason, onHoldUntil, pylonProjectId, pylonReference, acceptedQuoteId, pushedAt, handedOverAt, returnCount | orderNo 形如 `BLV-2026-00123`，同时作为 Pylon 的 reference_number |
| Quote | orderId, version, pylonDesignId, dcKw, storageKwh, totalCents, depositCents, currency, pdfUrl, webProposalUrl, sentAt, sentVia(email/pylon/manual), sentDocumentId, isAccepted, createdAt | 每个 Pylon 设计版本一条；实际发给客户的文件（通常只截取报价部分）单独存为文档并关联到该版本；客户签了哪版就把哪版标为 accepted |
| Contract | orderId, quoteId, signedAt, documentId, source(email/pylon/upload) | 签字版 PDF 落到 Document；quoteId 指明客户签的是哪一版报价 |
| Deposit | orderId, amountCents, method(bank/gateway/finance), proofDocumentId, receiptUrl, status(pending/confirmed/rejected), confirmedBy, confirmedAt, rejectReason | 财务确认后状态变 confirmed |
| Document | orderId, propertyId?, type, scope(property/order), fileName, mimeType, sizeBytes, storagePath, sha256, uploadedBy, takenAt, expiresAt, retentionPolicy, source(upload/email/pylon/ai) | 同一文件同一订单内按 sha256 去重 |
| DocumentType（可配置） | key, label, scope, isRequiredForHandoff, retentionYears, neverAutoDelete | 管理员维护必填清单与保留期 |
| Activity（时间线） | customerId, orderId?, type(email_in/email_out/call/note/stage_change/document/system), occurredAt, actorId, payload(json) | 所有触点一条线 |
| EmailThread / EmailMessage | threadId, customerId, mailboxUserId, zohoMessageId, messageIdHeader, inReplyTo, references[], from, to[], cc[], subject, bodyHtml, bodyText, receivedAt, direction, attachments[] | 原文保留，附件落盘 |
| Task（待办） | orderId, assigneeId, dueAt, title, status, remindAt | 到期推通知 |
| Notification | userId, type, payload, readAt | 站内 + 邮件 |
| LostReason（可配置） | key, label, isActive | 丢单原因列表 |
| LeadSource（可配置） | key, label, intakeToken | 每个来源一把接入密钥 |
| AuditLog | actorId, action, entityType, entityId, before(json), after(json), ip, at | 只增不删 |
| PylonEvent / ZohoSyncCursor | 原始事件、游标 | 幂等与断点续传 |

### 3.3 资料的两类归属

| 归属 | 类型举例 | 第二单复用 |
|---|---|---|
| Property（房产级） | 电表箱照片、屋顶 / 安装位置照片、额外现场照片 | 可一键复用，界面标注拍摄日期 |
| Order（订单级） | 电费账单、报价 PDF、签字合同、定金凭证 | 每单必须是新的 |

文件夹在界面上按 `客户姓名 / 房产地址 / 订单号 / 文件` 展开；物理存储路径用 ID，不用姓名。

---

## 4. 订单阶段（状态机）

### 4.1 主线阶段

| 阶段 | 英文键 | 进入条件 | 触发者 |
|---|---|---|---|
| 新线索 | NEW | 线索入库且已分派 | 系统 / 经理 |
| 已联系 | CONTACTED | 任一外发邮件或电话记录 | 自动 |
| 已报价 | QUOTED | 报价已发给客户：从 CRM 发出的邮件附带了某个报价版本的文件；或 Pylon 网页报价已发送；或销售手动标记 | 自动 / 销售 |
| 已签约 | SIGNED | 签字合同已归档：客户邮件回传的签字版被归档为 Contract 并选定对应报价版本；或 Pylon `web_proposals.signed` 自动归档 | 销售 / Pylon webhook |
| 定金待确认 | DEPOSIT_PENDING | 上传付款凭证，或 Pylon 网关收到 deposit | 销售 / Pylon webhook |
| 定金已确认 | DEPOSIT_CONFIRMED | 财务确认到账 | 财务 |
| 已推送运营 | PUSHED | 必填清单齐全 + 定金已确认，销售点击推送 | 销售 |
| 运营退回 | RETURNED | 运营退回并填原因 | 运营 |
| 运营已接收 | HANDED_OVER | 运营点击接收。销售侧终态，订单对销售只读 | 运营 |

- Pylon 生成设计只会创建 Quote 版本，不会把订单推到 QUOTED；只有报价真正发给客户才算已报价。
- RETURNED 之后销售补齐资料再推送，回到 PUSHED，`returnCount + 1`，每次退回原因留在订单上。
- HANDED_OVER 之后客户再来的邮件仍进时间线，销售和运营都能看。

### 4.2 旁路状态（sideState，与主线阶段并存）

| 状态 | 英文键 | 规则 |
|---|---|---|
| 丢单 | LOST | 原因必填（从可配置列表选），可填备注；可被经理恢复 |
| 暂缓 | ON_HOLD | 必须填回访日期，到期自动生成待办并提醒 |
| 已取消 | CANCELLED | 用于收定金之后客户反悔，带退款状态（待退 / 已退） |

### 4.3 推送前校验

- 必填清单项由管理员在 DocumentType 上配置 `isRequiredForHandoff`。
- 默认必填：签字合同、定金确认记录、电费账单、安装位置照片、电表箱照片。额外照片为可选。
- 缺哪项界面列出哪项，齐了"Push to Operations"按钮才可用。

---

## 5. 线索进入与去重

### 5.1 来源

1. Bluven 平台：实时推送到 CRM 的接收接口（见 5.2）。
2. 外部渠道：同一接口（每个渠道一把密钥），或经理上传 CSV。
3. 手动新建。

每条线索必须带 `source`，报表按来源统计。

### 5.2 CRM 线索接收接口

现有的 Bluven 线索接口是"外部系统把线索推进 Bluven"的方向。CRM 需要的是反方向：Bluven 把新线索推给 CRM。
为了让 Bluven 侧改动最小，CRM 的接收接口与 Bluven 现有接口**同构**：同样的请求体、同样的字段枚举、同样的返回格式。Bluven 只需把新入库的线索转发到 CRM，并多带一个 `externalId`（Bluven 的线索编号）。给 Bluven 开发者的完整规范见 `docs/bluven-lead-forwarding-spec.md`，以下为摘要。

```
POST /api/intake/leads
Authorization: Bearer <该来源的接入密钥>
Content-Type: application/json

{
  "leads": [
    {
      "externalId": "1042",
      "firstName": "Jane", "lastName": "Smith",
      "phone": "0412 345 678", "email": "jane@example.com",
      "address": "12 Sample St", "suburb": "Parramatta", "state": "NSW", "postcode": "2150",
      "propertyType": "House",
      "components": ["Solar", "Battery"], "systemKw": 6.6, "batteryKwh": 10, "monthlyBill": 350,
      "timeline": "1-month", "bestTime": "afternoon",
      "notes": "...", "householdSize": "4", "goals": ["Lower my bills"], "productPreference": "Tesla Powerwall 3"
    }
  ]
}
```

返回：

```
{ "created": 1, "duplicates": 0, "failed": 0,
  "results": [ { "index": 0, "ok": true, "id": "ord_01H...", "duplicateOf": null } ] }
```

- 必填：`firstName`、`phone`。校验规则与 Bluven 文档一致（州代码、邮编、枚举值严格匹配）。
- 限制与 Bluven 一致：每批 1–200 条、100 KB、每分钟 30 次；逐批顺序发送。
- 幂等：同一来源 + 同一 `externalId` 重复推送不会建第二条，返回原 id。
- 接口对已知来源做签名或密钥校验，密钥只放服务端。

### 5.3 字段映射

| 线索字段 | 落到 |
|---|---|
| firstName, lastName, phone, email | Customer |
| address, suburb, state, postcode, propertyType | Property |
| components, systemKw, batteryKwh, monthlyBill, timeline, bestTime, notes, householdSize, goals, productPreference | Order.leadDetails |
| externalId, source | Order.externalLeadId, Order.source |

### 5.4 去重规则

匹配键（任一命中即视为同一客户）：邮箱（小写）、电话（归一化为 E.164，如 `+61412345678`）、地址（归一化后的 `line1 + suburb + postcode`）。

| 情况 | 处理 |
|---|---|
| 全新的人 | 新建 Customer、Property、Order，进未分派池 |
| 老客户，新地址 | 在老客户下新建 Property 和 Order，默认分给原销售（在职），否则进池 |
| 老客户，同地址，有进行中的订单 | 判为重复：不建新单，把本次线索内容追加为该订单的一条 Activity，通知负责销售 |
| 老客户，同地址，之前订单已终结（HANDED_OVER / LOST / CANCELLED） | 新建 Order，默认分给原销售（在职），否则进池，经理可改 |

手动新建和 CSV 导入时同样走这套规则，界面实时提示"疑似重复"。

---

## 6. 分派与流转规则

- 分派方式：经理指派。未分派线索在"Unassigned"池中，经理可单个或批量分派。
- 闲置规则（以订单最后一次 Activity 计，LOST / ON_HOLD / PUSHED 之后不计）：
  - 5 天无动作：提醒负责销售。
  - 10 天无动作：提醒经理。
  - 15 天无动作：自动回到未分派池，原销售和经理都收到通知，订单上留一条系统记录。
- 批量转移：经理可把某销售名下全部或部分订单转给另一人（离职、休假）。
- 所有分派 / 改派写 AuditLog。

---

## 7. 沟通与时间线

### 7.1 Zoho Mail 接入（每人各自授权）

- 每个销售在 CRM 里用 OAuth 2.0 授权自己的 Zoho 邮箱，CRM 保存 refresh token。
- 公司账号在澳洲数据中心：OAuth 用 `accounts.zoho.com.au`，邮件 API 用 `mail.zoho.com.au`。域名仍作为系统配置项，便于将来变更。
- 所需 scope（以 Zoho 控制台为准）：`ZohoMail.accounts.READ`、`ZohoMail.folders.READ`、`ZohoMail.messages.READ`、`ZohoMail.messages.CREATE`、`ZohoMail.attachments.READ`。
- 收件：后台任务每 1–2 分钟按邮箱拉取 Inbox 和 Sent 的增量（`GET /api/accounts/{accountId}/messages/view`，按时间游标），逐封取正文、头部（Message-ID / In-Reply-To / References）和附件。
- 过滤：只保留与 CRM 已知客户邮箱往来的邮件；或 In-Reply-To 指向 CRM 发出的邮件（此时提示销售把新邮箱加到该客户名下）。其它邮件不落库。
- 发件：从 CRM 写信走 Zoho API 发送，保证出现在 Zoho 的已发送文件夹；CRM 记录自己的 Message-ID 用于线程归并。写信时可直接从订单资料中选附件，例如某个报价版本的 PDF 或销售裁剪后只含报价部分的版本；选了报价附件，发送成功后该 Quote 记 sentAt，订单进入 QUOTED。
- 线程归并：先按 References / In-Reply-To，再按"同一客户 + 归一化主题"。
- 附件：落盘到该客户 / 订单的"Email attachments"区，销售一键加入正式资料夹（或由 AI 建议归类，见 12）。

### 7.2 手动记录

- 电话、现场拜访、即时通讯：销售手动添加一条 Activity（类型、时间、摘要、下一步）。
- 任何外发邮件或电话记录自动把订单从 NEW 推到 CONTACTED。

### 7.3 时间线

单个客户一条时间线，包含：邮件（收 / 发）、电话、备注、阶段变更、资料上传、系统事件（分派、回池、Pylon 事件、财务确认、运营退回）。可按订单过滤。

---

## 8. 资料、文件夹与保留策略

- 存储：服务器本地磁盘，路径按 `/{customerId}/{propertyId}/{orderId}/{documentId}.{ext}`，通过鉴权接口流式下发，不直接暴露目录。存储层做抽象，将来可切到 S3 兼容对象存储。
- 大小：业务上不限制；技术上设单文件 500 MB 的保护上限，防止误传。
- 图片：生成缩略图；记录 EXIF 拍摄时间（`takenAt`）。HEIC 转换放到手机端阶段一起做。
- 上传时机：任何阶段都可上传，不限于成交后。
- 保留策略：默认 2 年（自订单终结之日起算）。`DocumentType.neverAutoDelete = true` 的类型（签字合同、定金凭证、合规类文件）不自动删除。到期前 30 天提醒负责销售和经理，可选延期一年或删除；删除是软删除并写 AuditLog，30 天后物理清理。
- 版本：同名文件再传视为新版本，旧版本保留可查。

---

## 9. 报价与签约：Pylon 集成

以下依据 Pylon 开发者文档（2026-11 查阅）：API 基址 `https://api.getpylon.com/v1`，JSON:API 格式，`Authorization: Bearer <token>`，`Accept: application/vnd.api+json`；限流每团队 50 次/秒、600 次/分钟；Webhook 签名为 HMAC-SHA256。

### 9.0 使用前提：设计一定在 Pylon，发送和签约不一定

所有方案都在 Pylon 设计，所以报价版本（容量、电池、价格、PDF）始终通过 Pylon 事件自动进入 CRM。但发给客户和签字有两条路，CRM 两条都支持，最终落到同一个 Contract 记录，运营看到的交接包不区分来源。

| 环节 | 路径 A：邮件（常见） | 路径 B：Pylon 网页报价 |
|---|---|---|
| 发报价 | 销售把 Pylon 方案 PDF 下载后只保留报价部分，从 CRM 用 Zoho 邮件发出；CRM 记录实际发送的文件和对应报价版本 | 客户在 Pylon 页面查看；`web_proposal_url` 存在 Quote 上 |
| 签约 | 客户签字后邮件回传；附件进入 CRM，AI 识别为签字合同并建议归档；销售确认时选定报价版本，订单进入 SIGNED | Pylon 发 `web_proposals.signed`，CRM 自动取签字 PDF 归档 |
| 定金 | 销售上传转账截图，或贷款批准件 | Pylon 支付网关事件自动生成定金记录 |

路径 A 下 Pylon 不会发签约事件，CRM 不依赖它。

### 9.1 接入方式（两步）

1. 在 Pylon 的 Settings → Integrations & API → API settings 创建 API token（权限 `read` 即可；若将来由 CRM 直接创建 Pylon 项目再加 `write`，不需要 `payment`）。
2. 同页添加 Webhook destination，URL 填 CRM 的 `https://<crm-domain>/api/webhooks/pylon`，勾选下列事件，并保存只显示一次的 secret。

Webhook 目的地必须是公网可达的 HTTPS 地址，所以 CRM 需要先有域名和证书；开发期可用隧道。7 天没有成功投递，Pylon 会把目的地置为 inactive，需手动重新激活，CRM 对此做监控告警。

### 9.2 CRM → Pylon：从订单创建 / 打开 Pylon 项目

第一阶段用 **深链接**，不需要 write 权限，不消耗积分：

```
https://app.getpylon.com/map/address?search=<URL编码的完整地址>&country=AU
  &customer_name=<姓名>&customer_email=<邮箱>&customer_phone=<电话>
  &reference_number=<CRM 订单号，如 BLV-2026-00123>
```

销售在订单页点 "Design in Pylon"，Pylon 打开地图让其确认位置并创建项目。`reference_number` 是两边对账的唯一纽带。

后续可升级为 API 创建"未提交项目"（`POST /v1/solar_projects`，`is_committed=false`，带 `reference_number`、`site_address`、`customer_details`），由销售在 Pylon 里确认位置后才消耗积分。

### 9.3 Pylon → CRM：Webhook 事件与处理

| 事件 | CRM 动作 |
|---|---|
| `solar_projects.created` | 按 `project_reference_number` 找到订单，写入 Pylon 项目 id 和 `project_in_app_url`（订单页显示 "Open in Pylon"） |
| `solar_designs.created` / `solar_designs.updated` | 调 `GET /v1/solar_designs/{id}?fields[solar_designs]=summary,pricing,proposal_quote,...`，写入或更新一条 Quote：`summary.dc_output_kw`、`summary.storage_kwh`、`pricing.total`（分）、`proposal_quote.deposit_amount_formatted`、`summary.pdf_proposal_url`、`summary.web_proposal_url`；下载报价 PDF 归档；订单进入 QUOTED |
| `web_proposals.signed`（仅路径 B 触发） | 订单进入 SIGNED；调 `GET /v1/solar_projects/{id}` 取 `acceptance.latest_esignature_pdf_url`（有效期 1 小时，须立即下载）存为 Contract 文档；`latest_signed_design` 对应的 Quote 标为 accepted |
| `gateway_payments.created`，`purpose = "deposit"` | 自动创建 Deposit（`amount` 分、`currency`、`receipt_url`，method = gateway），订单进入 DEPOSIT_PENDING，等财务确认。未使用 Pylon 网关时此步由销售手动上传凭证 |
| `solar_projects.updated` | 同步 `is_committed`、`job_sheet_url` 等；若 `acceptance.manually_sold` 为真而 CRM 尚无 Contract，提醒销售归档签字合同 |

Pylon 未提供 e-sign 单独事件或"报价被拒"事件，报价版本以设计的创建 / 更新为准。

### 9.4 可靠性

- 校验签名：`hs256=HMAC_SHA256(secret, "<Pylon-Webhook-Timestamp>.<原始请求体>")` 与 `Pylon-Webhook-Signature` 比对；时间戳偏差超过 5 分钟拒绝。
- 10 秒内必须返回 2xx，否则 Pylon 视为失败并重试（共 5 次，最后一次约 31 小时后）。所以接口只做校验和入队，处理放到后台任务。
- 幂等：以事件 id 去重，重复投递不重复处理。
- 对账：每晚拉 `GET /v1/events`（Pylon 只保留 30 天）补漏；同时对所有进行中的订单核对 `acceptance.is_accepted`。
- 路径 A 不产生 Pylon 签约事件，签约状态以 CRM 内归档的 Contract 为准；销售也可在订单页直接上传签字合同（source = upload）。

---

## 10. 定金与财务确认

- 定金金额默认取 Pylon 报价里的 `deposit_amount`，可手动修改。
- 付款方式：银行直接转账（销售上传截图，最常见）、Pylon 支付网关（支持但不一定用，用了就自动生成记录）、贷款 / 分期（上传贷款批准件）。
- 财务账号有自己的工作台："Pending deposits" 列表，逐条确认（填实收金额、到账日期、银行参考号）或驳回（填原因，订单回到 SIGNED 并通知销售）。
- 没有财务确认，推送按钮不可用。
- 确认和驳回都写 AuditLog 并进时间线。

---

## 11. 推送运营、退回循环与运营最小界面

### 11.1 交接包（Handoff Package）

推送时生成一份快照，运营看到的就是它：

- 客户与联系方式、房产地址与房产信息（NMI、零售商、相位等已知项）
- 已接受的 Quote（容量、电池、总价、定金）与签字合同
- 定金确认记录
- 全部资料（按类型分组，含房产级复用的照片及其拍摄日期）
- AI 生成的交接简报（见 12）
- 销售备注（施工注意事项、客户偏好时间等）
- 完整邮件时间线的访问权限（推送后运营可见）

### 11.2 运营最小界面（本期一起做）

- "Incoming orders" 列表：待接收的订单，按推送时间排序。
- 订单详情：交接包 + 资料预览 + 时间线。
- 两个按钮：**Accept**（订单进入 HANDED_OVER）与 **Return**（原因必填，可勾选缺失的清单项，订单进入 RETURNED）。
- 退回后负责销售和经理收到通知；补齐后重推，运营再次看到。

### 11.3 通知

推送、退回、接收三个事件都发站内通知 + 邮件；运营通知发给运营角色全体，或配置一个运营收件箱地址。

---

## 12. AI 能力

实现方式：Anthropic 官方 TypeScript SDK，模型 `claude-opus-5-5`，自适应思考；需要结构化结果的任务用 structured outputs 直接返回 JSON；账单和照片以 PDF / 图片内容块直接送入模型。

| 能力 | 触发 | 输出 |
|---|---|---|
| 客户往来总结 | 每封新收邮件后自动增量更新；也可手动点击 | 当前状态、客户关切与异议、已承诺事项、建议下一步。默认按客户汇总，可按订单查看 |
| 关键信息抽取 | 同上 | 地址、月电费、意向产品、预算、决策时间等，回填到订单 / 房产字段（标注"AI 填写，待确认"） |
| 附件自动归类 | 邮件附件落库后 | 判断是账单 / 电表箱 / 屋顶 / 签字合同 / 付款凭证 / 其它，生成"加入资料夹"建议，销售一键确认。识别为签字合同时，默认关联最近一次发给该客户的报价版本，确认后订单进入 SIGNED |
| 账单信息抽取 | 账单类文件入库后 | NMI、零售商、账期、用电量 kWh、费率类型、账单地址，回填 Property，并与线索地址比对提示不一致 |
| 回信草稿 | 新收邮件后 | 基于上下文的英文回复草稿，销售修改后发送 |
| 交接简报 | 点击推送时 | 给运营的一页简报：系统配置、现场要点、客户沟通偏好、未决事项 |

原则：

- AI 写入的字段一律可追溯（来源标注为 ai），人工可覆盖。
- 只把该客户相关的内容送给模型，不送无关邮件。
- 客户数据会经由 Anthropic API 处理，隐私政策需有相应条款。
- 所有 AI 调用记录 token 用量，便于成本监控。

---

## 13. 待办、提醒与通知

- 待办挂在订单上：标题、到期时间、负责人；到期前按设置提醒（站内 + 邮件）。
- 自动待办：暂缓到期回访、闲置提醒、资料到期提醒、运营退回补件。
- 通知中心：未读计数、按类型筛选；每日摘要邮件可选。

---

## 14. 仪表盘与报表

经理视角（销售只看自己的那部分）：

- 各来源线索数、各来源到签约的转化率
- 各销售：在手订单数、各阶段分布、签约数、平均首次响应时长（分派到第一次外发邮件 / 电话）
- 闲置订单（5 / 10 / 15 天）、待确认定金、被退回订单
- 丢单原因分布
- 周 / 月趋势

---

## 15. 操作日志

- 记录对象：所有实体的创建、修改、删除，分派 / 改派，阶段与旁路状态变更，资料增删与下载，财务确认 / 驳回，运营接收 / 退回，权限与配置变更，登录与授权事件。
- 记录内容：操作人、时间、IP、实体、改前 / 改后完整值。
- 只增不改不删；管理员可按人、按订单、按时间检索与导出。

---

## 16. 技术栈与部署

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈 | 前后端一种语言；Zoho、Pylon、Anthropic 都有成熟的 Node 生态 |
| Web 应用 | Next.js（App Router）+ React + Tailwind + shadcn/ui | 邮件线程、看板、上传等交互多，服务端渲染与 API 路由在一个项目里 |
| 数据库 | PostgreSQL 16 + Prisma | 关系模型清晰；全文检索用 Postgres 自带能力即可 |
| 后台任务 | 独立 worker 进程 + pg-boss（基于 Postgres 的队列） | Zoho 轮询、Pylon 事件处理、闲置规则、保留提醒、AI 任务；不引入 Redis |
| 文件 | 服务器本地磁盘，经存储抽象层访问 | 按用户要求存服务器；将来可切对象存储 |
| 认证 | Auth.js，邮箱 + 密码，登录后按角色授权；Zoho OAuth 仅用于连接邮箱 | 内部系统，用户少 |
| AI | Anthropic TypeScript SDK，`claude-opus-5-5` | 见第 12 节 |
| 部署 | Docker Compose（web、worker、postgres、Caddy 反向代理自动 HTTPS）单机 VPS | 简单、可备份；Pylon webhook 需要公网 HTTPS |
| 备份 | 每晚 pg_dump + 文件目录增量备份到异地 | 2 年保留期的前提 |
| 测试 | Vitest（单元 / 集成）+ Playwright（端到端） | |

仓库结构（单仓）：`apps/web`、`apps/worker`、`packages/db`（Prisma schema 与客户端）、`packages/core`（领域逻辑：状态机、去重、权限）、`packages/integrations`（zoho、pylon、anthropic）。

---

## 17. 实施阶段

| 阶段 | 内容 | 交付标准 |
|---|---|---|
| Phase 1 核心骨架 | 用户与角色、数据模型、Bluven 接收接口 + CSV 导入 + 去重、分派与闲置规则、订单状态机、时间线（备注 / 电话）、待办与通知、资料与文件夹与清单校验、手动标记已报价与上传签字合同、定金与财务确认、推送 / 退回 / 运营接收界面、操作日志、基础仪表盘、Pylon 深链接 + webhook（报价版本、网页报价签约归档、网关定金） | 不接邮件也能把一张订单从线索走到运营接收 |
| Phase 2 邮件 | Zoho 每人授权、增量同步、过滤与线程归并、从 CRM 发信并可选订单资料作附件（发报价自动进 QUOTED）、附件入库并可归档为签字合同 | 销售日常跟进可以完全在 CRM 里完成 |
| Phase 3 AI | 往来总结、信息抽取、附件归类、账单抽取、回信草稿、交接简报 | 运营拿到的每张订单都有 AI 简报 |
| Phase 4 完善 | 资料到期提醒与清理、报表细化、邮件模板、Pylon API 创建项目、手机端 | |

---

## 18. 已定事项与未决问题

已定：

- **定金**：客户多数直接银行转账，销售上传截图；Pylon 支付网关支持但不一定用，用了则自动生成待确认记录。两条路并存。
- **Zoho**：账号在澳洲数据中心，域名 `zoho.com.au`。
- **Bluven 线索**：Bluven 网站按 `docs/bluven-lead-forwarding-spec.md` 把新线索实时转发到 CRM，历史线索用补录模式导入。

未决（不挡开工）：

1. **CRM 域名**：Pylon webhook 和 Bluven 转发都需要一个公网 HTTPS 地址，需尽早确定正式域名和测试域名。
2. **Pylon API 权限**：开发者文档提到 API 访问需在设置页申请并联系 Pylon 支持；截图显示已可直接创建 token，若创建后报权限不足再联系支持。
3. **默认配置项**：丢单原因列表、必填清单默认项、定金默认比例，开工前给一版初始值即可，之后管理员可改。

---

## 变更记录

- v0.3（2026-11-09）：定金、Zoho 数据中心、Bluven 转发三项定论；新增 Bluven 转发接口规范文档。
- v0.2（2026-11-09）：报价发送与签约改为双路径。方案仍全部出自 Pylon，但报价通常由销售裁剪后从 CRM 邮件发出，客户签字后邮件回传，签约以 CRM 归档的合同为准；Pylon 网页报价与签约事件作为并行路径保留。
- v0.1（2026-11-09）：首版。
