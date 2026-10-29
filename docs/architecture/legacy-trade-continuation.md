# 旧号正式交易与旧单续办接口

期初余额、历史观察、渠道原号与退款/佣金责任的承接边界见[支付与资金领域规格](payments-and-funds.md#7-新旧资金承接矩阵)；本页维护旧单命令与责任续办。

旧展示记录继续保留原金额和来源。旧号进入正式交易，必须完成逐行来源核定、合法目录和单位映射、真实媒体、当前 sealed 规则报价及接受、发布物化；个人确认与新建单继续走现有 v2 合同。历史报价不成为新单价格。

供给承接复用 `takeoverLegacyTrade` → `resolveLegacyObservationToDraft` → `saveListingDraft` → `quoteListing` → `reviewListing`。共同 `buildLegacyTradeDeclaration` 使用原 `df_billable_top_insure_card`/DAY 身份承接旧账号保险天数，不换算、不要求卡片张数证明。完整 payload、版本 attributes、库存/媒体行和内容 hash 必须相等。普通承接授权不能代替号主包赔条款接受；选择包赔的草稿等待号主通过原接受流程确认，再按同一版本完成发布。旧订单中保险数量依其原有字段语义核定，不直接当新期初库存。迁移媒体必须真实 READY/PUBLIC_DISPLAY。

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

共同占用读取新订单、旧519映射单有效head与1条隔离登记。OCCUPIED优先，其次UNKNOWN，再FREE；缺schema/查询异常不可回退FREE。供给/新建单与维护导入遵循用户→game→account前缀；续办与财务使用同一稳定mapped order advisory→head→按id排序duty。纯续办仅保持占用或释放，不复开终态；财务先锁全部资金受益人并在共同锁后复核集合，不能持head后补锁user/account。

财务通过 `readLegacyDutyBasis` 重核原命令的完整input/result、逐条终金额与当前有效事实，不把pool、旧stored或派生摘要冒充原佣金行。默认财务hook拒绝，缺resolver保持UNKNOWN。安装严格F适配后，非零只引用最终受益正向ledger；真实终0只可引用专用最终event且无ledger行。四态为NONE、POSTED_POSITIVE_REFUND、FINALIZED_ZERO、UNKNOWN；仅正净退款终定阻断重复处置，零额不清其他责任。

部署必须先装配新的证据/版本/duty/208admission/隔离登记与约束及ACL，再装配读写路由；旧0000–0073不可改。208admission对普通runtime仅SELECT，维护主体才可INSERT，禁止UPDATE/DELETE；actor marker不是审批证明。真实资源迁移、导入、金融终定及渠道执行需要各自准确窗口。本接口的离线实现或组件测试不代表数据库锁、真实数据或渠道验收。
