# 业务数据库新装基线

`apps/api/migrations/initial/release_0151/` 是冻结业务迁移0000–0151的中文新装基线，由真实空目标安装152份原链后导出，并与原链的结构、种子、序列及有效ACL逐项核验一致。`release_0141/` 保持原字节，继续支持已装旧基线升级。四段分别保存最终结构、必要静态种子、约束/索引/触发器和原PUBLIC权限；runtime权限继续调用统一的`applyRuntimePrivileges`，不在SQL里绑定本机角色。

原`migrations/business` SQL和journal不改写。已有canonical库仍按原链升级；新装initial库只记一条明确的baseline记录，后续接canonical增量。baseline的manifest逐项绑定所覆盖源SQL和时间、四段文件及组合hash；任何漂移拒绝。不能为已有私有分叉库补造baseline或历史执行记录。

initial段内可能保留已安装函数正文的CRLF，`.gitattributes`对这些SQL禁用换行转换；不能通过编辑器或Git规范化破坏manifest校验。新版本继续以原始UTF-8字节封签。

使用既有migration profile和独立DDL/runtime身份，在确认目标业务schema为空后执行：

```sh
npm run migrate:business -w @zzsh/api -- --initial
```

兼容默认值仍选择registry的`active=release_0141`；显式安装152份覆盖的新基线：

```sh
npm run migrate:business -w @zzsh/api -- --initial --baseline release_0151
```

再次迁移时无需重复指定initial，runner识别已安装baseline并校验其精确前缀，再执行覆盖截点之后的原编号增量。原链目标不用`--initial`；错误历史、非空未登记目标、源SQL/种子/manifest漂移均拒绝，不删表重装。

基线生成工具`node scripts/migration/build-business-initial.mjs --plan`默认零连接。实际生成只允许已登记的空业务回归资源、准确OID、正式完整链和只读一致快照；发现非静态业务数据即拒绝，防止把用户、令牌或业务记录打包进Git。维护密码只从进程引用读取，不进入SQL文件或前端。

后续生成必须显式给新`--baseline`名称及已冻结的`--source-count`，目标目录已存在即拒绝，不覆盖`release_0141`或任何已记账文件。中文版本由生成器写入总说明、四段用途和七个schema的模块导览；保留原依赖顺序及函数体，不用注释改造重排SQL。需要写入数据库的对象`COMMENT`应先作为canonical前向迁移，再随新基线导出，保证原链与新装的元数据也一致。新的中文基线在真实等价验证及维护者选择前不自动代替当前版本；已装旧baseline继续沿其原hash承接后续增量。

`release_0151` 由同一生成器覆盖冻结canonical 0000–0151。先设置本次回归复位的 `ZZSH_REGRESSION_RUN`，再执行 `node scripts/migration/build-business-initial.mjs --execute --oid <现场OID> --baseline release_0151 --source-count 152`；OID、nonce与marker须现场匹配。目标目录已存在则拒绝，不覆盖 `release_0141`。生成结果含四段SQL、`NAVIGATION.md`、`README.md` 和绑定152份源SQL、journal字节与各段hash的manifest。中文说明是SQL行注释和导航；不在initial里新增数据库 `COMMENT`。

manifest保留生成时完整journal字节hash，并单独绑定覆盖前缀的全部journal字段。未来追加原编号迁移时，仍逐项核覆盖前缀与原SQL；不要求追加后的完整journal字节hash等于旧截点。0151新增的头像审核策略只接纳canonical默认单例（须人工审核、revision=1、无修改管理员）；用户、会话、经营改值或资源准入行不属于种子。

registry的`active`保持`release_0141`，`supported`包含0141和0151。已装`release_0141`的库即使请求0151也拒绝换基线，继续按已安装hash承接0142及之后的原编号增量；原角色、种子和历史安装时间保留。canonical库不带`--initial`时仍按原链升级。一条baseline记账不是152次历史执行。

在空canonical回归库完成原链安装、initial安装和未放宽的结构/种子/ACL比较之前，`release_0151` 不得标为已验收，也不得改成默认基线。

更新基线须重新核验原链和initial新装的表/有效列顺序、类型/default/identity/generated、约束和函数体、触发器、索引、种子逐行内容、序列和有效ACL，以及关键业务行为。物理DROP COLUMN遗留attnum空洞与新表压缩不是业务列序变化，原始目录快照需保留；不剥括号或放宽表达式比较。新装等价不代替已有数据升级、真实旧数据转换或渠道验收。
