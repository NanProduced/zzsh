# ADR：FND-003 Drizzle 与 PostgreSQL 数据访问验证

状态：ACCEPTED（FND-003 返修经 Master 审核通过；本地数据访问选型冻结，不代表生产验收）

本轮修正对应首轮审核：身份失败不执行 DDL；持锁异常先释放 holder，再有限等待/回滚 waiter；真实数据库验证改为显式 `test:db`；默认 `test/check` 保持离线；最终连接参数经 `test` profile 校验。Master 独立复跑 test:db 2/2 和完整 check（离线 10/10、构建、smoke）通过，选型冻结；完整边界见 [Tracker 最终审核](../planning/rebuild-development-tracker.md)。

日期：2026-09-09

## 通过判据

本卡只允许在已核验的 zzsh 本地 PostgreSQL 上运行。测试必须使用
`127.0.0.1:55432`、用户 `zzsh` 和独立数据库 `zzsh_test_fnd003`；该库名先经
现有 `test` profile 的边界校验，再以 `postgres` 维护库核验当前数据库、用户和
服务端身份，再创建或复用该测试库。
不得连接 `zzsh_dev`、Claread 或其他目标。缺少本地配置、凭据、数据库或身份
不匹配时，命令必须失败，不能跳过或改用内存数据库。

通过必须同时满足：

1. Drizzle migration 资产位于 `apps/api/test/`。首次执行创建测试 schema，
   第二次执行成功且不新增 migration 记录；不创建正式业务表或正式迁移目录。
2. PostgreSQL 事务提交后的行可见；事务中抛出受控错误后完整回滚，失败行不可见。
3. 两条真实 PostgreSQL 连接竞争同一唯一键时，确定性地得到一个成功和一个
   `23505` 唯一约束失败，不能以应用内存锁替代。
4. 一条连接持有 `SELECT ... FOR UPDATE` 行锁时，另一条连接的更新必须被
   PostgreSQL 观测为等待；提交释放后等待更新完成。同步使用数据库锁状态和
   事件/Promise，不使用随意 sleep。
5. `numeric` 金额以十进制字符串写入并读回完全相等，覆盖超过 JavaScript
   安全整数范围的值，不经浮点转换。
6. 只有 test profile、数据库身份、数据库 owner 和 schema owner 均核验通过，
   才允许清理本卡 schema；身份失败只关闭连接，不执行 `DROP`/`CREATE`。验证
   持有本库 advisory guard，第二个验证立即失败，不能互相清理同一 schema。
   不删除卷、不清理其他项目资源、不输出凭据。重复运行仍从首次 migration
   状态开始。

## 选型结论

本卡只评估 Drizzle 在真实 PostgreSQL 上的 migration、事务、约束、锁和精确
数值行为，不建立通用 repository 抽象。以上判据已在本地隔离 PostgreSQL 全部通过，
Master 已冻结 Drizzle 作为后续数据访问层选型，由后续任务按真实业务
边界落地；本卡不横向扩展 Prisma，也不建设迁移/reset 框架。

## 实际版本与证据

版本：`drizzle-orm@0.45.2`、`pg@8.23.0`、`@types/pg@8.23.1`、
Node.js `v24.20.0`、npm `11.19.0`、PostgreSQL `16.13`（`postgres:16-alpine`）。
Docker Engine `29.5.3`、Compose `5.1.4`；zzsh PostgreSQL 仅绑定
`127.0.0.1:55432`，测试 Redis 端口为 `127.0.0.1:56379`。测试先以现有配置
机制构造 `APP_PROFILE=test`、`PROVIDER_MODE=fake`、`DB_NAME=zzsh_test_fnd003`，
通过 `loadConfig` 后核验维护库 `postgres`、角色 `zzsh`、服务端端口 `5432`，再
创建或复用 owner 为 `zzsh` 的该测试库；未连接 `zzsh_dev`、Claread 或其他目标。

实际证据：

- `rtk npm test -w @zzsh/api`：退出码 `0`；默认链路不加载 `.env`、不连接
  PostgreSQL，运行 10 项 Node 测试，`10 pass / 0 fail`，包含身份失败时不执行
  `DROP`/`CREATE` 的离线断言。
- `rtk npm run test:db -w @zzsh/api`：FND-003 冻结时显式运行 2 项测试，包含
  离线安全断言和真实 PostgreSQL 验证；当前工作树该入口又包含 FND-004 的
  数据库测试，复跑结果为 4 项全通过。真实 FND-003 测试对 test profile
  目标 schema 首次及重复运行 migration，验证事务提交/回滚、真实连接的
  唯一键竞争和 `23505`、`pg_blocking_pids` 观测到的行锁等待/提交释放、
  持锁异常时 holder 先释放且 waiter 在有限超时内收敛，以及 numeric
  十进制字符串 `12345678901234567890.123456789` 原样读回。
- 缺配置检查：不加载 `.env` 直接执行编译后的 `database.test.js`，退出码 `1`，
  返回 `DB_HOST is required`；没有静默跳过或发起数据库连接。
- `docker compose -p zzsh-rebuild-local exec -T postgres ... SHOW server_version`：
  退出码 `0`，返回 `16.13`。测试只在核验后的 `zzsh_test_fnd003` 内创建并清理
  `fnd003` schema，保留空测试库供重复运行；未删除卷或重启容器。
- 根 `rtk npm run check`（底层 `npm run check`）：退出码 `0`；默认离线测试、
  类型检查、三端构建和 smoke 全部通过，未接入 `test:db`。CI/统一数据库接入
  留给 FND-008。

局限：证据只代表当前本地 Compose PostgreSQL，不代表托管生产版本、ECS 网络、
备份恢复、故障切换、性能容量、正式业务 schema 或 provider/真实渠道。迁移 SQL
和 migration 元数据刻意放在 `apps/api/test/fixtures/`，不能当作业务迁移资产。
