# 公开租号列表查询与筛选配置

## 接入

先读取 `GET /api/v1/supply/games/{gameId}/listing-filters`。`available=false` 时按 `FILTERS_UNCONFIGURED`、`RULES_UNCONFIGURED` 或 `SIGNING_UNCONFIGURED` 展示不可用状态，不生成虚假选项。

列表保持 `GET /api/v1/supply/listings`，通过 `queryVersion=2` 显式选择新协议。Web 路径为 `/api/supply/...`，API 用户 BFF 为 `/api/bff/user/supply/...`。匿名可读；BFF 只适配路径、Cookie 和公开链接，不计算筛选或价格。

请求例（ID 来自 metadata，filters 由 URLSearchParams 编码）：

```js
const query = new URLSearchParams({
  queryVersion: '2', gameId: metadata.gameId,
  filterRevision: metadata.filterRevision,
  catalogRevision: metadata.catalogRevision,
  ruleReleaseId: metadata.ruleReleaseId,
  sort: 'latest', direction: 'DESC', limit: '20',
  filters: JSON.stringify({resources: [{itemId, minQuantity: '20000000', maxQuantity: '80000000'}]})
});
const page = await fetch('/api/supply/listings?' + query).then(r => r.json());
```

第一批可省略三个 revision 引用，服务端返回当前版本；后续 cursor 自动绑定。公开 metadata 包含允许字段、操作、选项、目录 ID/基础单位、排序和限制。皮肤沿 `skinCatalogUrl` 的既有分页目录读取，未绑定 mediaId 仍可筛选；不返回后台来源或内价。

浏览器账号列表地址为 `/accounts`，并以地址栏作为可分享筛选的权威输入。参数按固定顺序序列化为 `game`、`q`、`filters`、`sort`、`direction`、`coreItemId`、`view`；省略空值与默认值，默认 `latest`/`DESC`/`list` 不写入，`coreItemId` 仅随 `coreQuantity` 写入。`filters` 沿用规范化 JSON，资源上下限、皮肤分类及 `ANY`/`ALL` 语义不丢失；语义无序集合去重并稳定排序。分享地址不包含 metadata revision、Token、分页 cursor、已加载页链或 `limit`。

首次打开、F5、收藏、新标签页、前进/后退均从 URL 恢复筛选、排序和显示模式，并用当前 metadata 重验；裸 `/accounts?game={gameId}` 表示无筛选，不得被旧 sessionStorage 条件覆盖。筛选改变使用 `history.replaceState`，前进/后退通过 `popstate` 重新导入 URL；输入控件沿用现有 250–350ms debounce，初始化期间不得让空状态覆盖链接条件。sessionStorage 仅保留滚动/详情返回体验信息，返回快照绑定规范化 URL 条件与游戏，并可携带合法 cursor 链；主动刷新清除该重放意图，从相同条件的最新第一页读取。

页面地址与后台查询分别构造：页面分享 URL 不写 `cursor`/`limit`，后台仍通过同源 Web BFF 发出 `queryVersion=2` GET，实际筛选、排序和 cursor 只在该请求中传递。旧 `filters` 长链接继续解析；无效、过期或 metadata 不可用条件提示并保留仍合法项，不静默改成另一组筛选。各跳 request-target UTF-8 长度仍不得超过8192字节；超限提供可操作提示，不丢弃条件或引入短链/压缩格式。分页加载更多不改分享 URL；“刷新结果”保留 URL 条件、排序和模式，取消旧请求并从第一页读取，不追加迟到旧页。

Web 客户端的预算校验与 `listingQuery` 共用序列化：分别计算 `/accounts...` 页面、`/api/supply/listings?...`、`/api/bff/user/supply/listings?...` 和 `/api/v1/supply/listings?...` 的 UTF-8 request-target，并使用当前 metadata 的 `limits.urlBytes`。首屏恢复、筛选变化和发请求前均检查；分页检查包含当前 cursor。页面未超限但任一 BFF/API 超限时保留可编辑条件、不发起该请求；分页超限进入明确错误状态，停止 sentinel 自动重试，减少条件后重新从当前筛选首屏读取。

## 有限筛选合同

`gameId` 必填，目前仅 Delta。`q` 沿用既有标题搜索。filters 只接受下表字段；类目间 AND。

| 字段 | 结构与语义 |
|---|---|
| resources | `[{itemId,minQuantity?,maxQuantity?}]`，每行至少提供一端；同资源两端是闭区间并作用于同一库存行，不同资源 AND |
| safeBoxCodes / gradingCodes / loginMethodCodes | code 数组，同类 OR |
| vitality / bear | `{min:6}`，目录规则及配置允许的等级下限 |
| regions | `[{province,city}]`，成对 OR，禁止省市笛卡尔组合 |
| skinGroups | `[{categoryId,ids,match:'ANY'或'ALL'}]`，组间 AND，皮肤必须属于当前可见分类或其子分类 |
| serviceWindow | `{startMinute,endMinute,crossMidnight,timezone:'Asia/Shanghai'}`，账号时段完整覆盖请求时段 |

资源上下限均包含边界；只填一端合法，两端相等表示精确数量，未提供的端点不施加约束。每个提供的端点按当前 metadata 对应资源的配置 min/max 校验；空条件不发送，只有 `itemId` 的行非法。资源数量是 numeric(24,0) 范围内的非负整数文本，不接受浮点、指数、负数、前导零或客户端 unit；0 有效，未知/缺失库存不能按 0 满足上限。目录 HAFF_BASE 按基础币传输；M 展示换算为 1,000,000 基础币，60 发/组由客户端明确换算为 ROUND；DAY 保持天数，不乘租期。金额只使用服务端 quote。

公开 metadata 的可选 `resourceQuantityRange` 能力仅在值为 `true` 时表示可提交 `maxQuantity`。`false` 或字段缺失代表兼容的 min-only 能力：客户端保留合法下限、剔除上限，并提示条件已按当前规则调整；上限单独存在时该资源条件移除。旧 v1 与旧 v2 min-only 请求及已有 `AND_MIN` 配置保持兼容。服务端按每个已提交端点校验配置，不为缺失端点补默认约束。

时段起点 0–1439，终点 0–1440；终点小于起点才允许跨午夜，按两段覆盖。0→1440 是全天，等起止非法。旧未知/矛盾时段在启用过滤时不命中，不改历史 payload/hash。

所有单值查询参数不可重复，未知参数/重复条件拒绝。集合排序规范化、空数组视为不筛选，null 不是 0。资源最多16行、皮肤最多8组/50个不同ID、其他枚举最多50项、地区最多20对。v2 不可混用旧 itemId/minQuantity/skinId/skinMatch。各跳实际 request-target UTF-8 长度不得超过8192字节；BFF前缀较长，客户端不能只按浏览器短路径顶满预算。

## 排序与分页

| sort | 排序真值 |
|---|---|
| latest（默认 DESC，“最新发布”） | 当前公开版本最新 APPROVE 的 decided_at，保留微秒 |
| resourceTotal | 冻结的 STANDARD 买家资源总价，不含押金和个人优惠 |
| coreQuantity | 明确 coreItemId 的基础库存数量，只允许配置内同游戏 HAFF_BASE 项 |

支持 ASC/DESC，均 NULLS LAST，accountId ASC 打平。过滤及排序在全体 SQL 候选上执行，再取最多200条做现有公开资格校验。不支持综合推荐、任意页码或 total。

响应包含 `items,nextCursor,queryVersion,sort,direction,sortLabel,filterRevision,catalogRevision,ruleReleaseId,scannedCount,scanBudget:200,scanBudgetReached,limit`。limit 默认20、范围1–50。资格失败也推进 cursor；空 items 加非空 nextCursor 不是结束。下一次照传 cursor，直至 null；刚好200条可能多返回一个终止空页。

cursor HMAC-SHA256 使用独立 audience、keyId 和 `LISTING_CURSOR_SECRET`（或 `_FILE`）/`LISTING_CURSOR_KEY_ID`，secret 至少32字符且不能复用认证或个人确认秘密。缺配置拒绝 v2，但不影响 v1。cursor 有界且签名，包含精确排序键、NULL标记、accountId、游戏、规范化筛选摘要（资源上下限均绑定）、排序和三个revision。旧 min-only 条件规范化保持兼容；上限变化会改变筛选摘要，不能复用旧 cursor。view=list/card 不改变摘要；limit 可变。keyset 不承诺跨请求冻结数据库，客户端按稳定 accountId 去重。

| HTTP / code | 处理 |
|---|---|
| 400 INVALID_ARGUMENT + details.path | 修正未知/超限/非法条件，或畸形/篡改 cursor |
| 409 CONFLICT | cursor 的版本、筛选、排序或规则/目录/配置已变化，重新读取 metadata；不得静默清条件 |
| 503 LISTING_QUERY_UNAVAILABLE | 签名、规则或筛选配置不可用，等待维护 |
| 403 / 404 | 沿既有权限、游戏服务及对象可见性合同 |

无 queryVersion 的 v1 保持既有排序、limit、cursor 错误和重复 skinId 合同；v1/v2复用候选筛选构造及公开资格快照。

## 管理配置

Admin 原生 `/api/v1/admin/supply/games/{gameId}/listing-filters`，管理 BFF `/api/bff/admin/supply/games/{gameId}/listing-filters`。GET 返回当前配置和最近20个历史版本；PUT 接收 `{expectedRevision,config,reason}`。POST 同路径 `/restore` 接收 `{expectedRevision,restoreFromRevision,reason}`。写请求须 Idempotency-Key，revision 为十进制字符串，首次 expectedRevision 为 `"0"`。

config 固定 `{schemaVersion:1,fields,sorts}`。field 具有 key/operator/label/enabled/order，参数按类别限定为 items（itemId/min/max）、options（value/label）、levels、regions、categoryIds；serviceWindow 无额外参数。sort 具有 key/label/enabled/order，只有 coreQuantity 接受 itemIds。latest 必须启用且名称保持“最新发布”。不接受 SQL、任意路径、脚本或新增操作逻辑。

读写均要求 `supply.listing_filters.manage` 及游戏范围，权限不默认授予客服。按游戏锁、expectedRevision CAS、既有幂等和审计事务追加不可变 revision；审计失败整笔回滚。恢复复制历史并用当前白名单/目录重验，生成新 revision，不重新启用旧编号。默认配置需明确保存，不自动注入生产游戏或价目。

0042 仅增加不可变配置表/守卫和窄权限。配置 revision、catalog revision、rule release 分别绑定，不复制目录。

公开皮肤图片必须同游戏、PLATFORM_CATALOG/SKIN_MEDIA、已审核且允许公开，并有公开衍生文件；不合格绑定投影为无图。媒体撤回、拒绝或转私有会解除绑定，同一事务内每个实际受影响游戏的 catalog revision 只递增一次，无绑定不递增。旧公开图片 URL 沿权限合同失效，旧目录/列表 revision 引用需刷新。历史报价/presentation不随目录变动重写。管理配置页面及皮肤图片选择 UI 尚未实现。

账号列表保留“刷新结果”动作，筛选链接由用户直接复制浏览器地址栏；页面不提供独立复制按钮或复制结果提示。
