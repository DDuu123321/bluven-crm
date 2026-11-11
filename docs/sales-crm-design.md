# Bluven CRM 销售侧设计文档

版本：v0.6
日期：2026-11-11
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
| Finance（财务，独立账号） | 有定金记录的订单（待确认 + 已处理的历史），只读，且只看与定金相关的部分：客户、报价、合同、付款凭证 | 确认 / 驳回到账 |
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
| 新线索 | NEW | 线索入库即为 NEW。未分派只是没有负责人（`ownerId` 为空），不是单独的阶段 | 系统 |
| 已联系 | CONTACTED | 任一外发邮件或电话记录 | 自动 |
| 已报价 | QUOTED | 报价已发给客户：从 CRM 发出的邮件附带了某个报价版本的文件；或 Pylon 网页报价已发送；或销售手动标记 | 自动 / 销售 |
| 已签约 | SIGNED | 签字合同已归档：客户邮件回传的签字版被归档为 Contract 并选定对应报价版本；或 Pylon `web_proposals.signed` 自动归档 | 销售 / Pylon webhook |
| 定金待确认 | DEPOSIT_PENDING | 上传付款凭证，或 Pylon 网关收到 deposit | 销售 / Pylon webhook |
| 定金已确认 | DEPOSIT_CONFIRMED | 财务确认到账 | 财务 |
| 已推送运营 | PUSHED | 必填清单齐全 + 定金已确认，销售点击推送 | 销售 |
| 运营退回 | RETURNED | 运营退回并填原因 | 运营 |
| 运营已接收 | HANDED_OVER | 运营点击接收。销售侧终态，订单对销售只读 | 运营 |

- **阶段由事实推导，不靠手工拨动。** 订单上记录各里程碑的时间（首次联系、报价发出、合同归档、定金状态、推送、退回、接收），阶段由这些事实用同一个函数算出来。这样事件乱序到达也不会出错（例如 Pylon 网关的定金事件先于签约事件到达），财务驳回定金后订单自然回到 SIGNED，误删合同后也会如实回退。
- 阶段只会因为事实变化而变化；每次变化都写时间线和操作日志。
- Pylon 生成设计只会创建 Quote 版本，不会把订单推到 QUOTED；只有报价真正发给客户才算已报价。
- 提交定金凭证要求合同已归档（阶段至少 SIGNED）。Pylon 网关的定金事件例外，可以先于合同到达，记录照建，待合同归档后阶段自动跟上。
- 销售可编辑的阶段：NEW 到 DEPOSIT_CONFIRMED，以及 RETURNED。PUSHED 期间等待运营，销售只读；HANDED_OVER 之后销售只读。
- RETURNED 之后销售补齐资料再推送，回到 PUSHED，`returnCount + 1`，每次退回原因留在订单上。
- HANDED_OVER 之后客户再来的邮件仍进时间线，销售和运营都能看。

### 4.2 旁路状态（sideState，与主线阶段并存）

| 状态 | 英文键 | 规则 |
|---|---|---|
| 丢单 | LOST | 原因必填（从可配置列表选），可填备注；可被经理恢复。只适用于还没有定金记录（待确认或已确认）的订单 |
| 暂缓 | ON_HOLD | 必须填回访日期。到期当天系统自动解除暂缓、生成一条跟进待办并提醒负责销售，闲置计时从这一刻重新开始。推送之后不能暂缓 |
| 已取消 | CANCELLED | 用于已有定金记录（待确认或已确认）之后客户反悔，带退款状态（无需退 / 待退 / 已退）。HANDED_OVER 之后的取消属于运营侧，不在本期范围 |

### 4.3 推送前校验

- 必填清单项由管理员在 DocumentType 上配置 `isRequiredForHandoff`。
- 默认必填：签字合同、定金确认记录、电费账单、安装位置照片、电表箱照片。额外照片为可选。
- 缺哪项界面列出哪项，齐了"Push to Operations"按钮才可用。

---

## 5. 线索进入与去重

### 5.1 来源

1. Bluven 网站：CRM 的后台任务每分钟从网站后台取一次新线索（见 5.2 之一）。网站不用改。
2. 外部渠道：CRM 的接收接口（每个渠道一把密钥，见 5.2 之二），或经理上传 CSV。
3. 手动新建。

每条线索必须带 `source`，报表按来源统计。

**自有系统与外部系统。** 来源分两类：Bluven 网站是自有系统；管理员为别的公司的系统新建的来源是外部系统。外部系统只能送线索进来：不能用 `dryRun` 和 `backfill`；它送来的线索与已有客户重复时，只被告知"重复"，拿不到订单号，其内容进时间线但不改动已有客户的联系方式。

### 5.2 线索怎么进来

**之一：从 Bluven 网站取（上线用这个）。** 网站后台（`cms.bluven.com.au`）本来就为 CRM 预留了 `GET /api/crm/leads?since=<时间>`，用共享密钥认证，返回询价和评估问卷两类线索。CRM 的 worker 每分钟取一次：

- 记住上次取到的位置，从那里接着取；一次取不完（每类每次最多 200 条）就连续取到取完。
- 每条线索带网站给的 `externalId`（`quote:<编号>` / `assessment:<编号>`），同一条只入库一次。
- 接通之前就存在的线索默认不取。设了 `BLUVEN_LEADS_SINCE` 则把那之后的旧线索作为历史数据带进来。
- 网站自己保存着全部线索，所以 CRM 停机期间不丢单，恢复后自动补上。
- 进不来的线索（例如电话不合规则）通知经理并写审计日志；连续 5 次取不到通知管理员；连接状态显示在 Administration → Lead sources。
- 网站接口目前只输出联系方式、地址和感兴趣的产品。网站加上其余字段后 CRM 会自动读取，不需要改 CRM。

**之二：接收接口（外部系统用，网站也可改用它主动推送）。** CRM 的接收接口与 Bluven 现有的线索导入接口**同构**：同样的请求体、同样的字段枚举、同样的返回格式，多一个 `externalId`。两种方式的完整说明见 `docs/bluven-lead-forwarding-spec.md`，以下为接收接口的摘要。

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

返回（完整定义以规范文档为准）：

```
{ "received": 1, "created": 1, "alreadyReceived": 0, "duplicates": 0, "failed": 0,
  "results": [ { "index": 0, "ok": true, "status": "created", "id": "ord_01H...", "orderNo": "BLV-2026-00123" } ] }
```

- 必填：`firstName`、`phone`。校验规则与 Bluven 文档一致（州代码、邮编、枚举值严格匹配）。
- 限制与 Bluven 一致：每批 1–200 条、100 KB、每分钟 30 次；逐批顺序发送。
- 幂等：同一来源 + 同一 `externalId` 重复推送不会建第二条，返回原 id。
- 接口对已知来源做密钥校验，密钥只放服务端；请求体边读边限长。
- 一行出错只影响这一行：校验不过的行、数据库存不下的行都单独报告，其余照常入库。控制字符和残缺的表情符号会被清理掉而不是让整行失败。

### 5.3 字段映射

| 线索字段 | 落到 |
|---|---|
| firstName, lastName, phone, email | Customer |
| address, suburb, state, postcode, propertyType | Property |
| components, systemKw, batteryKwh, monthlyBill, timeline, bestTime, notes, householdSize, goals, productPreference | Order.leadDetails |
| externalId, source | Order.externalLeadId, Order.source |

### 5.4 去重规则

**第一步，认人。** 电话（归一化为 E.164，如 `+61412345678`）或邮箱（小写）命中已有客户，即视为同一客户。电话优先于邮箱；两者命中不同客户时取电话命中的那位，并把另一位标为疑似重复。

**第二步，认地址。** 地址归一化为 `line1 + suburb + postcode`（统一大小写、去标点、街道类型缩写、单元号写法）后与该客户名下房产比对。

| 情况 | 处理 |
|---|---|
| 全新的人 | 新建 Customer、Property、Order，进未分派池 |
| 老客户，新地址 | 在老客户下新建 Property 和 Order，默认分给原销售（在职），否则进池 |
| 老客户，同地址，有进行中的订单 | 判为重复：不建新单，把本次线索内容追加为该订单的一条 Activity，通知负责销售 |
| 老客户，同地址，之前订单已终结（HANDED_OVER / LOST / CANCELLED） | 新建 Order，默认分给原销售（在职），否则进池，经理可改 |
| 老客户，本次没带地址 | 有进行中的订单则并入最近的那张（同上一行"重复"处理）；没有则新建订单，客户只有一处房产时挂在那处房产下 |
| 老客户，本次带地址，而名下唯一的房产还没填地址 | 视为同一处房产，把地址补上，再按上面的规则处理 |
| 人没对上，但地址与别的客户的房产相同 | **不自动合并**。照常新建客户和订单，同时标记"疑似重复"并指向那张订单，由经理在池中判断（可能是配偶另行咨询，也可能是房子换了主人） |

"原销售"指该客户最近一张订单的负责人。"进行中"指未丢单、未取消且未被运营接收。

手动新建和 CSV 导入走同一套规则，界面实时提示"疑似重复"。销售看不到别人名下的客户，所以对销售的提示只说"该联系人已存在，归属其他销售，请联系经理"，不显示对方客户的任何内容。

补充规则：

- **销售只能往自己的客户名下加单。** 客户最近一张订单不是他的，或者客户有任何一张进行中的订单不是他的，手动新建会被拒绝。这条规则在"认人、认订单"的同一处执行，界面提示和实际结果不会不一致。
- **自己的客户，换一个地址，就是新订单。** 销售给自己的老客户录入另一处房产的询价，会新建房产和订单；同一地址则提示已有订单。
- **历史订单被再次询价会"醒来"。** 历史导入的、还没人接手的订单，如果本人现在又来询价，这张订单转入未分派池并通知经理，而不是继续躺在历史里。订单一旦被分派过，再回池时进的是未分派池。
- **同一个电话或邮箱挂在多个客户名下时，按谁先有算。** 销售不能把别的客户已有的电话或邮箱加到自己的客户上（经理可以）；即使加了，新线索仍归最早持有的那位客户。
- **本地座机号按州补区号。** `9123 4567` 配合线索里的州识别为 `(02) 9123 4567` 或 `(03) 9123 4567`，不同城市的相同号码不会被当成一个人。
- **疑似重复且没有进池的订单通知经理。** 进池的在池里就能看到标记，直接分给销售的不会被经理看到，所以单独通知。

并发保护：线索入库串行执行（数据库咨询锁），同一来源同一 `externalId` 有唯一约束。

---

## 6. 分派与流转规则

- 分派方式：经理指派。未分派线索在"Unassigned"池中，经理可单个或批量分派。
- 闲置规则，天数可由管理员调整，默认 5 / 10 / 15：
  - 5 天无动作：提醒负责销售。
  - 10 天无动作：提醒经理。
  - 15 天无动作：自动回到未分派池，原销售和经理都收到通知，订单上留一条系统记录。
- "动作"指**员工推进这单生意的操作**：发邮件、记电话、写备注、传资料、报价 / 合同 / 定金、推送、完成待办。客户来信和系统提醒不算，否则客户发了邮件没人理也不会报警。**新建或改期待办、修改客户资料和地址、写给运营的备注、给文件换分类也不算**，否则把待办日期往后一拖就能一直占着线索。客户要求过一阵再联系的，用"暂缓"。分派和改派会重置计时。
- 计闲置的阶段：NEW、CONTACTED、QUOTED、SIGNED、DEPOSIT_CONFIRMED、RETURNED。不计的情况：等财务的 DEPOSIT_PENDING、等运营的 PUSHED、HANDED_OVER，以及丢单、暂缓、取消。
- **自动回池只发生在签约之前**（NEW、CONTACTED、QUOTED）。已签约的订单闲置只提醒销售和经理，不会从销售手里收走，由经理决定是否改派。客户已经付过款的订单（例如先通过 Pylon 网关付了定金、合同还没归档）同样不自动回池。
- **回池之前一定先提醒过。** 如果提醒没能按时发出（后台任务停过，或者天数被调小了），系统先补发提醒并说明两天后回池，两天内有任何动作就不回。
- 提醒销售的同时生成一条待办，留在他的待办列表里；订单上一有动作，这条待办自动完成。
- 财务确认定金后闲置计时重新开始：等财务的那段时间不算销售的。
- 回池或改派时，未完成的待办跟着订单走：回池后暂时无人负责，下次分派时转给新负责人。
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
- 版本：在某个文件上点 Replace 上传的是它的新版本，旧版本保留可查；普通上传总是新增文件。同一订单同一类型下内容完全相同的文件（sha256 相同）拒绝重复上传。
- 作废的文件：合同被移除或替换、定金提交被撤回或驳回时，当时的合同文件和付款凭证标记为"已作废"（No longer current）。它们留档可查，但不再算当前资料：不计入清单，不进运营的交接包，也不妨碍把同一个文件重新提交一遍。
- 合同文件和定金凭证不能从资料页删除，无论是提交里的第几页；报价、合同、定金三类文件只能从各自的流程进入。
- 订单改挂到另一处房产时，本单自己上传的现场照片跟着走；从旧地址的订单复用来的照片留下，不带到新地址。

---

## 9. 报价与签约：Pylon 集成

以下依据 Pylon 开发者文档（2026-11 查阅），并已用 Bluven 的真实 Pylon 账号只读验证过：API 基址 `https://api.getpylon.com/v1`，JSON:API 格式，`Authorization: Bearer <token>`，`Accept: application/vnd.api+json`；限流每团队 50 次/秒、600 次/分钟；Webhook 签名为 HMAC-SHA256。

实测得到、文档里没写的三点：事件列表默认从最旧的排起，必须带 `sort=-created_at` 才是最新在前；每页固定 50 条，时间和名称过滤参数不生效；一个活跃账号每小时能产生几十条事件，绝大多数来自与 CRM 无关的项目。

### 9.0 使用前提：设计一定在 Pylon，发送和签约不一定

所有方案都在 Pylon 设计，所以报价版本（容量、电池、价格、PDF）始终通过 Pylon 事件自动进入 CRM。但发给客户和签字有两条路，CRM 两条都支持，最终落到同一个 Contract 记录，运营看到的交接包不区分来源。

| 环节 | 路径 A：邮件（常见） | 路径 B：Pylon 网页报价 |
|---|---|---|
| 发报价 | 销售把 Pylon 方案 PDF 下载后只保留报价部分，从 CRM 用 Zoho 邮件发出；CRM 记录实际发送的文件和对应报价版本 | 客户在 Pylon 页面查看；`web_proposal_url` 存在 Quote 上 |
| 签约 | 客户签字后邮件回传；附件进入 CRM，AI 识别为签字合同并建议归档；销售确认时选定报价版本，订单进入 SIGNED | Pylon 发 `web_proposals.signed`，CRM 自动取签字 PDF 归档 |
| 定金 | 销售上传转账截图，或贷款批准件 | Pylon 支付网关事件自动生成定金记录 |

路径 A 下 Pylon 不会发签约事件，CRM 不依赖它。

### 9.1 接入方式

**只需要一个 API token。** 在 Pylon 的 Settings → Integrations & API → API settings 创建 API token，权限 `Read` 即可（CRM 对 Pylon 只读不写）。token 只在创建时显示一次。

有了 token，worker 每分钟读一次 Pylon 的事件列表，新事件一分钟内进入 CRM。这条路不依赖 CRM 有没有公网地址，本地和上线前都能用。连续 5 次读不到（例如 token 被删）通知管理员一次，Administration → Pylon 页面显示最近一次成功读取的时间。

**Webhook 是可选的加速。** 同页添加 Webhook destination，URL 填 `https://crm.bluven.com.au/api/webhooks/pylon`，勾选 9.3 的事件，保存只显示一次的 secret。配置后事件几秒内到达；不配置，功能完全一样，只是慢到一分钟内。两条路收到的是同一批事件，按事件 id 只处理一次。

**订单怎么对上 Pylon 项目，有两种方式：**

1. 销售在订单页点 Design in Pylon 新建项目，CRM 订单号作为项目的 reference number 带过去（见 9.2）。
2. 项目已经在 Pylon 里了（没带订单号）：销售在订单的报价页点 Link Pylon project，粘贴该项目在 Pylon 里的地址。先点 Check 看到这是哪位客户、哪个地址的项目，确认无误再点 Link project。

无论哪种方式，对上的那一刻 CRM 会把这个项目完整读一遍：每个设计生成一个报价版本；客户已经在 Pylon 网页上签过字的，签字 PDF 直接归档为合同；Pylon 里有而 CRM 房产上还空着的 NMI、零售商、供电相数自动填上（已有内容不覆盖，并记入操作日志）。之后也可以随时点 Refresh from Pylon 再读一遍，重复读取不会产生重复数据。

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
| `solar_designs.created` / `solar_designs.updated` | 调 `GET /v1/solar_designs/{id}?fields[solar_designs]=summary,pricing,proposal_quote`，写入或更新一条 Quote：`summary.dc_output_kw`、`summary.storage_kwh`、`pricing.total`（分）、`proposal_quote.deposit_amount_formatted`、`summary.web_proposal_url`。只记报价版本的数字和网页报价链接，不改变订单阶段，也**不自动下载方案 PDF**：设计过程中 Pylon 会频繁触发更新事件，每次都存一份 PDF 没有意义；真正发给客户的那份文件由销售在"标记为已发送"时附上。若该设计对应的报价版本已经发给过客户而关键数字有变，则另建新版本，保留已发出的那版 |
| `web_proposals.signed`（仅路径 B 触发） | 订单进入 SIGNED；调 `GET /v1/solar_projects/{id}` 取 `acceptance.latest_esignature_pdf_url`（有效期 1 小时，须立即下载）存为 Contract 文档；`latest_signed_design` 对应的 Quote 标为 accepted |
| `gateway_payments.created`，`purpose = "deposit"` | 自动创建 Deposit（`amount` 分、`currency`、`receipt_url`，method = gateway），订单进入 DEPOSIT_PENDING，等财务确认。未使用 Pylon 网关时此步由销售手动上传凭证。其他用途的付款只在时间线上记一笔，不生成定金 |
| `solar_projects.updated` | 若项目已有网页签字（`acceptance.latest_esignature`）而 CRM 尚无 Contract，直接归档签字 PDF（签约事件丢了也能补上）；若只是在 Pylon 里手动标了已成交（`manually_sold`）而没有签字件，提醒销售归档签字合同 |

Pylon 未提供 e-sign 单独事件或"报价被拒"事件，报价版本以设计的创建 / 更新为准。

**订单和 Pylon 项目是一对一绑定的。** 第一个带着这个订单号出现的 Pylon 项目与订单绑定，之后以项目为准。另一个项目再用同一个订单号，它的事件不会作用到订单上，经理会收到一次通知。原项目在 Pylon 里已删除时，新项目自动接替；否则由经理在订单的报价页点 Unlink from Pylon 解除绑定。绑定会在订单时间线上留一条记录。

**不能生效的签约和付款不会悄悄丢掉。** 订单已丢单、已取消或已在运营手里时，客户在 Pylon 上签字或付款：订单不变，但时间线上记一笔，并通知销售和经理；涉及钱的同时通知财务。客户签的版本与已归档合同的版本不同时：保留签字件（存入 Other documents），生成待办请销售确认以哪份为准。

### 9.4 可靠性

- 校验签名：`hs256=HMAC_SHA256(secret, "<Pylon-Webhook-Timestamp>.<原始请求体>")`（十六进制）与 `Pylon-Webhook-Signature` 比对。时间戳允许 36 小时偏差：Pylon 的重试会持续约 31 小时，重试时可能沿用原时间戳；窗口内的重放无害，因为事件按 id 只入库一次。
- 10 秒内必须返回 2xx，否则 Pylon 视为失败并重试（共 5 次，最后一次约 31 小时后）。所以接口只做校验和入队，处理放到后台任务。
- 幂等：以事件 id 去重，重复投递不重复处理。
- 读取事件列表：worker 每分钟读一次 `GET /v1/events?sort=-created_at`，从最新往回读到已经有的为止，通常一页；另外每天做一次回看三天的完整核对。Pylon 只保留 30 天的事件。
- 与 CRM 无关的项目的事件：事件本身带着项目的 reference number（空的也带），所以不需要再向 Pylon 查询就能判断无关，直接记为不需处理。这类记录保留 35 天后自动清除；Administration → Pylon 页面默认只显示与订单有关、等待中或失败的事件。
- 处理失败的事件按 1 分钟、5 分钟、30 分钟、2 小时、6 小时退避重试，仍失败则标记 Failed 并通知管理员，管理员在 Administration → Pylon 页面查看原因并手动重试。
- 项目还没对上订单时到达的事件，在项目绑定后自动补处理；绑定时还会把整个项目读一遍（见 9.1），所以更早的设计也不会漏。这次完整读取如果失败，下一个事件到来时会重试。
- 订单已关闭（丢单、取消）或已在运营手里时，设计类事件只记录不生效；签约和付款事件见 9.3 的说明。
- 从 Pylon 下载文件只走 HTTPS，且地址必须解析到公网，跳转后同样检查；调用 API 不跟随跳转。
- **已用真实 Pylon 账号验证的部分**（只读）：读取事件列表、项目和设计；关联项目后生成报价版本（金额、定金、网页报价链接）；已签字项目的签字 PDF 下载并归档为合同；每分钟读取与事件处理；token 无效时的报错。**尚未验证的部分**：Webhook 投递与签名（需要 CRM 有公网地址后才能在 Pylon 里添加目的地）；支付网关的付款事件（账号里近期没有这类事件）。字段读取全部做了容错。
- 路径 A 不产生 Pylon 签约事件，签约状态以 CRM 内归档的 Contract 为准；销售也可在订单页直接上传签字合同（source = upload）。

---

## 10. 定金与财务确认

- 定金金额默认取 Pylon 报价里的 `deposit_amount`，可手动修改。
- 付款方式：银行直接转账（销售上传截图，最常见）、Pylon 支付网关（支持但不一定用，用了就自动生成记录）、贷款 / 分期（上传贷款批准件）。
- 财务账号有自己的工作台："Pending deposits" 列表，逐条确认（填实收金额、到账日期、银行参考号）或驳回（填原因，订单回到 SIGNED 并通知销售）。
- 没有财务确认，推送按钮不可用。
- 确认和驳回都写 AuditLog 并进时间线。
- 订单取消时如果还有一笔待确认的定金，由财务照常确认或驳回（钱到没到，正是退款的依据），销售不能撤回；已确认的不能再撤销确认。
- 被驳回后重新提交时，"定金被驳回，请重新提交"那条待办自动完成。

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

- 待办挂在订单上：标题、到期时间、负责人；到期时提醒（站内 + 邮件）。
- 自动待办：暂缓到期回访、闲置提醒、定金被驳回、运营退回补件、Pylon 已成交待归档合同、Pylon 上签了另一版待确认。其中四种在起因解决后自动完成，不会一直挂着显示逾期：定金被驳回（重新提交后）、运营退回（重新推送后）、Pylon 已成交（合同归档后）、闲置提醒（订单上有动作后）。暂缓到期回访和版本确认由销售自己勾掉。资料到期提醒在 Phase 4。
- 重新打开的待办归订单现在的负责人；待办列表只显示自己还能打开的订单上的待办。
- 通知中心：未读计数。按类型筛选和每日摘要邮件在 Phase 4。
- 通知邮件：产生两分钟后发，已在系统里读过的不发。发送失败按 2 分钟、10 分钟、30 分钟、2 小时、6 小时、12 小时的间隔重试，约一天后放弃。可直接走 SMTP，也可经网站的 HTTPS 邮件中继发送（Railway 屏蔽外发 SMTP）。

---

## 14. 仪表盘与报表

经理视角（销售只看自己的那部分）：

- 各来源线索数、各来源到签约的转化率
- 各销售：在手订单数、各阶段分布、签约数、平均首次响应时长（分派到第一次外发邮件 / 电话）
- 闲置订单（提醒销售 / 提醒经理两档）、待确认定金、被退回订单
- 丢单原因分布
- 最近八周趋势（月度趋势在 Phase 4）

口径：漏斗逐级包含（签约的一定算报过价，报过价的一定算联系过，即使没人记过电话）；"待确认定金"数的是处于 Deposit pending 阶段的订单；日期区间按业务时区的自然日计算，夏令时切换日也准确。

---

## 15. 操作日志

- 记录对象：所有实体的创建、修改、删除，分派 / 改派，阶段与旁路状态变更，资料增删与下载，财务确认 / 驳回，运营接收 / 退回，权限与配置变更，登录与授权事件。
- 记录内容：操作人、时间、IP、实体、改前 / 改后完整值。
- 只增不改不删，数据库层面同时拒绝 UPDATE、DELETE 和 TRUNCATE；管理员可按人、按订单、按时间检索与导出（导出为流式，不受数据量限制）。
- 文件的每次查看和下载都记录。同一人对同一文件的同一种访问，几分钟内只记一次（浏览器会分段取同一个文件）。

### 15.1 登录与访问方面的规则

- 密码错误在核对密码之前先计数，所以同时发来多少次猜测，被真正核对的也只有 5 次。之后账号锁定 1 分钟起、逐次加倍、最长 15 分钟。
- "尝试次数过多"的提示按输入的邮箱计，不管这个邮箱有没有账号，所以从提示和响应时间都看不出哪些邮箱是账号。
- 会话 14 天不用即失效，登录后最长 90 天；页面自己发的后台请求不算"在用"。
- 所有服务端动作在运行时校验入参类型；带文件的请求先验权限再读文件；对外的接口读取请求体时限长。
- 访客地址（用于登录限流和操作日志）取自前面那层代理写入的 `X-Real-IP`。Railway 的入口和自带的 Caddy 都会用真实地址覆盖访客自带的值，所以访客无法冒充别的地址。
- 已知的取舍：知道某人邮箱的人可以通过故意输错密码让该账号短时间内无法新登录（已登录的不受影响）。这是账号锁定机制固有的代价，Phase 4 可加设备识别或两步验证来消除。

---

## 16. 技术栈与部署

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈 | 前后端一种语言；Zoho、Pylon、Anthropic 都有成熟的 Node 生态 |
| Web 应用 | Next.js（App Router）+ React + Tailwind，自写一套轻量组件 | 邮件线程、看板、上传等交互多，服务端渲染与 API 路由在一个项目里；内部工具不需要引入整套组件库 |
| 数据库 | PostgreSQL 16 + Prisma | 关系模型清晰；全文检索用 Postgres 自带能力即可 |
| 后台任务 | 独立 worker 进程。Phase 1：定时扫描 + 事件表轮询（`FOR UPDATE SKIP LOCKED`，带重试与退避）；Phase 2 起按需引入 pg-boss | Phase 1 只有闲置规则、提醒、Pylon 事件三类任务，用数据库本身就够，少一个依赖；Zoho 按邮箱轮询和 AI 任务需要真正的队列时再加。始终不引入 Redis |
| 文件 | 服务器本地磁盘，经存储抽象层访问 | 按用户要求存服务器；将来可切对象存储 |
| 认证 | 自管会话：邮箱 + 密码（scrypt 哈希），数据库会话表 + HttpOnly Cookie，登录限速；账号由管理员创建，首次登录强制改密；Zoho OAuth 仅用于连接邮箱 | 内部系统、用户少、没有第三方登录需求，自管会话依赖最少、行为完全可控 |
| AI | Anthropic TypeScript SDK，`claude-opus-5-5` | 见第 12 节 |
| 地址 | `https://crm.bluven.com.au` | 与网站（`www`，Netlify）和网站后台（`cms`，Railway）同一域名下的子域名 |
| 部署 | 两种方式，同一份代码：Railway（单容器，启动时迁移数据库并同时运行 web 和 worker，磁盘挂载到 `/data`）；或自己的服务器上 Docker Compose（web、worker、postgres、Caddy 反向代理自动 HTTPS） | 网站后台已在 Railway；Pylon webhook 需要公网 HTTPS。步骤见 `docs/deployment-guide.md` |
| 备份 | Railway 的定时备份（数据库和磁盘各一份）；自己的服务器用每晚 pg_dump + 文件目录打包并同步到异地 | 2 年保留期的前提 |
| 测试 | Vitest（单元 / 集成）+ Playwright（端到端） | |

仓库结构（单仓）：`apps/web`、`apps/worker`、`packages/db`（Prisma schema 与客户端）、`packages/core`（领域规则与业务服务：阶段推导、去重、权限、入库、交接等）、`packages/integrations`（pylon；之后是 zoho、anthropic）。

约定：时间一律存 UTC，界面按业务时区显示（默认 `Australia/Sydney`，可配置）；金额一律以"分"为单位存整数，币种默认 AUD。

---

## 17. 实施阶段

| 阶段 | 内容 | 交付标准 |
|---|---|---|
| Phase 1 核心骨架（**已完成**） | 用户与角色、数据模型、从 Bluven 网站取线索 + 接收接口 + CSV 导入 + 去重、分派与闲置规则、订单状态机、时间线（备注 / 电话）、待办与通知、资料与文件夹与清单校验、手动标记已报价与上传签字合同、定金与财务确认、推送 / 退回 / 运营接收界面、操作日志、基础仪表盘、Pylon 深链接 + webhook（报价版本、网页报价签约归档、网关定金） | 不接邮件也能把一张订单从线索走到运营接收。已由端到端自动化测试验证 |
| Phase 2 邮件 | Zoho 每人授权、增量同步、过滤与线程归并、从 CRM 发信并可选订单资料作附件（发报价自动进 QUOTED）、附件入库并可归档为签字合同 | 销售日常跟进可以完全在 CRM 里完成 |
| Phase 3 AI | 往来总结、信息抽取、附件归类、账单抽取、回信草稿、交接简报 | 运营拿到的每张订单都有 AI 简报 |
| Phase 4 完善 | 资料到期提醒与清理、报表细化（月度趋势等）、通知按类型筛选与每日摘要邮件、邮件模板、Pylon API 创建项目、HEIC 转换、手机端 | |

---

## 18. 已定事项与未决问题

已定：

- **定金**：客户多数直接银行转账，销售上传截图；Pylon 支付网关支持但不一定用，用了则自动生成待确认记录。两条路并存。
- **Zoho**：账号在澳洲数据中心，域名 `zoho.com.au`。
- **Bluven 线索**：CRM 每分钟从网站后台已有的 `GET /api/crm/leads` 取新线索，网站不用改；需要秒级到达时可改为网站主动推送。两种方式见 `docs/bluven-lead-forwarding-spec.md`。
- **地址**：`https://crm.bluven.com.au`。

未决：

1. **部署在哪**：Railway（与网站后台相同）或自己的服务器，二选一，步骤见 `docs/deployment-guide.md`。Railway 的步骤按其文档写成，尚未在该平台上实际部署过。
2. **Pylon 实连验证**：接通真实 Pylon 账号后用测试订单走一遍。开发者文档提到 API 访问可能需要联系 Pylon 支持开通；若创建 token 后调用报权限不足再联系他们。
3. **默认配置项**：丢单原因（十项）、必填清单（电费账单、安装位置照片、电表箱照片）、定金建议比例（10%）已给出初始值，管理员可在后台修改。
4. **网站接口带全询价信息**：网站的 `GET /api/crm/leads` 目前不输出月电费、购买时间、备注等，是否补上由网站一侧决定，写法见对接说明 A.4。

已知限制（不影响使用，记录在案）：

- `dryRun` 逐条对照库里已有的数据，不考虑同一批里前面的线索，所以同批内互相重复的两条都会预报为新建。
- 地址比对认不出所有写法，例如 `12A` 与 `12 A`、带括号的补充说明。认不出时会多建一处房产，可在订单页合并到正确的房产。
- 闲置数字有两种口径：仪表盘总数按天数算，按人的那一栏按已提醒算。15 天一档和月度趋势在 Phase 4。
- 资料保留期到期的提醒与清理在 Phase 4。现在不会自动删除任何文件。
- 页面没有设置内容安全策略（CSP）头；上传的文件各自带有严格的响应头。
- 应用用数据库属主账号连接。审计日志的只增不改由触发器保证，属主理论上可以关掉触发器。

---

## 变更记录

- v0.6（2026-11-11）：两项新增，加一轮独立代码审查后的规则调整。新增：地址定为 `crm.bluven.com.au`，支持 Railway 单容器部署；CRM 主动从网站后台取线索（网站不用改），通知邮件可经网站的邮件中继发送。规则调整：线索入口区分自有系统与外部系统；销售只能往自己的客户名下加单，自己的客户换地址即新订单；历史订单被再次询价时转入未分派池；作废文件的概念（合同被移除、定金被撤回或驳回后可重新提交同一文件）；取消订单上的待确认定金由财务处理；闲置规则细化（哪些算动作、回池前必先提醒、已付款的不回池、闲置待办）；订单与 Pylon 项目一对一绑定，不能生效的签约和付款通知到人；登录限流与会话上限；仪表盘口径。新增"已知限制"一节。
- v0.5（2026-11-10）：Phase 1 实现完成。与 v0.4 的差异：Pylon 设计事件只记数字和网页报价链接，不自动下载方案 PDF，发给客户的文件在"标记为已发送"时附上；webhook 时间戳窗口放宽到 36 小时以覆盖 Pylon 的重试周期；补充事件重试、关闭订单的处理和"尚未实连验证"的说明；每日摘要邮件、通知按类型筛选、HEIC 转换归入 Phase 4。
- v0.4（2026-11-10）：开工前复查。修正两处矛盾（NEW 的进入条件；Pylon 设计事件不再推进到 QUOTED）；阶段改为由事实推导；去重细化（电话 / 邮箱认人，仅地址相同不自动合并而是标记疑似重复；补充无地址线索的处理；对销售的重复提示不泄露他人客户）；闲置规则细化（只计员工动作、等财务和等运营不计、自动回池仅限签约前、暂缓到期自动解除）；丢单与取消的边界；文件版本改为显式 Replace；技术选型调整（自管会话、Phase 1 不引入 pg-boss、自写组件）。
- v0.3（2026-11-09）：定金、Zoho 数据中心、Bluven 转发三项定论；新增 Bluven 转发接口规范文档。
- v0.2（2026-11-09）：报价发送与签约改为双路径。方案仍全部出自 Pylon，但报价通常由销售裁剪后从 CRM 邮件发出，客户签字后邮件回传，签约以 CRM 归档的合同为准；Pylon 网页报价与签约事件作为并行路径保留。
- v0.1（2026-11-09）：首版。
