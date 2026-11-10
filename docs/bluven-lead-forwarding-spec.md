# Bluven 网站 → CRM 线索转发接口规范

版本：v1.2
日期：2026-11-10
读者：Bluven 网站的开发者
配套文档：`docs/sales-crm-design.md` 第 5 节

---

## 1. 目标

Bluven 网站每收到一条新线索，立即转发一份到 CRM。Bluven 仍然是线索的入口和第一落库点，CRM 是销售跟进的系统。转发失败不能影响 Bluven 自己的入库。

这个接口的请求体和 Bluven 现有的"线索导入 API"**同构**：字段名、枚举值、校验规则、限制、返回格式都一致，只多了几个可选字段。Bluven 现在怎么组装线索对象，就可以原样发给 CRM。

---

## 2. 总体要求

1. **触发时机**：线索在 Bluven 入库成功后，由后台任务异步发送。不要放在用户提交表单的那个 HTTP 请求里，用户不应该等 CRM。
2. **顺序**：单线程顺序发送，不并发。
3. **批量**：实时转发每次发 1 条即可；历史补录每次最多 200 条。
4. **重试**：只对 HTTP 429、5xx 和网络超时重试；400、401、413 不重试，记录并告警。
5. **幂等**：每条线索带 `externalId`（Bluven 线索编号）。同一个 `externalId` 重发多少次，CRM 都只有一条记录。
6. **密钥**：token 只放服务端环境变量，不进前端代码，不进代码仓库。
7. **后续修改不同步**：线索转发之后，在 Bluven 里再编辑不会同步到 CRM，销售在 CRM 里改。Bluven 里删除线索也不影响 CRM。

---

## 3. 接口定义

### 3.1 地址

```
POST https://<CRM 域名>/api/intake/leads
```

测试环境和正式环境分别提供地址，各有独立的 token。域名由 CRM 侧确定后提供。

token 由 CRM 管理员在 Administration → Lead sources 里为 "Bluven website" 这个来源生成，只显示一次。CRM 侧的这个接口已经实现，本文描述的行为均有自动化测试覆盖。

健康检查（可选，用于发送前探活）：

```
GET https://<CRM 域名>/api/intake/health   →  200 {"ok": true}
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

1. CRM 侧提供测试地址和测试 token。
2. 用 `dryRun: true` 发一批样例，确认校验通过。
3. 正式发送三类样例：字段齐全的、只有 `firstName` + `phone` + `externalId` 的、故意带错误枚举值的。
4. 幂等验证：同一 `externalId` 连发两次，第二次应返回 `already_received`。
5. 去重验证：同一手机号、同一地址、不同 `externalId` 连发两次，第二次应返回 `duplicate`。
6. 失败路径验证：用错误 token 应得到 401；241 条一批应得到 400。
7. 切换到正式地址和正式 token。

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
- 可选：Bluven 提供服务器出口 IP，CRM 加白名单。

---

## 9. 调用示例

```bash
curl -sS -X POST "https://<CRM 域名>/api/intake/leads" \
  -H "Authorization: Bearer $CRM_INTAKE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --max-time 60 \
  -d '{
    "leads": [{
      "externalId": "1042",
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
| CRM | 确定正式 / 测试域名；生成两把 token；上线 `/api/intake/leads` 与 `/api/intake/health` |
| Bluven | 新增后台转发任务与重试队列；线索表加 `crmId`、`forwardStatus`、`forwardAttempts`、`lastForwardError` 字段；后台展示转发状态与"重新发送"；可选提供出口 IP；告知历史线索总量以估算补录时间 |
