# 首次 dump 编排的隔离合成验证

仅在受控测试 Docker daemon 上运行。测试生成虚构用户、独立内网 CA/密码、空库和合成 dump；PostgreSQL/Redis 数据为 tmpfs，proxy 不启动，不发布宿主端口。三个固定 Compose 项目及 `zzsh-ecs-dump-fixture-20261105` 卷须先登记并确认没有其他使用者。不要把本测试的镜像、凭据、数据或通过结果当作实际 R06 或 ECS 证据。

从候选源码构建 API 镜像，并将待测 API、Web、proxy 镜像分别标记为 `zzsh-ecs-test/{api,web,proxy}:dump-fixture-20261105`；测试实际只启动候选 API 镜像作为数据库迁移工具，Web 与 proxy 仅供镜像身份检查。准备仓库中的 Compose 指定版本 PG16/Redis7 镜像。构建测试容器并建立专用卷：

```sh
docker build -t zzsh-ecs-dump-orchestration-test:local deploy/ecs-test/tests
docker volume create --label zzsh.task=ecs-dump-orchestration-synthetic zzsh-ecs-dump-fixture-20261105
```

每次使用尚不存在的 `run-<编号>` 子目录；若同名卷已存在，先核标签和归属，不删除或覆盖。测试容器为执行 Compose 而持有 Docker socket，须先审阅测试源码，只在可控 daemon 上使用：

```sh
docker run --rm --name zzsh-ecs-dump-harness-20261105 --network none --cpus 1 --memory 384m \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=volume,source=zzsh-ecs-dump-fixture-20261105,target=/var/lib/docker/volumes/zzsh-ecs-dump-fixture-20261105/_data \
  --mount type=bind,source="$PWD/deploy/ecs-test",target=/source/deploy/ecs-test,readonly \
  -e FIXTURE_VOLUME_PATH=/var/lib/docker/volumes/zzsh-ecs-dump-fixture-20261105/_data/run-01 \
  zzsh-ecs-dump-orchestration-test:local python /source/deploy/ecs-test/tests/restore-approved-dump-synthetic.py
```

测试覆盖单事务恢复、会员事实等关键表计数/账本及原生起点准入、列级或继承写权限和禁用保护触发器拒绝、重复和非空目标拒绝、恢复步骤进程中断后的同计划恢复、提交结果未知时拒绝重放，以及建库后中断且缺少本次创建证明时拒绝认领。单测另覆盖应用未停时拒绝启动基础设施，以及路径或同 inode 更改不改变已封印恢复流。会员等级由正式 reader 动态计算，表计数匹配不是等级读取验收。测试后核三个项目均无容器和网络，按资源登记决定是否保留专用卷；清理只针对本次已确认的合成资源，禁止全局 prune。`restore_approved_dump_test.py` 可在 Linux 运行 `python3 -B -m unittest -v restore_approved_dump_test`。

`acl_snapshot_capture.cjs` 要求调用方传入已打开且经身份核验的源 RR 只读事务，并返回本连接导出的快照 token、ACL 目录字节及摘要；调用方必须保持该事务，直到同 token 的 `pg_dump` 完成并将身份、归档和目录摘要一起写入受限回执。`acl_snapshot_compare.py` 只做一对一角色映射的只读差异对照，不执行授权或证明输入的来源。合成测试用另一个连接修改函数 ACL，确认同 token 的归档仍取捕获时的撤权；又确认 `--no-acl` 恢复后的 PUBLIC 扩权能被目录对照发现。这些原语不等于服务器 ACL 已恢复或真实数据已验收。
