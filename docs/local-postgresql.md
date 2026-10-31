# 本地 PostgreSQL 使用规范

本规范适用于所有开发、测试、浏览器验收与 Master 复核任务。服务启停另见[本地环境规则](local-environments.md)。

## 资源层次

- PostgreSQL 实例固定为本项目 Compose 的 `127.0.0.1:55432`，不使用其他项目的5432。
- `zzsh_dev` 是主开发库，不是测试清理目标；`postgres` 是维护连接库。两者默认保留。
- 长期只保留两组资源：① 一套数据完整的日常联调库（Web/Admin/API 共用）；② 一套可重建的回归测试库 `zzsh_test_regression`（迁移、清理、重置类测试的唯一默认目标）。`postgres`/模板库与只读旧数据源不计入。旧库的独有事实经受限备份与恢复索引承接，不靠长期在线保命。
- 测试以独立 **database** 隔离；库内 `zzsh_iam`、`zzsh_supply` 等 **schema** 由正式迁移创建，不按每个用例再建一套schema。
- 数据库、迁移角色、runtime角色与advisory lock组成一个资源组，不能只换锁而仍操作同一库。

## 命名与复用

回归/迁移/清理类测试的默认入口只有一个资源组，写在 `apps/api/src/config/test-resource.ts`：库 `zzsh_test_regression`、marker `zzsh:regression-test:v1`、角色 `zzsh_regression_migration`/`zzsh_regression_runtime`、advisory lock `806006`、创建许可 `REGRESSION_TEST_ALLOW_NEW_RESOURCE`。九个 compiled PostgreSQL 套件（`database`、`database-reset`、`auth`、`approval-audit`、`admin-workspace-layout`、`supply-m3b`、`content-foundation`、`order-reservation`、`user-directory`）全部从这里取值，不再各自持有默认库名、marker、锁和许可；实际解析出的库名/角色/marker/锁/OID 由 `test/regression-resource.test.ts` 离线守卫，任何套件重新引入私有默认名、自由库名/角色覆盖或私有许可都会失败。`npm run test:db` 先跑 database-safety，再由 `scripts/run-regression-suites.mjs` 串行复位并运行九个套件；runner 自己从受控复位取得并绑定 OID/nonce，覆盖准备、迁移、断言与清理全程。

`806006` 必须取在维护库 `postgres` 的同一会话上：advisory lock 按数据库隔离，锁在测试库里即使号码相同也不会排斥另一个进程。该外层锁从任何建库/改角色密码之前开始，一直持到清理和连接收尾；FND 的 `804004` lease 只是内层锁，不代替外层互斥。

回归库创建后把实际 OID 登记进 `tmp/postgresql-resources.md`；受控复位把 OID/nonce 写入私有 state 并绑定给 suite，直接运行单个 compiled suite 时仍须设置 `ZZSH_REGRESSION_DB_OID=<oid>` 与本次 reset 的 `ZZSH_REGRESSION_RUN=<nonce>`，缺省即拒绝。例外资源按各自登记的 OID 校验，不会套用回归库的 OID。

普通复位/运行入口只依赖本机固定实例、已登记 state、准确 OID/marker、维护库外层锁和显式创建许可；任务执行期可另用外壳绑定限时授权文件，但普通开发/CI 入口和 runner 不依赖该任务授权、任务 ID 或任务临时目录。`REGRESSION_RESET_EMPTY_TARGET` 只供任务归档外壳恢复旧源时使用，普通入口不设置。

只有浏览器/人工验收需要保留数据，或复验旧库承载的既有事实时，才使用测试入口已有的资源集参数，且该库必须已在 `REGISTERED_HISTORICAL_EXCEPTIONS` 中登记：登记记录库名、OID、marker 与角色对，运行期只允许 reuse（缺库/身份不符即失败），任何未登记的资源集名称直接拒绝，不能靠自由后缀加旧开关生成新克隆。收口后连同角色退役。

```powershell
$env:SUPPLY_TEST_RESOURCE_SET = "m3d_web"
$env:M2_AUTH_TEST_RESOURCE_SET = "m3d_web"
# 仅已包含内容套件的分支使用 CONTENT_TEST_RESOURCE_SET
$env:CONTENT_TEST_RESOURCE_SET = "m3d_web"
npm run check
```

资源集使用简短任务名（小写字母开头，字母/数字/下划线，总长不超过21）。各套件保留已有命名规则，例如 `zzsh_test_supply_<资源集>`、`zzsh_test_m2_auth_<资源集>`。不得为了统一外观重命名既有库或篡改归属标记。

同一任务的实现、返修、Master复验优先串行复用同一资源组。不要为r1/r2/final/重试反复建库；只有确需并发或首次迁移空库验证时另登记一组。浏览器需要保留人工验收数据时单独用 `<任务>_ui`，不与会清数据的回归套件共库。

默认入口即上述唯一回归组，供单维护者串行复跑；多agent不得同时运行默认入口，也不得以并发为由另建随机库。锁占用即退出/等待协调，不抢锁、不终止别人连接、不增加随机后缀规避冲突。

## 创建准入

测试资源须先登记。缺库默认失败，不静默新建；获准首次创建时，仅将对应开关设为 `1`，其他入口的开关无效。资源集名称不代表创建授权。返修、复验和 Master 复跑复用同一资源组，不新增 `r1`/`r2`/`final` 库。

| 测试入口 | 首次创建开关 |
|---|---|
| 九个 compiled PostgreSQL 套件的默认目标（`zzsh_test_regression`） | `REGRESSION_TEST_ALLOW_NEW_RESOURCE` |
| 上述套件显式指定 `*_TEST_RESOURCE_SET` 的已登记例外 | 不可创建：登记表外一律拒绝，登记表内只允许复用 |
| im-postgres（IM 线自有资源，不并入回归组） | `IM_TEST_ALLOW_NEW_RESOURCE` |

回归库创建后把实际 OID 登记进 `tmp/postgresql-resources.md`；runner 复跑时从受控复位绑定 OID/nonce，admission 会额外核对库 OID，防止同名库被换掉或指向别处的库。重置/首建仍要求显式 `REGRESSION_TEST_ALLOW_NEW_RESOURCE=1`。

共用 `admitTestDatabase` 校验已有库的 owner、marker、可连接与非模板属性；历史无标记 fixture 必须实读为 `null`，未读取不能代替无标记。既有角色、对象和锁校验继续执行。创建开关仅用于明确批准的准备过程，不长期写入日常配置。

九套件通过 runner 在每套开始前复位同一个回归库，并核对本次 OID/nonce；不在已安装的业务表上绕过不可变保护做全表清理。失败时保留现场并退出，显式选择继续后才进入下一次复位。历史例外只允许读取或按其原合同复验，不自动进入回归库的复位流程。

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
