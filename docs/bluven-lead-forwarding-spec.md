# Bluven 网站 → CRM 线索对接说明

版本：v2.0
日期：2026-11-11
读者：维护 Bluven 网站（仓库 `Website-Restructuring`）的人
配套文档：`docs/sales-crm-design.md` 第 5 节，`docs/deployment-guide.md` 第 4 节

---

## 先看这里：有两种对接方式

| | 方式一：CRM 从网站取 | 方式二：网站推给 CRM |
|---|---|---|
| 谁发起 | CRM 每分钟向网站后台要一次新线索 | 网站每收到一条线索就发给 CRM |
| 网站要改代码吗 | **不用**。网站后台已有 `GET /api/crm/leads` | 要。新增转发任务、重试队列和状态字段 |
| CRM 这边 | 已实现，已测试 | 已实现，已测试 |
| CRM 停机时 | 线索留在网站，恢复后自动补上 | 靠网站自己的重试队列 |
| 时效 | 最长 1 分钟 | 几秒 |
| 带过来的信息 | 目前较少，改十几行可带全（见 A.4） | 完整 |

**建议用方式一上线。** 它不需要改网站，也是网站当初设计时就预留好的做法（网站自己的库是入站缓冲，CRM 停机不丢单）。方式二留作以后需要秒级到达时的选项。

两种方式不要同时开。如果以后从方式一换到方式二，`externalId` 请沿用方式一的写法（`quote:<编号>`、`assessment:<编号>`），这样换的过程中同一条线索不会进来两次。

---

# 第一部分 方式一：CRM 从网站取线索

## A.1 怎么接通

只需要两边填同一把密钥，步骤见 `docs/deployment-guide.md` 第 4 节：

- 网站后台（Railway 上的 CMS 服务）：`CRM_SYNC_KEY=<密钥>`
- CRM：`BLUVEN_LEADS_URL=https://cms.bluven.com.au/api/crm/leads`，`BLUVEN_LEADS_KEY=<同一把密钥>`

接通后在 CRM 的 Administration → Lead sources 页能看到连接状态、最近一次检查时间和最近一条线索的到达时间。

## A.2 CRM 依赖网站接口的哪些行为

网站后台 `cms/src/server.ts` 里的 `GET /api/crm/leads` 现在的行为，CRM 就是按这个写的。**以后改这个接口时，下面几条不要变**：

1. 认证：请求头 `Authorization: Bearer <CRM_SYNC_KEY>`。密钥不对返回 401，没配置返回 503。
2. 参数 `since`：ISO 时间。返回 `createdAt` **大于等于** 它的线索。
3. 返回 `{ "items": [...], "count": n }`，按 `createdAt` 从早到晚。
4. 每次每类（quote、assessment）最多 200 条。
5. 每条有 `kind`（`quote` 或 `assessment`）、`externalId`（`quote:<编号>` / `assessment:<编号>`，永不改变）和 `createdAt`。

CRM 的做法：记住上次取到的最后一条的时间，下次从那个时间取；边界上那一条会被再次返回，CRM 认得它，不会重复入库。某一类取满 200 条时，说明后面还有，CRM 会接着取，直到取完。

一个已知的边界：如果有超过 200 条线索的 `createdAt` 精确到毫秒完全相同，CRM 无法翻过这一页，会在 Lead sources 页报错并通知管理员。正常提交不会出现这种情况。

## A.3 现在带过来哪些信息

| 网站返回的字段 | 在 CRM 里 |
|---|---|
| `externalId` | 线索的外部编号，用于防重复 |
| `createdAt` | 线索的提交时间 |
| `firstName` `lastName` `email` `phone` | 客户 |
| `address` `suburb` `state` `postcode` | 房产 |
| `source` | 来源明细：`WEBSITE_QUOTE` → `website/quote-form`，`WEBSITE_ASSESSMENT` → `website/assessment`，`AI_CHAT` → `website/ai-chat`，`PARTNER` → `website/partner` |
| `title`（如 `Solar + Battery`） | 感兴趣的产品。只有当它正好是产品名用 `+` 连起来时才识别 |
| `householdSize` `goals` `productPreference` | 原样带入 |

**现在不带的**：物业类型、想要的系统和电池大小、月电费、购买时间、方便联系的时间、备注，以及评估问卷的答案和结论。这些在网站后台的线索里有，但接口没有输出。销售在 CRM 里看不到，需要的话要回网站后台查。

## A.4 可选：让网站把信息带全

改动只在网站后台的 `cms/src/server.ts`，`GET /api/crm/leads` 里拼 `items` 的那两段。**只加字段，不改已有字段**，CRM 不用跟着改：它会自动读取下面这些名字的字段。

询价（`quotes.docs.map` 里，在 `productPreference` 那一行后面加）：

```ts
        // Enquiry details for the CRM. The CRM reads whichever of these are present.
        components: Array.isArray(q.components) ? q.components : [],
        propertyType: q.propertyType || '',
        systemKw: q.systemKw ?? null,
        batteryKwh: q.batteryKwh ?? null,
        monthlyBill: q.monthlyBill ?? null,
        timeline: q.timeline || '',
        bestTime: q.bestTime || '',
        notes: q.notes || '',
```

评估问卷（`assessments.docs.map` 里，在 `title` 那一行后面加）：

```ts
        // What the quiz learned, for the salesperson's first call.
        householdSize: a.answers?.occupants || '',
        goals: Array.isArray(a.answers?.mainGoal) ? a.answers.mainGoal : [],
        notes: [a.result?.recommendationType && `Recommendation: ${a.result.recommendationType}`, a.result?.summary]
          .filter(Boolean)
          .join('\n')
          .slice(0, 5000),
```

字段的取值规则和下面第二部分 3.3 节的表格相同（它们本来就是照网站的线索字段定的）。有一条要注意：某个字段的值不合规则时，CRM 会拒收整条线索并通知经理，所以 `notes` 要截到 5000 字以内，枚举字段只发网站表单里已有的那些值。

改完部署后，新线索就会带上这些信息。已经进了 CRM 的线索不会回头补。

## A.5 其他行为

- **只取接通之后的线索。** 想把之前的也带进来，在 CRM 第一次启动前设 `BLUVEN_LEADS_SINCE`。旧线索作为历史数据进入，不进未分派池、不发通知。
- **去重规则和其他入口一样。** 同一个人同一个地址已有进行中的订单时，新线索并入那张订单的时间线，不另建订单。
- **网站里之后的修改不会同步。** 线索进了 CRM 之后，在网站后台再改状态、改备注，CRM 不会跟着变。销售在 CRM 里跟进。
- **进不来的线索会报出来。** 例如电话号码不合规则。经理会收到通知，审计日志里有记录，线索本身仍在网站后台。
- **连接出问题会报出来。** 连续 5 次失败，管理员收到通知；Lead sources 页显示原因。

## A.6 验收

- 在网站提交一条询价，两分钟内出现在 CRM 的 Unassigned leads 里，姓名、电话、地址正确。
- 同一条线索不会出现两次。
- 把 CRM 停掉，在网站提交一条询价，再启动 CRM：这条线索在启动后一两分钟内出现。
- 把 CRM 的密钥改错：Lead sources 页显示 Failing 和原因；改回后恢复 Connected。

---

# 第二部分 方式二：网站主动推送到 CRM（可选）

以下是 CRM 的线索接收接口的完整规范。用方式一上线时可以不看这一部分。

这个接口也用于其他系统向 CRM 送线索（例如合作方）。其他系统的密钥由管理员在 Administration → Lead sources 里新建来源后生成。**其他公司的系统权限更小**：不能用 `dryRun` 和 `backfill`；它送来的线索如果和已有客户重复，只会被告知"重复"，不会得到订单号，也不会改动已有客户的联系方式。

## 1. 目标

Bluven 网站每收到一条新线索，立即转发一份到 CRM。Bluven 仍然是线索的入口和第一落库点，CRM 是销售跟进的系统。转发失败不能影响 Bluven 自己的入库。

这个接口的请求体和 Bluven 现有的"线索导入 API"（`/api/partner-import`）**同构**：字段名、枚举值、校验规则、限制、返回格式都一致，只多了几个可选字段。Bluven 现在怎么组装线索对象，就可以原样发给 CRM。

---

## 2. 总体要求

1. **触发时机**：线索在 Bluven 入库成功后，由后台任务异步发送。不要放在用户提交表单的那个 HTTP 请求里，用户不应该等 CRM。
2. **顺序**：单线程顺序发送，不并发。
3. **批量**：实时转发每次发 1 条即可；历史补录每次最多 200 条。
4. **重试**：只对 HTTP 429、5xx 和网络超时重试；400、401、413 不重试，记录并告警。
5. **幂等**：每条线索带 `externalId`。同一个 `externalId` 重发多少次，CRM 都只有一条记录。写法用 `quote:<编号>` 和 `assessment:<编号>`，和方式一保持一致。
6. **密钥**：token 只放服务端环境变量，不进前端代码，不进代码仓库。
7. **后续修改不同步**：线索转发之后，在 Bluven 里再编辑不会同步到 CRM，销售在 CRM 里改。Bluven 里删除线索也不影响 CRM。

---

## 3. 接口定义

### 3.1 地址

```
POST https://crm.bluven.com.au/api/intake/leads
```

token 由 CRM 管理员在 Administration → Lead sources 里为 "Bluven website" 这个来源生成，只显示一次。CRM 侧的这个接口已经实现，本文描述的行为均有自动化测试覆盖。

健康检查（可选，用于发送前探活）：

```
GET https://crm.bluven.com.au/api/intake/health   →  200 {"ok": true}
```

### 3.2 请求头

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer <token>` |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |

### 3.3 请求体

```json
{
  "backfill": false,
  "dryRun": false,
  "leads": [
    {
      "externalId": "1042",
      "createdAt": "2026-11-09T10:21:00+11:00",
      "sourceDetail": "website/quote-form",
      "attribution": {
        "utmSource": "google",
        "utmMedium": "cpc",
        "utmCampaign": "battery-nsw-spring",
        "landingPage": "https://www.bluven.com.au/battery",
        "referrer": "https://www.google.com/"
      },

      "firstName": "Jane",
      "lastName": "Smith",
      "phone": "0412 345 678",
      "email": "jane@example.com",
      "address": "12 Sample St",
      "suburb": "Parramatta",
      "state": "NSW",
      "postcode": "2150",
      "propertyType": "House",
      "components": ["Solar", "Battery"],
      "systemKw": 6.6,
      "batteryKwh": 10,
      "monthlyBill": 350,
      "timeline": "1-month",
      "bestTime": "afternoon",
      "notes": "Referred from our website enquiry form.",
      "householdSize": "4",
      "goals": ["Lower my bills", "Backup during blackouts"],
      "productPreference": "Tesla Powerwall 3"
    }
  ]
}
```

#### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `leads` | array | 是 | 1–200 条线索 |
| `backfill` | boolean | 否 | 默认 `false`。为 `true` 表示历史补录：线索按 `createdAt` 入库，标记为历史数据，不进入待分派池，不触发通知和闲置提醒 |
| `dryRun` | boolean | 否 | 默认 `false`。为 `true` 时只校验不入库，返回格式与正式调用相同，并预测正式调用的结果；会新建的线索 `id` 和 `orderNo` 为 `null`。同一批内互相重复的线索在试运行里不会被识别。联调用 |

#### 线索字段：CRM 新增

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `externalId` | string | **是** | Bluven 的线索编号，最长 64 字符。数字也接受，CRM 按字符串保存。幂等键 |
| `createdAt` | string | 否，建议带 | ISO 8601 含时区，如 `2026-11-09T10:21:00+11:00`。缺省用 CRM 收到的时间 |
| `sourceDetail` | string | 否 | 哪个表单或页面，最长 100 字符，如 `website/quote-form`、`website/contact` |
| `attribution` | object | 否 | 可选子字段：`utmSource`、`utmMedium`、`utmCampaign`、`utmContent`、`utmTerm`、`landingPage`、`referrer`，均为字符串，最长 500 |

#### 线索字段：与 Bluven 现有接口完全一致

| 字段 | 类型 | 必填 | 允许的值 / 规则 |
|---|---|---|---|
| `firstName` | string | 是 | 客户名字 |
| `lastName` | string | 否 | 客户姓氏 |
| `phone` | string | 是 | 8–15 位数字。可含空格、短横线或 `+61` 前缀 |
| `email` | string | 否 | 合法的邮箱地址 |
| `address` | string | 否 | 街道地址 |
| `suburb` | string | 否 | 城区 |
| `state` | string | 否 | `NSW`、`VIC`、`QLD`、`SA`、`WA`、`TAS`、`ACT`、`NT`（大写） |
| `postcode` | string | 否 | 4 位数字，以字符串传 |
| `propertyType` | string | 否 | `House` · `Townhouse / Unit` · `Commercial`（拼写须完全一致） |
| `components` | string[] | 否 | `Solar`、`Battery`、`EV`、`Heat pump`，可多选；也接受单个字符串 |
| `systemKw` | number | 否 | 期望光伏容量 kW。JSON 数字或数字字符串 |
| `batteryKwh` | number | 否 | 期望电池容量 kWh。规则同上 |
| `monthlyBill` | number | 否 | 月电费（澳元）。规则同上 |
| `timeline` | string | 否 | `asap` · `1-month` · `1-3-months` · `researching` |
| `bestTime` | string | 否 | `anytime` · `morning` · `afternoon` · `evening` · `email-only` · `weekend` |
| `notes` | string | 否 | 最多 5,000 字符 |
| `householdSize` | string \| number | 否 | 如 `4` 或 `"3-4"`。也接受 `household_size` |
| `goals` | string \| string[] | 否 | 原样保存；数组自动用逗号拼接 |
| `productPreference` | string \| string[] | 否 | 原样保存。也接受 `product_preference` |

规则与 Bluven 现有接口相同：省略、`null` 或空字符串的字段不保存；未知字段忽略；`state`、`propertyType`、`components`、`timeline`、`bestTime` 严格区分大小写，不合法则该行失败，同批其余线索照常处理。

### 3.4 限制

| 限制项 | 数值 | 超出后的结果 |
|---|---|---|
| 每次请求的线索数 | 1–200 条 | HTTP 400，整批不入库 |
| 请求体大小 | 100 KB | HTTP 413，整批不入库 |
| 每分钟请求次数 | 每个 token 30 次 | HTTP 429，按 `Retry-After` 头重试 |
| 服务端处理时间 | 满批约 10 秒以内 | 客户端超时请设为 60 秒以上 |

### 3.5 响应

HTTP 200 表示这一批已处理完毕，不代表每条都已接收，请逐条检查 `results`。

```json
{
  "received": 3,
  "created": 1,
  "alreadyReceived": 1,
  "duplicates": 0,
  "failed": 1,
  "results": [
    { "index": 0, "ok": true,  "status": "created",          "id": "ord_01JCK8Q0V9X3M2N4P5R6S7T8U9", "orderNo": "BLV-2026-00124" },
    { "index": 1, "ok": true,  "status": "already_received", "id": "ord_01JCK7ZZ1A2B3C4D5E6F7G8H9J", "orderNo": "BLV-2026-00098" },
    { "index": 2, "ok": false, "error": "state: must be one of NSW, VIC, QLD, SA, WA, TAS, ACT, NT" }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `received` | 本批收到的条数 |
| `created` / `alreadyReceived` / `duplicates` / `failed` | 各状态计数 |
| `results[].index` | 该线索在 `leads` 数组中的位置，从 0 开始 |
| `results[].ok` | `true` 已处理，`false` 被拒绝 |
| `results[].status` | 见下表 |
| `results[].id` | CRM 中该订单的唯一标识。建议 Bluven 保存，便于日后对账 |
| `results[].orderNo` | CRM 订单号，形如 `BLV-2026-00124`，销售和经理在界面上看到的就是它，便于人工查找 |
| `results[].error` | 被拒绝的原因，形如 `"<字段名>: <原因>"`，英文 |

`status` 取值：

| 值 | 含义 | Bluven 应如何处理 |
|---|---|---|
| `created` | 新建了客户 / 订单 | 保存 `id`，标记已转发 |
| `already_received` | 这个 `externalId` 之前已经收到过，本次未做任何修改 | 当作成功，保存 `id` |
| `duplicate` | 不同的 `externalId`，但按电话或邮箱匹配到同一客户，且地址相同（或本次没带地址）时该客户已有一张进行中的订单。CRM 没有新建订单，而是把本次内容作为备注追加到那张订单并通知负责销售 | 当作成功，保存 `id` |

HTTP 状态码：

| 码 | 含义 | 是否重试 |
|---|---|---|
| 200 | 已处理，看 `results` | 否 |
| 400 | 请求格式错误：JSON 无法解析、`leads` 缺失 / 不是数组 / 为空 / 超过 200 条、`backfill` 或 `dryRun` 不是布尔值。响应体 `{"error": "..."}` | 否，修请求 |
| 401 | token 缺失或无效 | 否，检查配置 |
| 413 | 请求体超过 100 KB | 否，拆小 |
| 429 | 超过频率限制，带 `Retry-After` 头（秒） | 是，按头部等待 |
| 500 / 502 / 503 / 504 | CRM 侧故障 | 是 |
| 网络超时、连接失败 | | 是 |

---

## 4. 重试策略

| 第几次重试 | 距上次间隔 |
|---|---|
| 1 | 1 分钟 |
| 2 | 5 分钟 |
| 3 | 30 分钟 |
| 4 | 2 小时 |
| 5 | 6 小时 |
| 6 | 24 小时 |

六次仍失败：标记为"转发失败"，发告警（邮件或后台红点），并提供人工"重新发送"按钮。因为有 `externalId` 幂等，重发是安全的。

HTTP 200 中 `ok: false` 的行不是网络问题，不要自动重试。在 Bluven 后台展示错误原因，人工修正数据后再发。Bluven 自己的入库校验和 CRM 一致，这种情况应当很少。

---

## 5. 历史数据补录

1. 把 Bluven 现有全部线索按 `createdAt` 升序导出。
2. 每批最多 200 条，`backfill: true`，顺序发送，每批之间间隔至少 2 秒，确保不超过每分钟 30 次。
3. 预期会出现大量 `duplicate`（同一客户多次咨询），这是正常的。
4. 补录的线索在 CRM 中标记为历史数据，进入"Imported history"视图，经理可以按需分派，不会触发闲置提醒。
5. 补录完成后再开启实时转发，或者实时转发先开、补录随后做，两种顺序都安全。

---

## 6. 联调流程

1. 在 CRM 的 Administration → Lead sources 里为 "Bluven website" 生成 token。没有单独的测试环境时，用 `dryRun: true` 联调，它不会写入任何数据。
2. 用 `dryRun: true` 发一批样例，确认校验通过。
3. 正式发送三类样例：字段齐全的、只有 `firstName` + `phone` + `externalId` 的、故意带错误枚举值的。
4. 幂等验证：同一 `externalId` 连发两次，第二次应返回 `already_received`。
5. 去重验证：同一手机号、同一地址、不同 `externalId` 连发两次，第二次应返回 `duplicate`。
6. 失败路径验证：用错误 token 应得到 401；241 条一批应得到 400。
7. 去掉 `dryRun`，开始正式发送。

---

## 7. 验收标准

- 在 Bluven 网站提交一条表单，60 秒内在 CRM 的未分派池中出现，字段一一对应。
- Bluven 后台能看到每条线索的转发状态（成功 / 失败 / 重试中）和 CRM 返回的 `id`。
- CRM 不可用期间提交的线索，在 CRM 恢复后自动补发成功，无重复。
- 同一线索重复发送不产生重复记录。
- 前端代码中不出现 token。

---

## 8. 安全

- 仅 HTTPS，TLS 1.2 以上。
- token 由 CRM 生成，Bluven 存环境变量。
- 轮换：CRM 可同时接受新旧两把 token 7 天，Bluven 切换后通知 CRM 作废旧 token。

---

## 9. 调用示例

```bash
curl -sS -X POST "https://crm.bluven.com.au/api/intake/leads" \
  -H "Authorization: Bearer $CRM_INTAKE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --max-time 60 \
  -d '{
    "leads": [{
      "externalId": "quote:1042",
      "createdAt": "2026-11-09T10:21:00+11:00",
      "sourceDetail": "website/quote-form",
      "firstName": "Jane", "lastName": "Smith",
      "phone": "0412 345 678", "email": "jane@example.com",
      "address": "12 Sample St", "suburb": "Parramatta", "state": "NSW", "postcode": "2150",
      "propertyType": "House",
      "components": ["Solar", "Battery"], "systemKw": 6.6, "batteryKwh": 10, "monthlyBill": 350,
      "timeline": "1-month", "bestTime": "afternoon",
      "notes": "Referred from our website enquiry form."
    }]
  }'
```

---

## 10. 双方待办

| 方 | 事项 |
|---|---|
| CRM | 已完成：`https://crm.bluven.com.au/api/intake/leads` 与 `/api/intake/health`。上线后生成 token |
| Bluven | 新增后台转发任务与重试队列；线索表加 `crmId`、`forwardStatus`、`forwardAttempts`、`lastForwardError` 字段；后台展示转发状态与"重新发送" |
