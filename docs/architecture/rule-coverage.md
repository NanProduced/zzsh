# 转换规则的证据边界

规则 ID、版本与业务语义以[旧数据转换与字段映射](legacy-data-mapping.md)为准。本页不新增转换规则，不把未处理字段自动提升为必迁移，也不把一次迁移接受扩展成全量或生产验收。

每条规则分别核以下证据，不能合并为一个“已覆盖”勾选：

| 维度 | 足够具体的记录 | 不能替代它的材料 |
|---|---|---|
| 来源与转换 | 已核源字段/单位/时间、目标关系、实际写入符号及规则版本 | 文件存在、关键词、任意 export 或具名空函数 |
| 编排与重跑 | 实际命令/接缝及调用边、输入版本、幂等与冲突处置 | 一个映射模块或未接线的辅助函数 |
| 消费接线 | 页面→客户端/BFF→API→reader 的具体调用与 DTO | 三个文件分别出现同一词 |
| 接受范围 | 固定源码/资源/输入/结果及具名接受回执，保留 NOT_RUN | 目录名、测试数量、健康状态或作者执行 brief |

符号列写实际声明名，不能用文件 basename 代替。只有引用时标候选；没有足够证据时写 UNKNOWN。静态生成器未绑定回执，不表示既有的有限接受被撤回；反过来也不能补写 ACCEPTED 掩盖缺口。

## 已定位的写入入口

- 用户迁移：[`migrateLegacyUserBatch` / `migrateLegacyOwner`](../../apps/api/src/supply/legacy-user-migration.ts)。需要另核各自输入、实际编排、调用边与接受范围；普通会话 reader 不证明执行过用户转换。
- 旧皮肤持有：[`recordLegacySkinHoldings`](../../apps/api/src/supply/legacy-observation.ts)。[`legacy-skin-holdings.ts`](../../apps/api/src/legacy-load/legacy-skin-holdings.ts)提供映射与类型，模块存在不等于它调用写入方，更不证明账号拥有目录中的全部皮肤。

这些是静态入口导航，不是可重跑、页面验收或业务写入授权。其他域沿[结构导航](database-navigation.md)和规则正文逐项核对，不为填满台账新增执行器。

## 回溯与对账

页面与 API 的可读投影、冻结快照、source map/续办证据及源行构成不同层。evidence_ref、source_digest、parameter_digest、facts_digest 分别绑定不同事实，不能互换，也不能由一个字段存在推断全部审计出口齐备。

财务单据 reader 已有 `finalFactsDigest` 投影，见[正式 reader](../../apps/api/src/finance/admin-finance-read.ts)；参数摘要是否进入目标 evidence 仍须单独核对，不能把已有字段报告为完全缺失。新增审计出口须保持权限与对象范围，不公开源口令、凭据或私密原件。

对账按域分列来源总量、已映射、隔离与未处理，数量、金额、责任、单位和时点各自比较。DEFER 表示用途或迁移决定尚待核定，不表示可以丢弃。空库/升级、正式批次、页面真实接线、渠道与上线切换的证据等级保持独立。
