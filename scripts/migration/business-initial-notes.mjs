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

function tablePurpose(schema, name) {
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
  const functions = new Map(notes.functions.map(fn => [`${fn.schema}.${fn.name}(${fn.args})`, commentForFunction(fn)]));
  const triggers = new Map(notes.triggers.map(trigger => [`${trigger.schema}.${trigger.table}:${trigger.name}`, commentForTrigger(trigger)]));
  const out = [];
  for (const line of sql.split('\n')) {
    const table = line.match(/^CREATE TABLE (\S+)/);
    const fn = line.match(/^CREATE FUNCTION (\S+)\((.*)\) RETURNS /);
    const trigger = line.match(/^CREATE (?:CONSTRAINT )?TRIGGER (\S+) (?:\S+ )*ON (\S+)/);
    const key = table ? unquote(table[1]) : fn ? `${unquote(fn[1])}(${fn[2]})` : trigger ? `${unquote(trigger[2])}:${trigger[1]}` : null;
    const comment = key ? tables.get(key) ?? functions.get(key) ?? triggers.get(key) : undefined;
    if (comment) out.push(...comment);
    out.push(line);
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
      const line = find(`CREATE TABLE ${table.schema}.${table.name}`);
      const quoted = find(`CREATE TABLE ${table.schema}."${table.name}"`);
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
