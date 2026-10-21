# 结构与权限核对边界

迁移与权限的正式入口是 [business-migrations.ts](../../apps/api/src/database/business-migrations.ts)、[启动身份检查](../../apps/api/src/database/business.ts) 和 [业务迁移目录](../../apps/api/migrations/business)。本页规定核对与恢复要求，不表示仓库已安装通用 SQL/ACL 校验器，也不代表任何目标库已通过验收。

## 期望与观察分开

- 期望来自实际授权源码与迁移中对 PUBLIC 的收敛，按调用顺序合成。不得按物理行号排序，也不得从观察结果反推“期望”。存在性探针、互斥分支和源文件摘要必须绑定。
- 观察来自指定资源的只读 catalog。绑定资源、角色、迁移集合和观察时点；一个库的快照不能证明另一个库或后续状态。
- 录制遇到未建模语句或不完整输入时，必须保留 UNKNOWN/NOT_VERIFIED 并阻止“全部通过”；拒绝输出须明确替换本次结果，不能留下旧成功文件冒充新结果。

## 权限核对

| 维度 | 必须区分的事实 |
|---|---|
| 关系与列 | 按对象、列、操作双向核对；缺必需权限与多余权限分别报告。表级 REVOKE 不等于撤销列级 GRANT |
| 函数 | 身份含 schema、名称和完整输入类型；另一个重载不能顶替。NULL proacl 不代表无权限，须核 PUBLIC 默认 EXECUTE |
| schema、序列 | 核各自操作及对象归属，不能用关系授权替代 |
| 角色与属主 | 运行角色属性、成员边、关系/schema/函数属主分别检查。零成员合同不需要猜测 PG16 继承语义 |
| PUBLIC 与授予选项 | PUBLIC 单列；同 grantee 多 grantor 的权限取并集，GRANT OPTION 另核 |
| 默认 ACL | 以创建角色、全局/指定 schema、对象类型为身份。只约束未来对象，不能替代现有对象权限 |

观察中的关系 owner 不证明谁执行过 DDL；若据它构造默认 ACL 期望，必须标为假设。没有 PG16 inherit/set 信息时，成员有效权限保持未核；不能用一份不含这些信息的快照宣称支持完整继承模型。

## 结构身份

先核完整对象身份，再核支持范围内的属性。函数区分输入签名，触发器包含目标表，约束包含 schema 和目标表。创建、修改、删除、重建是不同事件，累计定义次数不等于当前对象数。

缺少同名对象时，相同列名集合、相同约束类型或“都有部分索引谓词”不足以证明改名。候选保持 NAME_NOT_VERIFIED，未认领观察单列；有序键等已知属性能证相异时，分别报告 MISSING 与未认领对象。标识符达到 63 字节只提示需要核身份，不证明发生过服务端改写。

CHECK、函数、触发器体未归约时，身份存在与定义等价分别标注。LIKE 克隆只能解释该克隆表自身对象，不能豁免整个 schema。

## ACL 失败恢复

`runBusinessMigrations` 先完成 DDL 迁移，再单独开启 ACL 事务；`applyRuntimePrivileges` 自身不拥有事务。

| 结果 | 已知与未决 |
|---|---|
| `ACL_NOT_COMMITTED` | ACL COMMIT 未尝试发出；只有 `rollbackAcknowledged=true` 才能称回滚已确认。未确认时保留原 cause/rollbackError，不断言旧权限状态 |
| `ACL_COMMIT_UNKNOWN` | 已尝试 COMMIT 但未确认；DDL 已提交，ACL 结果 UNKNOWN，坏连接退役，禁止自动重试或改报成功/已回滚 |

只重放 ACL 前，维护者须确认精确资源和角色身份、已应用迁移及源码摘要、当前权限观察与处置范围，并使用新连接和明确事务边界。GRANT/REVOKE 是权限收敛，不会生成第二份资金记录；这也不构成遇到 UNKNOWN 自动重放的理由。

空库、已有前缀升级、真实断连、只重放 ACL 与跨库对照分别验收。离线对照和合成反例不能替代这些运行证据。资源与授权仍遵守[本地 PostgreSQL 规范](../local-postgresql.md)。
