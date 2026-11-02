# 业务数据库新装基线

`apps/api/migrations/initial/release_0141/` 是从真实空库按原链安装后的结果生成的新装基线，覆盖业务迁移0000–0141。四段分别保存最终结构、必要静态种子、约束/索引/触发器和原PUBLIC权限；runtime权限继续调用统一的`applyRuntimePrivileges`，不在SQL里绑定本机角色。

原`migrations/business` SQL和journal不改写。已有canonical库仍按原链升级；新装initial库只记一条明确的baseline记录，后续接canonical增量。baseline的manifest逐项绑定所覆盖源SQL和时间、四段文件及组合hash；任何漂移拒绝。不能为已有私有分叉库补造baseline或历史执行记录。

initial段内可能保留已安装函数正文的CRLF，`.gitattributes`对这些SQL禁用换行转换；不能通过编辑器或Git规范化破坏manifest校验。新版本继续以原始UTF-8字节封签。

使用既有migration profile和独立DDL/runtime身份，在确认目标业务schema为空后执行：

```sh
npm run migrate:business -w @zzsh/api -- --initial
```

再次迁移时无需重复指定initial，runner识别已安装baseline并校验其精确前缀，再执行覆盖截点之后的原编号增量。原链目标不用`--initial`；错误历史、非空未登记目标、源SQL/种子/manifest漂移均拒绝，不删表重装。

基线生成工具`node scripts/migration/build-business-initial.mjs --plan`默认零连接。实际生成只允许已登记的空业务回归资源、准确OID、正式完整链和只读一致快照；发现非静态业务数据即拒绝，防止把用户、令牌或业务记录打包进Git。维护密码只从进程引用读取，不进入SQL文件或前端。

后续生成必须显式给新`--baseline`名称及已冻结的`--source-count`，目标目录已存在即拒绝，不覆盖`release_0141`或任何已记账文件。中文版本由生成器写入总说明、四段用途和七个schema的模块导览；保留原依赖顺序及函数体，不用注释改造重排SQL。需要写入数据库的对象`COMMENT`应先作为canonical前向迁移，再随新基线导出，保证原链与新装的元数据也一致。新的中文基线在真实等价验证及维护者选择前不自动代替当前版本；已装旧baseline继续沿其原hash承接后续增量。

更新基线须重新核验原链和initial新装的表/有效列顺序、类型/default/identity/generated、约束和函数体、触发器、索引、种子逐行内容、序列和有效ACL，以及关键业务行为。物理DROP COLUMN遗留attnum空洞与新表压缩不是业务列序变化，原始目录快照需保留；不剥括号或放宽表达式比较。新装等价不代替已有数据升级、真实旧数据转换或渠道验收。
