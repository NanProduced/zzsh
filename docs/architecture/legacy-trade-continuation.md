# 旧号正式交易与旧单续办接口

期初余额、历史观察、渠道原号与退款/佣金责任的承接边界见[支付与资金领域规格](payments-and-funds.md#7-新旧资金承接矩阵)；本页维护旧单命令与责任续办。

续办读取、试算及命令/原键回执在服务端按实际当事人裁剪：号主只见本方收入与费用，租客只见本方付款、消耗及应退；双方都不直出平台佣金池。管理端继续核订单/游戏范围与佣金明细权限。原始事实、计算、摘要与幂等存储保持完整，普通重放、并发赢家和只读恢复在发送前执行同一投影，不能借旧回执绕过私价边界。

旧展示记录继续保留原金额和来源。旧号进入正式交易，须完成逐行来源核定、合法目录和单位映射、媒体来源核定、当前 sealed 规则引用及发布物化。一般旧号按现行规则报价并遵守新号全部接受门禁。例外仅限已证明来源、源截点原在架的账号：当前经 Owner 批准的本地及测试服务器口径，以同源备份 MySQL 配置和旧普通客规则计算并冻结整元基础报价；旧站同截点 Redis 配置缓存未知，正式切换前须复核并重新准入。原静态租客价与旧会员价只作来源证据，不冒充个人报价；新平台会员政策及礼遇在该基础上计算，未知保持不可用。

供给承接复用 `takeoverLegacyTrade` → `resolveLegacyObservationToDraft` → `saveListingDraft` → `quoteListing` → `reviewListing`。共同 `buildLegacyTradeDeclaration` 使用原 `df_billable_top_insure_card`/DAY 身份承接旧账号保险天数，不换算、不要求卡片张数证明。完整 payload、版本 attributes、库存/媒体行和内容 hash 必须相等。源证据完整的原在架包赔选择可记录为管理员授权承接，不能表示号主本人接受新条款；租客个人确认仍须读取并接受有效封存条款。新账号及其他旧号继续要求号主本人接受。旧订单保险数量按原字段语义核定，不直接当新期初库存；新媒体须 READY/PUBLIC_DISPLAY，旧图例外须绑定已核原在架来源。

此例外使用显式 `LEGACY_QUOTED` v3 与不可变来源/政策证据；展示的号主基础比例取冻结的旧 B，租客基础比例取旧 B 减冻结的旧价差，均不从整元金额反推。租客比例未计新平台会员优惠，实际金额以个人报价为准。新订单实际消耗按冻结全量价等比例分摊到分，既有旧单和旧发布版本不变。租客接口只返回本人可见报价，政策或来源证据缺失时不得以新价或默认权益替代。

生产切换前必须增加服务端环境门禁，在生产 profile 强制拒绝当前测试授权，并以重新核实的来源和独立生产授权替换；当前代码只持久化测试范围，尚未实现该运行时拒绝。测试数据可用于本地和测试服务器演示，不构成生产报价依据。

批量承接先走只读装配：`assembleLegacyTradeIntakeBatch` 由同一受审提取原件的13列行体（String/null 语义）重算旧12投影摘要与新13摘要，对照实际 flag 后才与映射源摘要绑定；缺行体、flag/行身份不符或旧12摘要漂移的行整行隔离。`planLegacyTradeIntakeBatch` 逐行给出 TRADE_CANDIDATE/BLOCKED/ISOLATED，批次与逐行指纹对任意合法 JSON 输入成立（不得常量回退）；缺值/非法值原样保留、不默认 0，也不产生正式报价或上架。

旧订单不替换为新订单，不重新收款或新建订单群。业务命令只新增不可变版本和完整派生事实；导入即8/9可以由对方直接确认或驳回，无须先产生 head。

| 路径（相对 `/api/v1/orders`；管理端相对 `/api/v1/admin/orders`） | 方法和用途 |
| --- | --- |
| `/legacy/:mappedOrderId/continuation` | GET 当前有效完整事实、权限、责任及服务端命令指纹 |
| `/legacy/:mappedOrderId/continuation/preview` | POST 数量预估，仅当事人，无资金或状态写入 |
| `/legacy/:mappedOrderId/continuation/propose` | POST 当事人提议 |
| `/legacy/:mappedOrderId/continuation/confirm`、`reject` | POST 对方确认或驳回 |
| `/legacy/:mappedOrderId/continuation/hold`、`release`、`confiscate` | POST 仅受权管理身份的押金处置 |
| `/legacy/:mappedOrderId/continuation/duties/:dutyId/mature`、`void` | POST 仅受权管理身份的佣金成熟或已核来源作废 |
| `/legacy/:mappedOrderId/continuation/receipt?command=…&key=…` | GET 原请求回执；责任命令额外带 dutyId |

Web BFF沿 `/api/orders/legacy/…`，管理 BFF沿 `/api/bff/admin/orders/legacy/…`。管理BFF必须精确放行上述管理命令，不扩大原生订单写范围。所有写命令保留 Idempotency-Key、原 actor/body 指纹；原成功回执仍复核当前身份、会话、冻结、权限、对象和游戏范围，仅跳过已完成的业务前置。400/409业务拒绝在回滚本次所有命令副作用后保留原键拒绝回执；数据库/通信异常不能伪装为已拒绝。

普通命令体为 `expectedRevision`（首条可null）、`inputEvidenceId`、`planFingerprint`；propose另带完整八项 quantities。每次输入为当前 head.result，结果继承全部有效事实后合并本次delta。命令/证据/责任/CAS/审计同事务。解除暂扣不清 detain，不增加扣留部分退款；87−5仍为82。完成、财账终定和渠道到账独立，渠道未知保持 UNKNOWN。

责任经济键为 `(order_id,kind,source_record_id)`。在途佣金先PENDING、成熟为空；confirm按原逐条佣金证据重算终金额，时点为同一次服务端confirm时间+7天。已完成父单佣金走独立不可变admission，保留原行canonical/digest、稳定受益映射、终金额、cutoff、原时间单位和UTC微秒；COMPLETED_AT加旧7天，MATURES_AT直接使用，双证据须一致，不要求旧账号分母或新head。

历史完成未退与暂扣均保留经核净额的PENDING退款责任；暂扣由HELD阻断执行，解除后消费同一责任，保留detain且不追加退款。旧侧已没收保留LEGACY_RECORDS终态及空新财账ref，不再次支付；既有退款记录仅作防重复依据，不等于到账。完整来源缺失逐行隔离，不能以0代替未知；具体批次行数不是业务全量。

共同占用读取新订单、旧订单有效阶段与隔离登记。OCCUPIED优先，其次UNKNOWN，再FREE；缺schema/查询异常不可回退FREE。本人账号列表仅在唯一在途单与当前号主均已绑定时显示旧原单号和跳转；占用事实可成立而无可见订单。供给/新建单与维护导入遵循用户→game→account前缀；续办与财务使用同一稳定mapped order advisory→head→按id排序duty。纯续办仅保持占用或释放，不复开终态；财务先锁全部资金受益人并在共同锁后复核集合，不能持head后补锁user/account。

财务通过 `readLegacyDutyBasis` 重核原命令的完整input/result、逐条终金额与当前有效事实，不把pool、旧stored或派生摘要冒充原佣金行。默认财务hook拒绝，缺resolver保持UNKNOWN。安装严格F适配后，非零只引用最终受益正向ledger；真实终0只可引用专用最终event且无ledger行。四态为NONE、POSTED_POSITIVE_REFUND、FINALIZED_ZERO、UNKNOWN；仅正净退款终定阻断重复处置，零额不清其他责任。

部署必须先装配新的证据/版本/duty/208admission/隔离登记与约束及ACL，再装配读写路由；旧0000–0073不可改。208admission对普通runtime仅SELECT，维护主体才可INSERT，禁止UPDATE/DELETE；actor marker不是审批证明。真实资源迁移、导入、金融终定及渠道执行需要各自准确窗口。本接口的离线实现或组件测试不代表数据库锁、真实数据或渠道验收。
