# 租赁会员资格、个人确认与建单

会员与确认服务提供权威资格、个人报价和短期凭据；确认签发本身不占号。新版建单消费凭据、冻结个人金额并原子占号，旧订单入口保持原合同。

## 会员资格

`zzsh_iam.user_rental_membership` 以user_id为主键。可报价档位为STANDARD/VIP/SVIP/DISCOUNT_USER；UNKNOWN仅表示资格未知。0040不回填已有用户；缺记录的读取结果为UNKNOWN、version="0"。新平台用户插入由数据库触发器在同一事务内建立STANDARD/version=1/source_ref=registration:v1，覆盖用户名与手机注册；初始化失败使用户插入一并失败。未来历史导入必须明确写入受权资格或UNKNOWN，不把新身份初始化当作旧会员映射。

资格更新先锁目标user，再核expectedVersion，首次赋值为1、后续严格+1，DB负责更新时间。同一事务保存前后来源、原因、实际管理员与审计；失败不留资格或幂等成功记录。无有效注册来源或管理员归属的来源不用于报价，返回UNKNOWN。资格不存入客户端可写profile。

- 管理读/改：`GET/PUT /api/v1/admin/users/{id}/rental-membership`，同源Admin BFF对应`/api/bff/admin/users/{id}/rental-membership`。读写均需`user.rental_membership.manage`；权限只注册，不默认授普通客服。写body严格为`{tier,expectedVersion,sourceRef,reason}`，要求Idempotency-Key，沿用现有成功重放/异体同key冲突合同。
- 本人读取：`GET /api/v1/users/me/rental-membership`，仅返回tier/version；不返回来源或提供本人修改接口。
- runtime仅SELECT/INSERT及必要更新列；禁止DELETE/TRUNCATE和直接更新user_id/updated_at。SQL单调版本守卫与API用户锁/CAS共同约束。

## 个人确认

`POST /api/v2/order-confirmations`及同源`/api/bff/user/order-confirmations`，Web入口`/api/order-confirmations`。输入仅`{accountId,versionId,releaseId}`；正式Cookie确定本人，拒绝客户端tier、金额或资格。响应no-store。

短事务按双方user ID→game→account锁序，复核会话/活性/成年实名/非本人、有效发布事实及当前公开版本、release/hash、占用及保证金依据。有效发布事实必须是 `PUBLISHED + OWNER_DIRECT` 或真实 `APPROVED + LEGACY_APPROVED`；会员修改锁同一user；重建仅使用锁内client，不另借连接。按同一封存release选四档价目，缺档/未知资格/不支持的旧规则档位均拒绝，不回退STANDARD，也不污染公开报价。

生产当前没有权威押金申报/保赔/保证金金额来源，默认失败关闭，不签token。即使VIP/SVIP也不能跳过未知依赖。`CONFIRMATION_DEPENDENCY_UNAVAILABLE`（503）表示这些依赖不全；`MEMBERSHIP_UNKNOWN`（503）表示资格未知。Admin试算deposits与旧payIs不会作为确认依据。

只有显式test/fake构造能力可注入完整合成资金依据，用于隔离验证；没有HTTP金额注入或生产默认金额。合成规则明确基础押金、保证金要求、来源/版本、未选择保赔及VIP/SVIP免押开关。正数保证金要求不能与NOT_REQUIRED资金资格组合；缺证明引用或UNKNOWN也拒绝。保赔已选择/非零费用当前不支持。STANDARD/DISCOUNT_USER不免押；VIP/SVIP按明确规则决定。生产接线需后续独立实现。

完整合成依赖下响应提供本人报价、基础押金、本人档位/免押结果、确认ID、listingHash、有效截止及confirmationToken；租客DTO不含号主内价、平台利润、会员来源、号主保证金内部要求。

## 签名与后续消费边界

- 配置`ORDER_CONFIRMATION_SECRET`或相对`.secrets`的`ORDER_CONFIRMATION_SECRET_FILE`，以及`ORDER_CONFIRMATION_KEY_ID`。密钥至少32字符、独立于认证密钥；无默认密钥，缺配置签发503 `CONFIRMATION_SIGNING_UNAVAILABLE`。
- 固定HMAC-SHA256、base64url正文与签名。token白名单仅schema/audience/keyId、随机confirmationId、本人/会话、账号/版本/release/listingHash、quoteDigest、DB时间issuedAt/expiresAt；期限300秒。签名不加密，内部完整快照只参与规范化摘要，不放入可解码正文。
- `rebuildPersonalConfirmation`提供锁内重建；`verifyPersonalConfirmation`将当前重建摘要与凭据核对。完整摘要包含会员version/source、保证金证明、资金规则版本和全部报价；资格变动即使金额相同也失效。个人摘要不替代号主审核content_hash，v1 hash规范不变。
- 验证长度、严格字段/类型、固定schema/audience/keyId、签名常量时间比较、用户/会话/对象绑定和DB有效期。无效凭据400 `CONFIRMATION_INVALID`；过期409 `CONFIRMATION_EXPIRED`；版本/规则/资格/金额摘要改变409 `CONFIRMATION_CHANGED`。密钥轮换会使旧keyId的未消费确认失效。
- 凭据不是付款凭据，签发不保证预留；创建成功后才有订单占用。旧v1与v2 listing通过旧入口的`PRICING_SCHEMA_UNSUPPORTED`门禁保留。

## 新版建单与唯一消费（PC-2B）

`POST /api/v2/orders`输入仅`{confirmationToken}`并要求Idempotency-Key；API BFF为`/api/bff/user/orders-v2`，Web为`/api/v2/orders`。旧Web `/api/orders`仍使用v1三字段合同，不静默升级。列表、详情、取消继续使用既有v1订单读写接口，不复制v2整套路由。

幂等空间为user主体+`order.reservation.create.v2`+key，与v1隔离；请求指纹绑定完整原token/body。先执行有界类型/长度检查及回执查询，成功重放仅复核当前有效会话/活性/原订单归属，返回原回执。此时不检查旧token有效期或当前会员/规则/占用、hold/签名配置；异体同key仍409。重放回执是原创建结果，当前状态通过订单查询取得。

首次执行才验证签名与用户/会话；按双方user ID→game→account锁序检查唯一消费、当前资格、有效发布版本/release/hash、会员/资金事实及完整金额摘要。新鲜签名认证本身不是建单许可，必须继续锁内完整重建/验证。持锁后与插单前按DB时间核expiry；0041插入触发器再次检查期限，等待导致过期则回滚，不留下占用或成功回执。原`ORDER_HOLD_SECONDS`独立决定订单hold，不取token剩余时间。

唯一消费使用原订单表的nullable UUID `confirmation_id`（旧单NULL）和全状态唯一约束，无消费表/缓存/worker。同凭据换key再次使用返回409 `CONFIRMATION_USED`；取消和超时保留消费ID，不能复用。插单、消费、创建审计及幂等成功记录在一个事务中提交；任何一步失败均回滚。资金UNKNOWN继续拒绝，合成测试成功不构成生产资金依据。

新快照以`quoteKind=ORDER_CONFIRMATION`、`orderSnapshotSchema=1`明确标识，`schemaVersion`仍表示底层报价格式。保留原根层CNY/resourceTotal/tenantDeposit等字段，以复用既有金额与PAID保护；新增confirmationId/digest/expiry、listingHash及`personal`内部资格/资金/规则事实。订单content_hash仍是审核listingHash，个人摘要另存，不保存原token或签名。

0041独立触发器校验消费ID/快照绑定、期限、规则/资料引用和不可变性，沿用0036最终`guard_rental_order`与已有付款FK、占用索引，不替换PAID转换。新列继承既有订单INSERT/SELECT权限，写后改动由不可变触发器拒绝，包含取消/超时后的记录。旧快照不回填或重算。

订单renter/owner/admin投影继续白名单输出。个人订单的会员sourceRef、资金内部事实、token/签名不透传；租客与号主不获得个人订单内部保证金要求，价差仍限原专用管理权限。状态、排序/游标、取消与IM最小元数据合同不变；本实现不执行付款、群操作、退款或结算。

部署须先应用0040/0041及runtime授权。正式资金来源仍未接通，当前成功链只在显式test/fake合成依赖中可验；API/PG/协议级证据不等于浏览器或生产渠道验收。
