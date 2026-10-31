# 多游戏计价与结算策略抽取（已暂缓）

> 状态：**暂缓实施**（Root 裁决，2026-10-30：UI_SCOPE_ACCEPTED / STRATEGY_IMPLEMENTATION_DEFERRED）。
> 本文用来防止接入第二款游戏时遗漏这项工作。它不是实施计划，也没有授权任何迁移或代码搬迁。

## 1. 通用交易底座与游戏专属规则的边界

| 通用底座（各游戏共用） | 游戏专属（按游戏各自定义） |
|---|---|
| 账号供给、上架审核、租号主流程、订单状态机 | 计价算法（三角洲：哈夫币比例差 haff-ratio-v2、物资单价） |
| 资金、支付、退款、提现、分销 | 结算时的消耗与补差（三角洲：哈夫币消耗、提前结束补差） |
| 押金收取与返还（订单只保存押金金额） | 推荐押金算法的输入（保险箱、体力、负重、皮肤类型与品质） |
| 规则版本骨架：价格 / 租期 / 协议版本，草稿→封存→Boss 组合生效 | 账号属性声明、目录（皮肤、改枪码、物资） |
| 协议与披露接受（见 agreements-acceptance.md） | 游戏服务开关（`game-services.ts`） |

## 2. 现状：三角洲耦合事实（基于 dev e1617bff）

- `computeDeltaQuote` 有 7 处直接调用：`auth/membership-growth-integration.ts:560,568`、`auth/membership-growth.ts:1176`、`supply/owner-income-preview.ts:192`、`supply/publishing.ts:1148`、`supply/rules.ts:573`、`order/personal-confirmation.ts:183`。
- `order/settlement.ts:228` `computeSettlement` 直接依赖哈夫币字段：`haff` 库存行、`haffConsumedBuyer/Owner`、`haffSpread`、`unusedHaffRefund`、`platformHaffSpread`（同文件 :27-98），并读取 `InternalQuote.pricingInputs.exactRatios`。
- `order/settlement-record.ts` 负责结算锁定（`lockSettlement`）、开局记录与确认（`recordOpening`/`confirmOpening`）、预览与提交（`previewSettlement`/`submitSettlement`）、客服结算（`previewStaffSettlement`）以及响应投影。它是结算唯一的写入方。
- `supply/pricing.ts:101` `InternalQuote`：`pricingInputs` 里有 `compatibility`（来自 delta-rental）、`haffRatioSchema`、`denominators`、`spreadDelta`、`exactRatios`，所以契约本身带有三角洲字段。
- 迁移 `0078_personal_quote_v4.sql`：数据库函数逐个键严格校验 `quote_snapshot.personal`（11 个键）、`ruleRefs`（5 个键）、`funding`（7 个键）。改动快照结构必须同时提升 schema 版本并新增迁移。
- `supply/game-services.ts:14` `CODE_SUPPORTED` 只登记了 `delta: [ACCOUNT_RENTAL, GUNSMITH]`。这是现有的游戏能力入口，新游戏只能从这里登记。

## 3. Root 裁决（2026-10-30）

- 暂缓。**触发条件**（满足其一）：已确认第二款游戏的计价/结算合同；或出现可以复现的跨游戏缺陷。
- 不预留迁移号。
- `games/delta/` 只是候选目录约定，不是规范。
- 不做插件、注册表或通用 schema 引擎。
- 在此之前只做管理端信息架构（Step 0），后端行为不变。

## 4. 将来抽取的验收条件

1. 新旧两个纯计算函数（计价、结算）在**冻结输入**上做逐字段精确比对，差异必须为 0（分、8 位小数比率、HALF_UP）。
2. 影子路径只计算、对比、记录，**从不写库**；旧实现在整个对比期内是唯一写入方。
3. 快照结构有版本号（`schemaVersion` / `personal-quote-vN`），新旧快照可以并存读取；能回滚到旧实现，且不需要改写历史订单。
4. 对比期时长和样本口径由 Root 在启动时确定。

## 5. 当前数值只属于三角洲，不是全局常量

以下数值目前保存在三角洲的价格版本中，或写死在校验里（`supply/funding-policy.ts:171,195,197`）。新游戏不能默认继承：
- 押金上限 ¥2000（capCents = upperLimitCents = 200000）；
- 押金最低值：普通 ¥0.01、全额包赔 ¥300；推荐押金取整 CEIL、¥50；
- 比例差：普通 8、极速 12；
- 会员四档 discounts（`delta-rental.ts:26-27,193-197` 的校验要求必须提供这些键）。

## 6. LoL / Valorant 待确认问题

- 没有游戏内货币消耗，是否只按时长加物品计价？结算时有没有需要补差的消耗项？
- 推荐押金的输入是什么：英雄/皮肤数量、段位、稀有皮肤？
- 账号属性（段位、区服、绑定方式）是否需要进内容哈希和快照？
- 协议与包赔条款是否按游戏区分版本？
- 皮肤目录能否复用现有 skin / rarity 表结构？

## 7. Step 0 已落地的游戏入口（2026-10-30）

- 管理端按游戏 `code === "delta"` 解析三角洲，其他游戏的规则与价目页面显示“未适配”，不会套用三角洲的表单。
- 后端所有 `supply.rules.*` 写操作在预检阶段调用 `assertRulesGameSupported`（`supply/game-services.ts`）：游戏不存在返回 404，游戏未登记 `ACCOUNT_RENTAL` 返回 409 `UNSUPPORTED_GAME_SERVICE`。测试见 `apps/api/test/rules-game-gate.test.ts`。
- 报价预览（quote-preview）等只读计算暂未加这道闸门；接入第二款游戏时要一并补上，并按第 4 节的验收条件做策略抽取。
- 接入新游戏的检查清单：① 在 `CODE_SUPPORTED` 登记服务；② 确认第 6 节的问题；③ 定义该游戏自己的价格版本结构和数值（第 5 节）；④ 拆分计价/结算策略后，再开放管理端页面。
