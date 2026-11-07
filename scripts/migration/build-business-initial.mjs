import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { annotateDump, navigationMarkdown, readmeMarkdown } from './business-initial-notes.mjs';
import { INITIAL_SEED_TABLES, CANONICAL_AUTHORIZATION_TABLES, assertCanonicalSeedProof, assertCanonicalSeedRows, assertInitialSingleton, assertInitialMigrationHistory } from './business-initial-seeds.mjs';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMAS = ['zzsh_iam', 'zzsh_auth_user', 'zzsh_auth_admin', 'zzsh_supply', 'zzsh_content', 'zzsh_order', 'zzsh_credit'];
const sha = b => createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const production = args.includes('--production');
const excludedTables = ['zzsh_iam.admin_workspace_layout', 'zzsh_order.local_financial_sandbox_registration',
    'zzsh_order.local_controlled_refund_operation', 'zzsh_order.local_controlled_refund_evidence',
    'zzsh_order.controlled_payment_declaration', 'zzsh_order.controlled_payout_notice', 'zzsh_order.controlled_payout_operation',
    'zzsh_order.withdrawal_admission', 'zzsh_order.withdrawal_destination', 'zzsh_order.withdrawal_intent', 'zzsh_order.withdrawal_provider_fact'];
if (!args.includes('--execute')) {
    console.log(JSON.stringify({ action: 'PLAN', database: production ? 'registered production initial build resource' : 'zzsh_test_regression', required: ['--execute', '--oid', '--baseline <new-release-name>', '--source-count <frozen-canonical-count>', ...(production ? ['--source-db <registered-scratch>'] : []), 'ZZSH_REGRESSION_RUN', 'DB_PASSWORD_FILE'], writes: 'new, exclusive migrations/initial baseline only; no database writes or replacement of release_0141', pgConnections: 0, privateReads: 0 }));
    process.exit(0);
}
if (process.version !== 'v24.20.0')
    throw Error('NODE_BASELINE_MISMATCH');
const expectedOid = opt('--oid');
if (!/^[0-9]+$/.test(expectedOid ?? ''))
    throw Error('REGRESSION_OID_REQUIRED');
const baseline = opt('--baseline'), sourceCount = Number(opt('--source-count'));
if (!/^release_[a-zA-Z0-9_]{1,60}$/.test(baseline ?? '')) throw Error('NEW_BASELINE_NAME_REQUIRED');
if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) throw Error('FROZEN_SOURCE_COUNT_REQUIRED');
const target = join(ROOT, 'apps/api/migrations/initial', baseline);
if (existsSync(target)) throw Error('INITIAL_OUTPUT_ALREADY_EXISTS');
const sourceBaseline = opt('--source-baseline'), dumpBinary = opt('--pg-dump-executable'), dumpBinarySha = opt('--pg-dump-sha256');
if (sourceBaseline && !/^release_[a-zA-Z0-9_]{1,60}$/.test(sourceBaseline)) throw Error('SOURCE_BASELINE_INVALID');
if (Boolean(dumpBinary) !== Boolean(dumpBinarySha)) throw Error('BOUND_PG_DUMP_EXECUTABLE_REQUIRED');
if (dumpBinary && (!isAbsolute(dumpBinary) || !/^[a-f0-9]{64}$/.test(dumpBinarySha) || lstatSync(dumpBinary).isSymbolicLink()
  || !lstatSync(dumpBinary).isFile() || sha(readFileSync(dumpBinary)) !== dumpBinarySha)) throw Error('PG_DUMP_EXECUTABLE_CHANGED');
const expectedNonce = process.env.ZZSH_REGRESSION_RUN;
if (!/^[a-z0-9_]{12,40}$/.test(expectedNonce ?? '')) throw Error('REGRESSION_NONCE_REQUIRED');
const database = production ? opt('--source-db') : 'zzsh_test_regression';
if (production && (!/^zzsh_test_[a-z0-9_]{1,48}$/.test(database ?? '') || database === 'zzsh_test_regression')) throw Error('PRODUCTION_INITIAL_SCRATCH_REQUIRED');
const passwordFile = process.env.DB_PASSWORD_FILE;
if (!passwordFile)
    throw Error('DB_PASSWORD_FILE_REQUIRED');
const password = readFileSync(passwordFile, 'utf8').trim();
const c = new Client({ host: '127.0.0.1', port: 55432, database, user: 'zzsh', password, application_name: 'zzsh-build-initial', connectionTimeoutMillis: 3000, statement_timeout: 10000, lock_timeout: 500 });
const maintenance = new Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'zzsh', password, application_name: 'zzsh-build-initial-lock', connectionTimeoutMillis: 3000, statement_timeout: 3000, lock_timeout: 500 });
let held = false, begun = false;
try {
    await maintenance.connect();
    held = (await maintenance.query('SELECT pg_try_advisory_lock(806006::bigint) ok')).rows[0].ok;
    if (!held)
        throw Error('REGRESSION_LOCK_BUSY');
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun = true;
    const id = (await c.query("SELECT d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run',true) nonce FROM pg_database d WHERE datname=current_database()")).rows[0];
    if (id.oid !== expectedOid || id.owner !== 'zzsh' || id.marker !== (production ? 'zzsh:production-initial-scratch:v1' : 'zzsh:regression-test:v1') || id.nonce !== expectedNonce)
        throw Error('REGRESSION_IDENTITY_MISMATCH');
    const journal = JSON.parse(readFileSync(join(ROOT, 'apps/api/migrations/business/meta/_journal.json')));
    if (journal.entries.length < sourceCount)
        throw Error('FROZEN_SOURCE_CHAIN_NOT_AVAILABLE');
    const sourceChain = journal.entries.slice(0, sourceCount).map(e => ({ tag: e.tag, when: e.when, sha256: sha(readFileSync(join(ROOT, 'apps/api/migrations/business', e.tag + '.sql'))) }));
    const seedProofPath = join(ROOT, 'apps/api/migrations/initial/seed-proofs', sourceChain.at(-1).tag + '.json');
    if (!existsSync(seedProofPath) || lstatSync(seedProofPath).isSymbolicLink()) throw Error('INITIAL_CANONICAL_SEED_PROOF_REQUIRED');
    const seedProofBytes=readFileSync(seedProofPath), seedProof=JSON.parse(seedProofBytes);
    assertCanonicalSeedProof(seedProof,sourceChain);
    const applied = (await c.query('SELECT hash,created_at::text "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
    if (sourceBaseline) {
      // Reuse the application's verifier: it checks the selected registered
      // baseline, every covered canonical hash, each SQL part and the tail.
      const { readBusinessInitialRegistry, prepareBusinessInitial } = require(join(ROOT, 'apps/api/dist/src/database/business-initial.js'));
      const registry = readBusinessInitialRegistry(join(ROOT, 'apps/api/migrations/initial'));
      const selected = registry.supported.find(entry => entry.name === sourceBaseline);
      if (!selected || production && selected.manifest.profile !== 'PRODUCTION') throw Error('SOURCE_BASELINE_NOT_REGISTERED');
      const prepared = prepareBusinessInitial(join(ROOT, 'apps/api/migrations/business'), selected.folder);
      try {
        if (prepared.manifest.sourceCount > sourceCount) throw Error('SOURCE_BASELINE_EXCEEDS_CHAIN');
        const { readMigrationFiles } = require('drizzle-orm/migrator');
        const count = sourceCount - prepared.manifest.sourceCount + 1;
        const expected = readMigrationFiles({migrationsFolder:prepared.folder}).slice(0,count).map(row=>({hash:row.hash,createdAt:row.folderMillis}));
        if (expected.length !== count) throw Error('SOURCE_BASELINE_TAIL_INCOMPLETE');
        assertInitialMigrationHistory(applied,expected);
      } finally { prepared.cleanup(); }
    } else assertInitialMigrationHistory(applied,sourceChain.map(row=>({hash:row.sha256,createdAt:row.when})));
    const tables = (await c.query("SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY 1,2", [SCHEMAS])).rows;
    const ledgerComments = production ? await productionCatalogComments(c, tables) : '';
    const seedCounts = [];
    for (const t of tables) {
        const n = (await c.query(`SELECT count(*)::int n FROM "${t.schema}"."${t.name}"`)).rows[0].n;
        if (n && !INITIAL_SEED_TABLES.has(t.schema + '.' + t.name))
            throw Error('BUSINESS_DATA_MUST_NOT_ENTER_INITIAL:' + t.schema + '.' + t.name);
        if (n)
            seedCounts.push({ table: t.schema + '.' + t.name, count: n });
    }
    for (const name of CANONICAL_AUTHORIZATION_TABLES) {
      const [schema,table]=name.split('.');
      if (!tables.some(row=>row.schema===schema && row.name===table)) throw Error('CANONICAL_SEED_TABLE_MISSING:'+name);
      const rows=(await c.query(`SELECT to_jsonb(t)-ARRAY['created_at','updated_at'] AS row FROM "${schema}"."${table}" t`)).rows.map(row=>row.row);
      assertCanonicalSeedRows(seedProof,name,rows);
    }
    const present = name => tables.some(t => t.schema + '.' + t.name === name);
    const dutyInstalled = sourceChain.some(row => row.tag === '0169_legacy_finance_duty_runtime');
    const singletonQueries = [
      ['zzsh_supply.profile_avatar_policy', 'SELECT singleton,requires_review,revision::text,updated_by_admin_id FROM zzsh_supply.profile_avatar_policy'],
      ['zzsh_order.settlement_refund_policy', 'SELECT singleton,normal_days,early_days,revision::text,updated_by_admin_id FROM zzsh_order.settlement_refund_policy'],
      ['zzsh_order.legacy_duty_finance_contract', 'SELECT singleton,contract_version,enabled,approval_ref,approval_digest FROM zzsh_order.legacy_duty_finance_contract'],
    ];
    for (const [name, sql] of singletonQueries) if (present(name)) assertInitialSingleton(name, (await c.query(sql)).rows, dutyInstalled);
    if (sourceChain.some(row => row.tag === '0163_settlement_refund_wait_policy') && !present('zzsh_order.settlement_refund_policy')
      || dutyInstalled && !present('zzsh_order.legacy_duty_finance_contract')) throw Error('CANONICAL_SINGLETON_TABLE_MISSING');
    const snapshot = (await c.query('SELECT pg_export_snapshot() id')).rows[0].id;
    function dump(extra) { if (dumpBinary && sha(readFileSync(dumpBinary)) !== dumpBinarySha) throw Error('PG_DUMP_EXECUTABLE_CHANGED');
        const common = ['-h', '127.0.0.1', ...(dumpBinary ? ['-p','55432'] : []), '-U', 'zzsh', '-d', database, '--snapshot=' + snapshot, '--no-owner', ...SCHEMAS.map(s => '--schema=' + s), ...extra];
        const r = dumpBinary ? spawnSync(dumpBinary, common, { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 })
          : spawnSync('docker', ['exec', '--env', 'PGPASSWORD', 'zzsh-rebuild-local-postgres-1', 'pg_dump', ...common], { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 }); if (r.status !== 0)
        throw Error('PG_DUMP_FAILED:' + String(r.stderr).slice(0, 180)); return r.stdout.split(String.fromCharCode(10)).filter(line => !line.startsWith(String.fromCharCode(92) + 'restrict ') && !line.startsWith(String.fromCharCode(92) + 'unrestrict ') && !['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'].some(setting => line.startsWith('SET ' + setting + ' = 0;'))).join(String.fromCharCode(10)); }
    const notes = await loadInitialNotes(c);
    const pre = annotateDump(dump(['--section=pre-data', '--no-privileges']), notes);
    const data = dump(['--section=data', '--no-privileges', '--inserts', '--column-inserts']);
    const post = annotateDump(dump(['--section=post-data', '--no-privileges']), notes) + ledgerComments;
    const publicObjects = (await c.query(`SELECT 'SCHEMA' kind,quote_ident(n.nspname) object,a.privilege_type privilege,a.is_grantable FROM pg_namespace n LEFT JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a ON a.grantee=0 WHERE n.nspname=ANY($1::text[])
UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,format('%I.%I',n.nspname,c.relname),a.privilege_type,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) a ON a.grantee=0 WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','S','f')
UNION ALL SELECT 'FUNCTION',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),a.privilege_type,a.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a ON a.grantee=0 WHERE n.nspname=ANY($1::text[])
UNION ALL SELECT 'TYPE',format('%I.%I',n.nspname,t.typname),a.privilege_type,a.is_grantable FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN LATERAL aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a ON a.grantee=0 WHERE n.nspname=ANY($1::text[]) AND t.typtype IN ('e','d') ORDER BY 1,2,3`, [SCHEMAS])).rows;
    const aclStatements = [];
    let previous = '';
    for (const row of publicObjects) {
        const key = row.kind + ':' + row.object;
        if (key !== previous) {
            aclStatements.push('REVOKE ALL ON ' + row.kind + ' ' + row.object + ' FROM PUBLIC;');
            previous = key;
        }
        if (row.privilege)
            aclStatements.push('GRANT ' + row.privilege + ' ON ' + row.kind + ' ' + row.object + ' TO PUBLIC' + (row.is_grantable ? ' WITH GRANT OPTION' : '') + ';');
    }
    const columnGrants = (await c.query(`SELECT format('%I.%I',n.nspname,c.relname) object,quote_ident(t.attname) column,a.privilege_type privilege,a.is_grantable FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(t.attacl) a WHERE n.nspname=ANY($1::text[]) AND t.attnum>0 AND NOT t.attisdropped AND a.grantee=0 ORDER BY 1,2,3`, [SCHEMAS])).rows;
    for (const row of columnGrants)
        aclStatements.push('GRANT ' + row.privilege + ' (' + row.column + ') ON TABLE ' + row.object + ' TO PUBLIC' + (row.is_grantable ? ' WITH GRANT OPTION' : '') + ';');
    const acl = aclStatements.join('\n') + '\n';
    const modules = [
      ['zzsh_auth_user', '用户密码、旧凭据及会话；不得混入管理员认证域'],
      ['zzsh_auth_admin', '管理员密码、TOTP与会话；认证密钥不进入本文件'],
      ['zzsh_iam', '权限、审批、身份与会员；历史事实不伪造成当前授权'],
      ['zzsh_supply', '游戏目录、账号、规则、媒体与发布；展示不代表可交易'],
      ['zzsh_order', '订单、责任与资金账本；历史付款标记不代表新渠道到账'],
      ['zzsh_credit', '信用与保证金；金额和资格由服务端合同核定'],
      ['zzsh_content', '内容和法律文书；正文版本与接受事实分别保留'],
    ];
    const sections = [
      ['01-structure.sql', '最终结构', 'schema、类型、表、序列与函数按原依赖顺序建立；不重排函数体或改变安全属性。', pre],
      ['02-initial_data.sql', '必要静态种子', '仅canonical权限、内置角色、角色权限、审批模板、头像审核、退款等待及旧单资金合同默认单例；禁止导入用户、凭据、会话或交易数据。', data],
      ['03-constraints-triggers.sql', '约束、索引与触发器', '保留唯一性、外键、资金守卫、时序及不可变约束；不关闭触发器或放宽表达式。', post],
      ['04-public-privileges.sql', 'PUBLIC权限边界', '逐对象恢复已核PUBLIC语义；runtime窄权仍由统一applyRuntimePrivileges安装，不绑定本机角色。', acl],
    ].map(([file, title, purpose, sql]) => {
      const header = [`-- 洲洲商行业务数据库新装基线：${baseline}`, `-- 本段：${title}。${purpose}`, `-- 来源：canonical前${sourceCount}份SQL至${sourceChain.at(-1).tag}；已执行的旧SQL和journal不改写。`, '-- 账务*_cents为CNY整数分；比例、单价与旧源文本另依各自单位，不用浮点当账务真值。', '-- UNKNOWN/null不是0；历史观察、当前应付责任、账务入账、银行到账是不同事实。', '-- 保留来源类型、原键、冻结版本和不可变审计；不从流水求和重造原期初。', '-- schema模块导览（以下仅注释，不改变SQL或跨域依赖顺序）：', ...modules.map(([schema, explanation]) => `--   ${schema}：${explanation}`), production ? '-- 正式初始投影剥离纯本地模拟对象和已下线的布局表，写入中文对象COMMENT。' : '-- 原对象COMMENT来自canonical；新增数据库元数据说明须先以前向迁移纳入来源。', ''].join('\n');
      return [file, header + '\n' + sql];
    });
    mkdirSync(target);
    const parts = sections.map(([file, sql]) => { writeFileSync(join(target, file), sql, { flag: 'wx' }); return { file, sha256: sha(sql) }; });
    const documents = [
      ['README.md', production ? productionReadme(baseline, sourceCount, sourceChain.at(-1).tag) : readmeMarkdown(baseline, sourceCount, sourceChain.at(-1).tag)],
      ['NAVIGATION.md', navigationMarkdown(baseline, notes, sections[0][1])],
      ['CANONICAL-SEED-PROOF.json', seedProofBytes],
    ].map(([file, text]) => { writeFileSync(join(target, file), text, { flag: 'wx' }); return { file, sha256: sha(text) }; });
    const combined = sections.map(([, sql]) => sql).join('\n--> statement-breakpoint\n');
    const journalBytes = readFileSync(join(ROOT, 'apps/api/migrations/business/meta/_journal.json'));
    const manifest = { format: 'zzsh.business-initial.v1', baseline, migrationTag: sourceChain.at(-1).tag.slice(0, 4) + '_initial_' + baseline, migrationHash: sha(combined), when: sourceChain.at(-1).when, sourceCount, journalSha256: sha(journalBytes), journalPrefixSha256: sha(JSON.stringify(journal.entries.slice(0, sourceCount))), sourceChain, parts, documents, seedCounts, ...(production ? { profile: 'PRODUCTION', excludedTables } : {}), notes: production ? '生产新装投影；纯本地模拟和停用布局不部署，存续表列含中文COMMENT。canonical历史保持不变；runtime权限由applyRuntimePrivileges安装。' : '仅新装基线；原canonical SQL/journal保持升级历史。中文注释不改对象和函数体；新增COMMENT须先纳入canonical。runtime权限由applyRuntimePrivileges安装。' };
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: 'INITIAL_GENERATED', sourceCount, baseline, parts: parts.length, seedCounts, migrationHash: manifest.migrationHash, bytes: Buffer.byteLength(combined) }));
    await c.query('ROLLBACK');
    begun = false;
}
finally {
    if (begun)
        try {
            await c.query('ROLLBACK');
        }
        catch { }
    await c.end();
    if (held && !(await maintenance.query('SELECT pg_advisory_unlock(806006::bigint) ok')).rows[0].ok)
        throw Error('REGRESSION_UNLOCK_UNKNOWN');
    await maintenance.end();
}

async function productionCatalogComments(client, tables) {
    if (tables.some(t => excludedTables.includes(t.schema + '.' + t.name))
        || (await client.query("SELECT to_regnamespace('zzsh_meta') IS NOT NULL present")).rows[0].present)
        throw Error('PRODUCTION_INITIAL_CONTAINS_EXCLUDED_TABLES');
    const proof = (await client.query(`SELECT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='zzsh_order.finance_economic_root'::regclass AND conname='production_no_local_controlled_root'
        AND contype='c' AND convalidated) AS ready`)).rows[0].ready;
    if (!proof) throw Error('PRODUCTION_INITIAL_CONTRACT_REQUIRED');
    const comments = (await client.query(`SELECT n.nspname schema,c.relname name,a.attname AS "column",
      CASE WHEN a.attname IS NULL THEN obj_description(c.oid,'pg_class') ELSE col_description(c.oid,a.attnum) END description,
      CASE WHEN a.attname IS NULL THEN format('%I.%I',n.nspname,c.relname) ELSE format('%I.%I.%I',n.nspname,c.relname,a.attname) END identifier
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL (SELECT NULL::name attname,0 attnum UNION ALL SELECT attname,attnum FROM pg_attribute
        WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) a
      WHERE c.relkind IN ('r','p') AND (n.nspname=ANY($1::text[]) OR (n.nspname='zzsh_business_meta' AND c.relname='migrations'))
      ORDER BY n.nspname,c.relname,a.attnum`, [SCHEMAS])).rows;
    const incomplete = comments.filter(row => !/\p{Script=Han}/u.test(row.description ?? ''));
    if (incomplete.length) throw Error('PRODUCTION_INITIAL_MISSING_CHINESE_COMMENT:' + incomplete.map(row => row.identifier).join(','));
    const ledger = comments.filter(row => row.schema === 'zzsh_business_meta');
    if (ledger.length !== 4) throw Error('PRODUCTION_INITIAL_LEDGER_COMMENT_SHAPE');
    // Drizzle creates this ledger before running the first migration; its rows are never dumped.
    return '\n' + ledger.map(row => `COMMENT ON ${row.column ? 'COLUMN' : 'TABLE'} ${row.identifier} IS '${row.description.replaceAll("'", "''")}';`).join('\n') + '\n';
}

function productionReadme(baseline, sourceCount, sourceTag) {
    return `# ${baseline} 生产新装基线\n\n基于 canonical 前 ${sourceCount} 份迁移（至 ${sourceTag}）形成的空库生产投影。表和有效列均含写入数据库目录的中文 COMMENT。\n\n` +
        '本基线不部署测试元数据、已下线的工作台布局或纯模拟资金辅助表；正式渠道守卫、旧来源、责任和审计表保留。\n\n' +
        '剥离的业务 schema 表：\n\n' + excludedTables.map(table => '- `' + table + '`').join('\n') +
        '\n\n已装 canonical 或旧 initial 的数据库沿各自记录升级。生产投影只用于空库；版本账记一条 baseline 及后续 canonical 增量。\n';
}

async function loadInitialNotes(client) {
  const columns = (await client.query(`SELECT n.nspname AS schema,c.relname AS "table",a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,a.attnum`, [SCHEMAS])).rows;
  const constraints = (await client.query(`SELECT n.nspname AS schema,c.relname AS "table",co.conname AS name,co.contype,pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND co.contype IN ('p','f','c') ORDER BY 1,2,co.conname`, [SCHEMAS])).rows;
  const functions = (await client.query(`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_arguments(p.oid) AS "dumpArgs",p.provolatile AS volatile,p.prosecdef AS definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[]) ORDER BY 1,2,3`, [SCHEMAS])).rows;
  const triggers = (await client.query(`SELECT n.nspname AS schema,c.relname AS "table",t.tgname AS name,pn.nspname AS "functionSchema",p.proname AS "functionName"
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY 1,2,3`, [SCHEMAS])).rows;
  const indexes = (await client.query(`SELECT schemaname AS schema,tablename AS "table",indexname AS name FROM pg_indexes WHERE schemaname=ANY($1::text[]) ORDER BY 1,2,3`, [SCHEMAS])).rows;
  const tables = new Map();
  for (const column of columns) {
    const key = column.schema + '.' + column.table;
    const table = tables.get(key) ?? { schema: column.schema, name: column.table, columns: [], primaryKey: [], foreignKeys: [], checks: [] };
    table.columns.push({ name: column.name, type: column.type });
    tables.set(key, table);
  }
  for (const constraint of constraints) {
    const table = tables.get(constraint.schema + '.' + constraint.table);
    if (!table) continue;
    if (constraint.contype === 'p') table.primaryKey = [...constraint.def.matchAll(/\(([^)]*)\)/g)].at(-1)?.[1].split(',').map(item => item.trim()) ?? [];
    if (constraint.contype === 'f') table.foreignKeys.push(constraint.def);
    if (constraint.contype === 'c') table.checks.push({ name: constraint.name, def: constraint.def });
  }
  return { tables: [...tables.values()], functions, triggers, indexes };
}
