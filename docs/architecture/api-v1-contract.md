# API v1 契约基线

API v1 使用以下稳定约定；具体端点以代码生成的 OpenAPI 为准。

## 范围与边界

- 第一个真实业务接口使用 `/api/v1/...`；`/api/health` 继续是独立 liveness 探针，不参与业务版本或 readiness 语义。
- NestJS 业务层只依赖 JSON、HTTP header 和服务端校验，不依赖 Cookie、DOM、Next.js Server Actions 或小程序运行时。
- 订单业务仍未完整实现，尚未创建订单、资金、认证、数据库幂等表或 provider 调用。
- OpenAPI 与运行时校验在 `apps/api/test/api-contract.test.ts` 的隔离 Nest app 中验证；该 probe controller 不在生产 `AppModule` 注册，不能作为生产测试写路由。
- probe 的严格请求 schema 使用显式 ApiBody 声明；DTO 本身不会自动禁止所有未知字段。首个真实业务 controller 必须声明对应约束并验证其实际生成 schema，不得把测试示例通过当成业务文档自动一致。

## JSON 类型

### ID

ID 以 opaque 字符串传输，允许 `A-Za-z0-9` 开头，后续使用 `A-Za-z0-9._:-`，最长 128 个字符。客户端和服务端都不得把 ID 当数字解释；例如 `1e3` 可以作为字符串 ID 通过校验，但不是指数数值。空白、超长值或任意对象均拒绝。

### 金额

当前契约示例固定使用：

```json
{
  "currency": "CNY",
  "unit": "yuan",
  "amount": "123.45",
  "scale": 2
}
```

`amount` 是不使用浮点的十进制字符串，必须有两位小数；`currency`、`unit` 和 `scale` 一起明确币种、单位和精度。服务端业务接入其他币种前必须为该币种另定单位与精度，不能只放宽正则。

### 时间

当前支持的 RFC 3339 子集为 `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`，年份为 0001–9999，fraction 最多 9 位；日期按真实月长和闰年校验，时分秒分别限制为 00–23、00–59、00–59，offset 小时/分钟限制为 00–23/00–59。没有时区的本地时间、`2026-02-30` 这类不存在日期和任意数字时间戳均拒绝。

### 分页

请求使用可选 `cursor` 和 `limit`；`limit` 范围为 1–100，默认 20。响应返回 `items`、`nextCursor` 和实际 `limit`。真实业务接入时必须定义稳定排序及 cursor 的失效/过期语义；不能用页码漂移替代稳定 cursor。

## 错误与 requestId

错误统一为：未知字段不会原样进入 `details.path`；顶层、金额对象和分页对象分别只返回固定的 `body`、`amount`、`page` 路径，最多返回 8 条安全问题。

错误统一为：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Request validation failed",
    "requestId": "req_contract_001",
    "details": [
      { "path": "amount.amount", "code": "INVALID_FIELD" }
    ]
  }
}
```

机器流程只匹配稳定 `code`，不匹配中文或其他展示文案。`X-Request-Id` 可由调用方提供，但必须符合安全 token 格式；缺失或非法时由服务端生成新的 `req_...` 值，并在响应 header 与错误 body 中保持一致。未知异常只返回 `INTERNAL_ERROR` 和 requestId，不返回堆栈、原始异常、凭据或原始输入。

当前保留的错误码包括 `INVALID_ARGUMENT`、`MISSING_IDEMPOTENCY_KEY`、`IDEMPOTENCY_KEY_REUSED`、`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED` 和 `INTERNAL_ERROR`。401/403/404/409/429 使用各自稳定码和固定安全文案，不映射为 `INVALID_ARGUMENT`。业务模块可以增加稳定码，但不能复用已有码表达不同语义。

## 幂等键

有副作用的业务请求必须带 `Idempotency-Key`。服务端按“已验证主体 + operation + resourceId（如有）”形成作用域，客户端不能通过 `userId` 或任意 `X-User-*` header 冒充主体。当前只落地纯契约函数，不建立数据库记录，也不宣称已完成跨进程幂等：

| 条件 | 契约结果 |
|---|---|
| 作用域或 key 不存在历史记录 | 执行一次，记为 `new` |
| 同一作用域、同一 key、请求 fingerprint 相同 | 返回原结果，记为 `replay` |
| 同一作用域、同一 key、fingerprint 不同 | 拒绝并返回 HTTP 409 / `IDEMPOTENCY_KEY_REUSED` |
| 不同作用域使用同一 key | 视为另一请求，不能互相重放 |

fingerprint 由服务端对规范化请求计算，不由客户端提交。支付、退款等业务接入时仍须将该契约与事务、持久化记录、超时和回调事实联合设计。

## 验证入口

```powershell
npm test -w @zzsh/api
npm run typecheck
```

测试会创建只监听 loopback 临时端口的隔离 Nest app，检查 OpenAPI 的请求/响应示例、header、resourceId pattern/maxLength、integer limit、错误码 enum、`additionalProperties:false` 以及运行时拒绝和安全错误兜底；不会连接数据库或第三方服务。`npm run check` 仍使用默认离线入口。
