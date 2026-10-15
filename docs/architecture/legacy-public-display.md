# 旧账号公开只读展示

公开历史资料与允许交易是两种能力。原生发布、编辑、建单继续执行既有权限、发布证据和legacy_hold检查；历史投影始终canCreateOrder=false、quote=null，金额沿用来源快照，不重算成交价。

## 准入

- 无补充展示快照的legacy_hold=NONE保留原读取条件；UNRESOLVED默认隐藏，不能靠来源状态3或证据前缀放行。新增展示事实后，包括NONE在内都须重新准入。
- 本地演练可显式装配已核定记录清单。每条匹配账号、号主、游戏、观察版本、来源三元组、来源摘要、证据引用、来源时间、快照、标题/描述/属性；任一变化均不再匹配。
- 列表、详情、收藏和监管公开可见性使用同一清单。年龄ADULT、主体有效、游戏/服务开启、未暂停/限制、源状态3、无原生发布接管等动态条件仍逐请求检查。
- 公开文本中的已知联系方式/凭据模式额外拒绝；模式扫描不能代替源资料审核。清单以冻结来源风险事实裁定，不代表接通实时风控。
- 缺失清单、错库或摘要不符不得启用。清单改变后游标绑定改变，不能沿用旧准入集游标。

## 本地装配

仅APP_PROFILE=test且NODE_ENV非production时允许LEGACY_PUBLIC_ADMISSION_FILE与LEGACY_PUBLIC_ADMISSION_SHA256。文件必须位于API工作目录的.secrets内，启动校验字节摘要并使用实际数据库连接核库名/OID/marker/runtime角色。文件不提交Git，不向前端输出。

legacy-public-admission-v1只允许未补充展示快照的旧事实。v2的每条记录还须绑定displayDigest（无展示快照时显式null）。摘要涵盖账号、原观察版本/摘要、新提取SHA、来源时间、证据与展示内容；不修改旧sourceDigest。清单由源计划、目标事实与独立正例对账产生；不能用空集互证。正式上线须采用可审计的持久准入，不把演练文件当作生产授权。

## 展示

市场调用v2列表并保留filterRevision/catalogRevision/ruleReleaseId；MIXED与LEGACY_READ_ONLY都不能回退成原生旧列表。未知出租模式不补普通或极速；首页可通过独立历史只读分节展示这些账号。资料缺失与接口故障分开，历史金额、押金和退款状态不升级为新平台资金事实。

展示补充使用legacy_listing_display_snapshot（schema_version=1）及recordLegacyDisplaySnapshot维护writer；调用方持有事务，复用原快照writer的不可变回读校验、权限/游戏范围、幂等和审计。新表不可UPDATE/DELETE，不更改观察版本、原快照、hold或可租库存。新表及runtime权限须先按正式迁移装配，再部署读取代码。

legacy-listing-display-v1映射default/custom/fast为ordinary/custom/fast；数量复用既有单位转换，恢复库haff的M先乘1000000，6级子弹组乘60，旧保险按DAY保留。未知枚举/异常等级/不明时段为null，有依据的0保持0；风险事实仅供准入，不能作为公开个人字段。新增事实后重建准入和游标；旧金额不重算。首页一条v2游标流分出原生极速和历史只读账号，完整分页继续由市场服务端完成。
