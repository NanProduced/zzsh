/** Chinese line notes for a dumped baseline. Comments describe the catalog; they do not change statements. */

const SCHEMA_PURPOSE = {
  zzsh_iam: '权限、审批、身份与会员。历史事实不伪造成当前授权。',
  zzsh_auth_user: '用户密码、旧凭据及会话。不得混入管理员认证域。',
  zzsh_auth_admin: '管理员密码、TOTP与会话。认证密钥不进入本文件。',
  zzsh_supply: '游戏目录、账号、规则、媒体与发布。展示不代表可交易。',
  zzsh_content: '内容和法律文书。正文版本与接受事实分别保留。',
  zzsh_order: '订单、责任与资金账本。历史付款标记不代表新渠道到账。',
  zzsh_credit: '信用与保证金。金额和资格由服务端合同核定。',
};

export function schemaPurpose(name) {
  return SCHEMA_PURPOSE[name] ?? '业务schema。';
}

const TABLE_PURPOSE = {
  account: '认证提供方与口令凭据绑定。', session: '登录会话、有效期与客户端信息。',
  twoFactor: '双因素密钥与备份码。', user: '认证主体及其基础资料。', verification: '有期限的认证挑战或验证记录。',
  admin_security: '管理员Boss标记、冻结状态与安全版本。', admin_recovery_request: '管理员灾难恢复请求及审批状态。',
  admin_security_notification_outbox: '管理员安全通知投递队列。', admin_recovery_notification_target: '灾难恢复通知的收件目标。',
  admin_permission: '服务端操作权限定义，不包含实际管理员授权。', admin_role: '内置及自定义管理员角色定义。',
  admin_role_permission: '角色与操作权限的关联。', admin_user_role: '实际管理员的角色授权关系。', admin_user_permission: '实际管理员的直接操作授权。',
  approval_template: '按操作与触发条件选择的审批模板。', approval_template_candidate: '模板指定的实际审批候选管理员。',
  approval_request: '审批申请与冻结的业务正文。', approval_request_candidate: '申请时封存的候选审批人。',
  approval_decision: '审批人的逐次决定。', approval_execution: '审批通过后的执行与幂等回执。', audit_event: '只追加的操作审计事件。',
  admin_security_command: '管理员自助安全命令的指纹与执行回执。', admin_backup_code_generation: '备份码生成批次与已披露状态。',
  admin_auth_failure: '管理员认证失败计数事实。', admin_auth_lockout: '管理员认证锁定期限。', admin_auth_captcha_used: '已消费的管理员认证验证码。',
  admin_workspace_layout: '保留的旧管理员工作台布局，不作为新工作台编排。',
  user_identity_state: '用户身份状态与服务端认定版本。', user_identity_subject: '业务身份主体与认证用户的稳定关联。',
  user_identity_verified_profile: '原生实名核验后封存的资料。', user_identity_verification_attempt: '实名核验请求、结果与重试依据。',
  user_identity_display_source: '旧身份展示资料来源，不等同原生实名核验。', user_registration_fact: '由成功审计派生的用户注册只读投影。',
  user_risk_flag: '用户风险标记及原因。', user_note: '管理员对用户的业务备注。', user_rental_membership: '租赁会员资格及版本。',
  membership_growth_policy: '封存的会员成长政策版本。', membership_growth_contribution: '按来源键记载的成长贡献及修正。',
  membership_growth_state: '按用户汇总的成长状态。', membership_entitlement: '用户实际会员礼遇及有效期。',
  membership_growth_legacy_coverage: '旧成长事实的覆盖截点与逐键证据。', membership_growth_legacy_read_admission: '已验证无来源零基底的读取准入，不是等级缓存。',
  personal_finance_read_scope: '个人资金观察的读取范围准入。',
  im_identity_mapping: '业务主体与云信身份的映射。', im_consultation: '咨询轮次与客服分配。', im_consultation_event: '咨询状态变更事件。',
  im_consultation_scope_operation: '咨询范围调整的幂等操作。', im_support_presence: '客服在线状态投影。', im_support_presence_session: '客服在线心跳会话。',
  im_support_handover: '客服交接记录及目标。', im_support_round_rating: '咨询轮次的用户评价。', im_support_settings: '洲洲助手欢迎与投诉提示文案的版本化配置。',
  im_support_thread: '跨咨询轮次的稳定客服会话。', im_aftersale_record: '客服售后处理记录。',
  im_read_copy_settings: '消息已读副本策略。', im_read_copy_position: '各会话已读副本同步位置。',
  game: '游戏目录与目录修订号、当前规则版本入口。', game_service_operation: '游戏服务类型的支持与启停配置。',
  billable_item: '可计价物品、基础数量单位与精度。', skin: '稳定皮肤词条及媒体、分类、品质关联。',
  skin_category: '皮肤分类树与表单可见性。', skin_rarity: '皮肤品质字典。', skin_owner: '皮肤归属对象的稳定身份。',
  entitlement: '账号权益字典及值类型、有效期类型。', firearm: '枪械稳定词条。', firearm_alias: '枪械别名与稳定词条关联。',
  firearm_classification: '枪械分类及展示归属。', gunsmith_code: '改枪码与枪械、来源的关联。',
  rental_account: '出租账号身份、号主、公开编号与可租限制。', listing_version: '出租账号申报内容的冻结版本。',
  inventory_line: '申报版本逐物品的基础单位库存数量。', listing_skin: '申报版本与皮肤的关联。', listing_entitlement: '申报版本的权益值与有效期。',
  listing_media: '申报版本绑定的展示或审核媒体。', listing_publication: '账号发布事实及当时规则、价格绑定。',
  listing_filter_config: '版本化的公开账号筛选展示配置。', price_version: '价格政策草稿与封存版本。', price_line: '价格版本逐物品、会员档位的买卖单价。',
  term_version: '租期政策草稿与封存版本。', term_option: '租期选项及数量边界。', agreement_version: '供给协议正文及封存摘要。',
  full_payout_terms_version: '包赔条款与价格版本的冻结关联。', rule_release: '依赖价格、租期和协议版本的不可变规则发布。',
  rule_acceptance: '当事人接受的具体规则版本与摘要。', review_decision: '账号申报版本的审核结论。',
  media_asset: '审核后的媒体资产、访问级别与公开存储绑定。', media_upload_intent: '媒体上传意图、主体与完成状态。',
  admin_supply_scope: '管理员可管理的游戏供给范围。', duplicate_hint: '供给重复线索，不自动合并账号身份。', favorite: '用户收藏的账号关联。',
  idempotency_record: '跨订单、资金与会员域复用的作用域键、请求指纹及原回执。',
  legacy_supply_map: '旧来源类型与原账号键到新账号的映射。', legacy_listing_read_snapshot: '旧账号的只读列表与详情快照。',
  legacy_listing_display_snapshot: '旧账号按版本封存的展示字段与资源快照。', legacy_skin_holding: '旧账号皮肤持有的来源摘要与稳定词条集合。',
  account_display_no_counter: '按业务日期分配公开账号编号的计数器。', account_guarantee_proof: '发布账号所需保证依据及来源绑定。',
  profile_avatar: '用户或管理员当前头像与待审上传绑定。', profile_avatar_policy: '自定义头像上传审核策略单例，canonical默认须人工审核。',
  rental_order: '每单独立的租赁订单、价格与规则快照。', payment_confirmation: '订单付款结论及受控或渠道来源。',
  rental_opening: '开租数量与交付确认版本。', rental_opening_ack: '租客或号主对开租版本的确认。',
  settlement_version: '结算计算与双方冻结的版本依据。', settlement_decision: '当事人对结算版本的决定。',
  settlement_intake: '待记账结算及接纳正文。', settlement_posting: '一次结算记账的根与幂等身份。', settlement_ledger_entry: '结算逐主体的不可变借贷分录。',
  prestart_termination: '开租前终止申请与责任版本。', prestart_termination_decision: '开租前终止的当事人决定。',
  im_order_group: '每个订单独立的云信群绑定。', im_order_member: '订单群成员及主体角色。', im_order_operation: '订单群操作的幂等执行。',
  im_order_event: '订单群业务阶段事件。', im_order_stage_card: '订单阶段卡片及更新版本。', im_order_due_reminder: '订单到期提醒任务与租约。',
  im_order_activity: '订单会话最后活动投影。', im_order_unread: '用户在订单会话中的未读位置。',
  finance_opening_basis: '用户资金期初及原生或旧源来源证明。', finance_covered_event: '已包含在期初中的来源事件集合，防止重复入账。',
  finance_economic_root: '一次经济行为的唯一资金根。', finance_event: '资金根下的不可变记账事件。',
  wallet_coverage: '钱包读取的已覆盖来源截点。', wallet_revision: '用户钱包并发控制版本。', finance_observation_admission: '外部资金观察的维护接纳依据。',
  personal_finance_observation: '旧平台个人资金观察，不单独产生可提现余额。', personal_finance_observation_coverage: '个人资金观察的完整覆盖范围与截点。',
  finance_stored_opening_review: '封存期初的维护审核与原来源证明。',
  withdrawal_admission: '受控提现范围的准入。', withdrawal_destination: '提现目标的受限资料与指纹。', withdrawal_intent: '受控提现申请、资金占用与状态。',
  withdrawal_provider_fact: '受控提现渠道事实及来源摘要。', withdrawal_bank_binding: '用户银行卡绑定与加密资料版本。',
  controlled_payout_operation: '受控代付执行命令的幂等回执。', controlled_payout_notice: '受控代付结果通知与消费状态。',
  distribution_policy_head: '当前分销政策版本入口。', distribution_policy_version: '封存的分销准入与佣金政策。',
  distribution_participant: '参与分销主体及资格。', distribution_invite_code: '分销邀请码及主体关联。', invitation_relation: '用户邀请关系及来源。',
  distribution_order_admission: '订单参加分销的资源与来源准入。', payment_distribution_basis: '付款结论对应的分销合同与参与人快照。',
  controlled_payment_declaration: '受控付款申明与资金依据。', rental_referral_earning: '订单佣金应付及成熟、冲回状态。',
  rental_referral_reversal_source: '佣金冲回的原始来源证明。', rental_referral_transition: '佣金状态变更与资金事件绑定。',
  native_user_insert_proof: '同事务新建原生用户的出生证明。', native_origin_resource_admission: '特定资源允许原生零期初的显式准入，空库不自带准入行。',
  owner_guarantee_requirement: '号主保证金需求与资格快照。', owner_guarantee_payment: '号主保证金付款申请及渠道事实。',
  owner_guarantee_refund: '号主保证金释放或退款申请与结果。', owner_guarantee_reconciliation: '保证金对账来源与结论。',
  user_credit_state: '用户当前信用分与修订版本。', credit_event: '信用加减的不可变来源事件。', credit_recovery_request: '用户信用恢复申请与审核决定。',
  legacy_order_read_snapshot: '旧订单的只读业务展示快照。', legacy_continuation_evidence: '旧单续办的原始事实、参数及摘要。',
  legacy_continuation_version: '旧单续办的决定版本与来源。', legacy_order_duty: '旧单未结责任、对手方及当前处理状态。',
  legacy_order_duty_admission: '旧单责任可执行的显式准入。', legacy_order_duty_revision: '旧单责任修订前后值及操作者。',
  legacy_inflight_register: '旧平台在途订单的封存登记。', legacy_duty_finance_contract: '旧单责任与新资金动作的合同绑定。',
  legacy_duty_finance_fact: '旧单责任对应的已执行资金事实。', legacy_owner_guarantee_observation: '旧号主保证金来源观察。',
  legacy_owner_guarantee_coverage: '旧号主保证金观察覆盖与处理依据。',
  payment_request: '收款请求及金额、主体、幂等状态。', payment_channel_observation: '通用收款渠道的原始观察与验证结论。',
  payment_channel_transaction: '已认定收款交易与订单请求绑定。', joinpay_collection_binding: '汇付收款请求的冻结商户与接入依据。',
  joinpay_collection_attempt: '汇付收款调用尝试及租约。', joinpay_collection_observation: '汇付收款返回或通知的观察。', joinpay_collection_evidence: '汇付收款验签及业务绑定证据。',
  channel_refund_intent: '租赁退款应付与冻结的渠道请求。', channel_refund_observation: '通用退款渠道事实观察。',
  joinpay_refund_attempt: '汇付退款调用尝试及租约。', joinpay_refund_observation: '汇付退款返回或通知观察。', joinpay_refund_evidence: '汇付退款验签与终定依据。',
  joinpay_withdrawal_intent: '原生钱包提现占用与冻结的汇付代付请求。', joinpay_payout_attempt: '汇付代付尝试及租约。',
  joinpay_payout_observation: '汇付代付返回或通知观察。', joinpay_payout_evidence: '汇付代付验签与资金终定依据。', joinpay_account_observation: '汇付商户账户状态观察。',
  local_financial_sandbox_registration: '本地日常沙箱的准确资源与授权登记；不属于新装种子。',
  local_controlled_refund_operation: '本地受控退款操作与原付款责任绑定。', local_controlled_refund_evidence: '本地受控退款来源证据，不代表真实渠道到账。',
};

function tablePurpose(schema, name) {
  if (TABLE_PURPOSE[name]) return TABLE_PURPOSE[name] + (schema.startsWith('zzsh_auth_') ? (schema === 'zzsh_auth_admin' ? '管理员认证域。' : '用户认证域。') : '');
  if (name.startsWith('legacy_')) return '旧平台来源事实或只读快照。保留原键和来源类型；不把它当成新渠道收款，也不把已包含进期初的历史再入账。';
  if (/opening|wallet|ledger|economic_root|finance_event|finance_covered/.test(name)) return '资金账本、期初或覆盖。可提现只来自已入账分录；历史观察不重复增加余额。';
  if (name.includes('idempotency')) return '幂等记录。同一把钥匙和同一正文重放不得产生第二笔结果。';
  if (/invitation|distribution|referral/.test(name)) return '分销资格、邀请关系或佣金依据。旧等级不自动变成新会员等级，已结佣金不重付。';
  if (/credit|guarantee|deposit/.test(name)) return '信用或保证金。分数和冻结金额以服务端合同为准，不从旧余额折算。';
  if (schema === 'zzsh_auth_user') return '用户认证对象。口令、盐和会话不进入公开接口。';
  if (schema === 'zzsh_auth_admin') return '管理员认证对象。与用户认证域隔离。';
  if (schema === 'zzsh_iam') return '身份、权限或审批对象。菜单可见不是授权。';
  if (schema === 'zzsh_supply') return '供给目录或出租账号对象。公开展示和编号不代表当前可以下单。';
  if (schema === 'zzsh_content') return '内容或法律文书版本。旧帮助正文不自动成为现行条款。';
  if (schema === 'zzsh_order') return '订单、履约或资金相邻对象。历史付款标记不是新渠道到账。';
  return '当前业务行。主键、外键和单位以下列为准。';
}

function functionRole(name) {
  const roles = {
    finance_immutable: '禁止资金事实UPDATE、DELETE或TRUNCATE，保留原始来源。',
    guard_profile_avatar_policy: '禁止删除头像策略单例，修改必须严格推进CAS版本。',
    guard_avatar_policy_asset: '只允许绑定当前策略及待审上传的系统批准；原政策来源不可改写。',
    guard_local_financial_sandbox_registration: '只接受准确日常资源的本地沙箱准入与撤销，不产生渠道到账。',
    guard_legacy_growth_read_admission: '核对原覆盖、审计、幂等回执与零来源证明，拒绝补造会员等级。',
    legacy_opening_source_proof: '只返回旧期初绑定的安全来源摘要，不为旧无证明数据补造证明。',
    guard_stored_opening_source_proof: '将期初审核与新来源证明、原键和九字段事实逐项绑定。',
    assert_legacy_duty_funding: '核对旧单责任与原资金来源，排除已入账或已覆盖历史。',
    guard_withdrawal_return_covered: '要求退回根绑定同事务已审核的提现来源证明。',
    initialize_native_wallet_origin: '只为获准资源中同事务出生的原生用户初始化零期初。',
    canonical_finance_json: '确定性编码资金依据JSON，供摘要、幂等和来源绑定使用。',
  };
  if (roles[name]) return roles[name];
  if (name.startsWith('guard_') || name.includes('_guard')) return '写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。';
  if (name.includes('idempoten')) return '幂等辅助。重复请求必须命中原结果。';
  if (/opening|ledger|wallet|finance/.test(name)) return '资金函数。余额变化必须有对应分录，不能由展示行单独产生。';
  if (name.startsWith('next_') || name.includes('display_no')) return '编号分配。发出公开编号不提升可交易资格。';
  return '结构函数。函数体、安全属性和search_path以随后定义原文为准。';
}

function volatility(code) {
  if (code === 'i') return 'immutable';
  if (code === 's') return 'stable';
  return 'volatile';
}

function list(title, items, empty) {
  return items.length ? `${title}：${items.join('、')}。` : empty;
}

export function commentForTable(table) {
  const money = table.columns.filter(column => column.name.endsWith('_cents')).map(column => `${column.name}(${column.type})`);
  const ratios = table.columns.filter(column => /ratio|percent|rate/i.test(column.name)).map(column => `${column.name}(${column.type})`);
  const quantities = table.columns.filter(column => /quantity|qty|_count$|_num$/.test(column.name) && !column.name.endsWith('_cents')).map(column => `${column.name}(${column.type})`);
  const statuses = table.columns.filter(column => /status|state|stage|lifecycle/.test(column.name)).map(column => column.name);
  return [
    `-- 表 ${table.schema}.${table.name}：${tablePurpose(table.schema, table.name)}`,
    `-- ${list('主键', table.primaryKey, '主键：无单独主键约束。')}`,
    `-- ${list('外键', table.foreignKeys, '外键：无。')}`,
    `-- ${list('金额列，单位CNY整数分', money, '金额列：无_cents列；若另有decimal金额，以该列类型为准，不用浮点当账务真值。')}`,
    `-- ${list('比例或费率列', ratios, '比例列：无。')}`,
    `-- ${list('数量列', quantities, '数量列：无按列名识别的数量。')}`,
    `-- ${list('状态列', statuses, '状态列：无按列名识别的状态。')}`,
    ...(table.checks ?? []).map(check => `-- CHECK ${check.name}：${check.def.replaceAll('\n', '\n-- ')}`),
    ...(table.name === 'billable_item' || table.name === 'inventory_line' || table.name === 'price_line' ? ['-- 数量依billable_item.unit：HAFF_BASE基础哈夫币、ROUND发、PIECE件、DAY天；quantity_scale是小数位。6级弹按60发计价，库存仍存发数。'] : []),
    ...(table.name === 'price_line' ? ['-- buyer_unit_amount/owner_unit_amount为精确元单价；unit_quantity为计价基础数量，HAFF_RATIO规则单独解释。'] : []),
  ];
}

export function commentForFunction(fn) {
  return [`-- 函数 ${fn.schema}.${fn.name}(${fn.args})：${functionRole(fn.name)} ${volatility(fn.volatile)}${fn.definer ? '，SECURITY DEFINER' : ''}。`];
}

export function commentForTrigger(trigger) {
  return [`-- 触发器 ${trigger.name} ON ${trigger.schema}.${trigger.table}：执行 ${trigger.functionSchema}.${trigger.functionName}。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。`];
}

function unquote(name) {
  return name.replaceAll('"', '');
}

export function annotateDump(sql, notes) {
  const tables = new Map(notes.tables.map(table => [`${table.schema}.${table.name}`, commentForTable(table)]));
  const functions = new Map(notes.functions.map(fn => [`${fn.schema}.${fn.name}(${fn.dumpArgs ?? fn.args})`, commentForFunction(fn)]));
  const triggers = new Map(notes.triggers.map(trigger => [`${trigger.schema}.${trigger.table}:${trigger.name}`, commentForTrigger(trigger)]));
  const out = [];
  let bodyDelimiter;
  for (const line of sql.split('\n')) {
    if (bodyDelimiter) {
      out.push(line);
      if (line.includes(bodyDelimiter)) bodyDelimiter = undefined;
      continue;
    }
    const table = line.match(/^CREATE TABLE (\S+)/);
    const fn = line.match(/^CREATE FUNCTION (\S+)\((.*)\) RETURNS /);
    const trigger = line.match(/^CREATE (?:CONSTRAINT )?TRIGGER (\S+) (?:\S+ )*ON (\S+)/);
    const key = table ? unquote(table[1]) : fn ? `${unquote(fn[1])}(${fn[2]})` : trigger ? `${unquote(trigger[2])}:${trigger[1]}` : null;
    const comment = key ? tables.get(key) ?? functions.get(key) ?? triggers.get(key) : undefined;
    if (comment) out.push(...comment);
    out.push(line);
    const body = line.match(/^\s*AS (\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)/);
    if (body && !line.slice(line.indexOf(body[1]) + body[1].length).includes(body[1])) bodyDelimiter = body[1];
  }
  return out.join('\n');
}

export function navigationMarkdown(baseline, notes, structureSql) {
  const lines = structureSql.split('\n');
  const find = needle => lines.findIndex(line => line.startsWith(needle)) + 1;
  const chunks = ['# 新装结构导航', '', `基线 \`${baseline}\`。行号指向本目录 \`01-structure.sql\` 的最终 \`CREATE\`，不是canonical里第一次出现该对象的迁移。约束和触发器在 \`03-constraints-triggers.sql\`。`, ''];
  for (const schema of [...new Set(notes.tables.map(table => table.schema))]) {
    chunks.push(`## ${schema}`, '', schemaPurpose(schema), '');
    for (const table of notes.tables.filter(item => item.schema === schema)) {
      const line = find(`CREATE TABLE ${table.schema}.${table.name} (`);
      const quoted = find(`CREATE TABLE ${table.schema}."${table.name}" (`);
      const at = line || quoted;
      chunks.push(`### ${table.schema}.${table.name}`, '', tablePurpose(table.schema, table.name), '', at ? `最终定义：01-structure.sql:${at}` : '最终定义：01-structure.sql 中按表名检索 CREATE TABLE。', `主键：${table.primaryKey.join('、') || '无'}`, `外键：${table.foreignKeys.join('；') || '无'}`, `索引：${(notes.indexes ?? []).filter(index => index.schema === table.schema && index.table === table.name).map(index => index.name).join('、') || '见03段'}`, '');
    }
  }
  chunks.push('## 函数与触发器', '');
  for (const fn of notes.functions) chunks.push(`- \`${fn.schema}.${fn.name}(${fn.args})\`：${functionRole(fn.name)}`);
  for (const trigger of notes.triggers) chunks.push(`- \`${trigger.name}\` ON \`${trigger.schema}.${trigger.table}\` → \`${trigger.functionSchema}.${trigger.functionName}\``);
  return chunks.join('\n') + '\n';
}

export function readmeMarkdown(baseline, sourceCount, lastTag) {
  return `# ${baseline}\n\n这是从空库安装canonical前${sourceCount}份后导出的新装基线，最后一份是 \`${lastTag}\`。四段按顺序执行：01最终结构、02必要静态种子、03约束索引触发器、04 PUBLIC权限。runtime窄权限仍由 \`applyRuntimePrivileges\` 安装。\n\n默认 \`--initial\` 仍使用 registry 的 active。本基线完成真实等价验证并被维护者选为 active 之前，不会替换已安装的 release_0141。显式新装使用 \`--initial --baseline ${baseline}\`。\n\n对象中文说明在SQL行注释和 \`NAVIGATION.md\`。数据库 \`COMMENT\` 只保留canonical已经写入的元数据。\n`;
}
