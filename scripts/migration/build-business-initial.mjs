import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMAS = ['zzsh_iam', 'zzsh_auth_user', 'zzsh_auth_admin', 'zzsh_supply', 'zzsh_content', 'zzsh_order', 'zzsh_credit'];
const SEEDS = new Set(['zzsh_iam.admin_permission', 'zzsh_iam.admin_role', 'zzsh_iam.admin_role_permission', 'zzsh_iam.approval_template']);
const sha = b => createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
if (!args.includes('--execute')) {
    console.log(JSON.stringify({ action: 'PLAN', database: 'zzsh_test_regression', required: ['--execute', '--oid', '--baseline <new-release-name>', '--source-count <frozen-canonical-count>', 'DB_PASSWORD_FILE'], writes: 'new, exclusive migrations/initial baseline only; no database writes or replacement of release_0141', pgConnections: 0, privateReads: 0 }));
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
const passwordFile = process.env.DB_PASSWORD_FILE;
if (!passwordFile)
    throw Error('DB_PASSWORD_FILE_REQUIRED');
const password = readFileSync(passwordFile, 'utf8').trim();
const c = new Client({ host: '127.0.0.1', port: 55432, database: 'zzsh_test_regression', user: 'zzsh', password, application_name: 'zzsh-build-initial', connectionTimeoutMillis: 3000, statement_timeout: 10000, lock_timeout: 500 });
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
    const id = (await c.query("SELECT d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker FROM pg_database d WHERE datname=current_database()")).rows[0];
    if (id.oid !== expectedOid || id.owner !== 'zzsh' || id.marker !== 'zzsh:regression-test:v1')
        throw Error('REGRESSION_IDENTITY_MISMATCH');
    const journal = JSON.parse(readFileSync(join(ROOT, 'apps/api/migrations/business/meta/_journal.json')));
    if (journal.entries.length < sourceCount)
        throw Error('FROZEN_SOURCE_CHAIN_NOT_AVAILABLE');
    const sourceChain = journal.entries.slice(0, sourceCount).map(e => ({ tag: e.tag, when: e.when, sha256: sha(readFileSync(join(ROOT, 'apps/api/migrations/business', e.tag + '.sql'))) }));
    const applied = (await c.query('SELECT hash,created_at::text "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
    if (applied.length !== sourceChain.length || applied.some((r, i) => r.hash !== sourceChain[i].sha256 || r.createdAt !== String(sourceChain[i].when)))
        throw Error('SOURCE_DATABASE_NOT_EXACT_CANONICAL_CHAIN');
    const tables = (await c.query("SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY 1,2", [SCHEMAS])).rows;
    const seedCounts = [];
    for (const t of tables) {
        const n = (await c.query(`SELECT count(*)::int n FROM "${t.schema}"."${t.name}"`)).rows[0].n;
        if (n && !SEEDS.has(t.schema + '.' + t.name))
            throw Error('BUSINESS_DATA_MUST_NOT_ENTER_INITIAL:' + t.schema + '.' + t.name);
        if (n)
            seedCounts.push({ table: t.schema + '.' + t.name, count: n });
    }
    const snapshot = (await c.query('SELECT pg_export_snapshot() id')).rows[0].id;
    function dump(extra) { const r = spawnSync('docker', ['exec', '--env', 'PGPASSWORD', 'zzsh-rebuild-local-postgres-1', 'pg_dump', '-h', '127.0.0.1', '-U', 'zzsh', '-d', 'zzsh_test_regression', '--snapshot=' + snapshot, '--no-owner', ...SCHEMAS.map(s => '--schema=' + s), ...extra], { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 }); if (r.status !== 0)
        throw Error('PG_DUMP_FAILED:' + String(r.stderr).slice(0, 180)); return r.stdout.split(String.fromCharCode(10)).filter(line => !line.startsWith(String.fromCharCode(92) + 'restrict ') && !line.startsWith(String.fromCharCode(92) + 'unrestrict ') && !['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'].some(setting => line.startsWith('SET ' + setting + ' = 0;'))).join(String.fromCharCode(10)); }
    const pre = dump(['--section=pre-data', '--no-privileges']);
    const data = dump(['--section=data', '--no-privileges', '--inserts', '--column-inserts']);
    const post = dump(['--section=post-data', '--no-privileges']);
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
      ['02-required-data.sql', '必要静态种子', '仅权限、内置角色、角色权限和审批模板；禁止导入用户、凭据、会话或交易数据。', data],
      ['03-constraints-triggers.sql', '约束、索引与触发器', '保留唯一性、外键、资金守卫、时序及不可变约束；不关闭触发器或放宽表达式。', post],
      ['04-public-privileges.sql', 'PUBLIC权限边界', '逐对象恢复已核PUBLIC语义；runtime窄权仍由统一applyRuntimePrivileges安装，不绑定本机角色。', acl],
    ].map(([file, title, purpose, sql]) => {
      const header = [`-- 洲洲商行业务数据库新装基线：${baseline}`, `-- 本段：${title}。${purpose}`, `-- 来源：canonical前${sourceCount}份SQL至${sourceChain.at(-1).tag}；已执行的旧SQL和journal不改写。`, '-- 账务*_cents为CNY整数分；比例、单价与旧源文本另依各自单位，不用浮点当账务真值。', '-- UNKNOWN/null不是0；历史观察、当前应付责任、账务入账、银行到账是不同事实。', '-- 保留来源类型、原键、冻结版本和不可变审计；不从流水求和重造原期初。', '-- schema模块导览（以下仅注释，不改变SQL或跨域依赖顺序）：', ...modules.map(([schema, explanation]) => `--   ${schema}：${explanation}`), '-- 原对象COMMENT来自canonical；新增数据库元数据说明须先以前向迁移纳入来源。', ''].join('\n');
      return [file, header + '\n' + sql];
    });
    mkdirSync(target);
    const parts = sections.map(([file, sql]) => { writeFileSync(join(target, file), sql, { flag: 'wx' }); return { file, sha256: sha(sql) }; });
    const combined = sections.map(([, sql]) => sql).join('\n--> statement-breakpoint\n');
    const manifest = { format: 'zzsh.business-initial.v1', baseline, migrationTag: sourceChain.at(-1).tag.slice(0, 4) + '_initial_' + baseline, migrationHash: sha(combined), when: sourceChain.at(-1).when, sourceCount, sourceChain, parts, seedCounts, sourceDatabase: { oid: expectedOid, connectionRole: 'zzsh', schemaOwner: 'zzsh_regression_migration' }, notes: '仅新装基线；原canonical SQL/journal保持升级历史。中文注释不改对象和函数体；新增COMMENT须先纳入canonical。runtime权限由applyRuntimePrivileges安装。' };
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
