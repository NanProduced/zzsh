# 本地 PostgreSQL 使用规范

本规范适用于所有开发、测试、浏览器验收与 Master 复核任务。服务启停另见[本地环境规则](local-environments.md)。

## 资源层次

- PostgreSQL 实例固定为本项目 Compose 的 `127.0.0.1:55432`，不使用其他项目的5432。
- `zzsh_dev` 是主开发库，不是测试清理目标；`postgres` 是维护连接库。两者默认保留。
- 测试以独立 **database** 隔离；库内 `zzsh_iam`、`zzsh_supply` 等 **schema** 由正式迁移创建，不按每个用例再建一套schema。
- 数据库、迁移角色、runtime角色与advisory lock组成一个资源组，不能只换锁而仍操作同一库。

## 命名与复用

优先使用测试入口已有的资源集参数，不另写随机建库脚本：

```powershell
$env:SUPPLY_TEST_RESOURCE_SET = "m3d_web"
$env:M2_AUTH_TEST_RESOURCE_SET = "m3d_web"
# 仅已包含内容套件的分支使用 CONTENT_TEST_RESOURCE_SET
$env:CONTENT_TEST_RESOURCE_SET = "m3d_web"
npm run check
```

资源集使用简短任务名（小写字母开头，字母/数字/下划线，总长不超过21）。各套件保留已有命名规则，例如 `zzsh_test_supply_<资源集>`、`zzsh_test_m2_auth_<资源集>`。不得为了统一外观重命名既有库或篡改归属标记。

同一任务的实现、返修、Master复验优先串行复用同一资源组。不要为r1/r2/final/重试反复建库；只有确需并发或首次迁移空库验证时另登记一组。浏览器需要保留人工验收数据时单独用 `<任务>_ui`，不与会清数据的回归套件共库。

默认无资源集的固定测试库用于单维护者串行回归；多agent不得同时运行默认入口。锁占用即退出/等待协调，不抢锁、不终止别人连接、不增加随机后缀规避冲突。

## 登记是使用前提

当前资源清单只维护在主检出 `tmp/postgresql-resources.md`，环境端口仍登记在 `tmp/local-environments.md`。不要在每个worktree复制一份互不一致的清单。

新资源使用前登记：任务/维护者、资源集、准确库名、角色名、标记与锁规则、用途、可否重置、状态及清理条件。可以在套件首次创建后补回实际标识，但必须先登记预留。配置内容和密码不得写入清单。

状态只使用：`ACTIVE`（在用）、`REVIEW`（保留待复验）、`KEEP`（主库/固定入口/Owner验收）、`CLEANUP_READY`（任务已整合且无使用者）、`UNKNOWN`（归属待核）。REVIEW须写对应评审入口与下一步，不无限期写“留供复验”。

## 测试与清理

1. 测试前核对本机目标、库名、数据库COMMENT归属标记及角色标记；不符即失败，不接管无标记旧库。
2. 测试过程中只清理本套件明确列出的表；保留现有事务、授权和审计测试边界，不用TRUNCATE CASCADE扩大范围。
3. HTTP、连接池与advisory lock在finally释放。运行中的数据库工具连接也算使用者，不凭idle判断可以强断。
4. 普通失败/返修复用原资源组。一次性随机库只有确切必要时允许，创建即记录准确名字，并在finally尝试清理；失败写入待清理清单，不吞错。
5. Master通过且代码整合后，任务专用库转CLEANUP_READY，本轮收尾清理。Owner仍需验收的库转KEEP并写原因。可复建的合成测试数据无需长期备份整个库；保留测试脚本、版本、结果和必要证据即可。
6. 删除前生成准确名单，逐库重新核对OID、所有者、COMMENT、当前连接和任务状态。仅无使用者的已完成专用库可删除；默认不用DROP DATABASE WITH FORCE，不调用pg_terminate_backend清场。
7. 删除数据库后再删除专用角色。必须确认角色归属、无保留库依赖/成员关系/连接；不使用DROP OWNED CASCADE或REASSIGN OWNED来强行解除未知依赖。共享角色及超级用户保留。
8. 不按`zzsh_test_*`批量删除，不依据创建日期或库大小判断可删，不删除卷、不操作生产或其他项目实例。

每次任务交接和Master整合均核对本任务资源；结束报告写清保留/删除名单及原因。历史未标记库先列UNKNOWN再查来源，禁止补写标记伪装成当前任务所有。已删除库的旧启动脚本属于历史资料，重新使用必须重新登记。

## 最小只读盘点

在本机维护连接执行，可确认名称、标记和连接数；不要查询或输出业务表、密码或完整SQL会话文本：

```sql
SELECT d.datname, pg_get_userbyid(d.datdba) AS owner,
       shobj_description(d.oid, 'pg_database') AS marker,
       pg_size_pretty(pg_database_size(d.oid)) AS size,
       (SELECT count(*) FROM pg_stat_activity a WHERE a.datid=d.oid) AS connections
FROM pg_database d
WHERE NOT d.datistemplate
ORDER BY d.datname;
```
