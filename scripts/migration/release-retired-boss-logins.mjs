import { createHash } from 'node:crypto';

const usernames = ['zz00001', 'zz00002'];
const validId = value => typeof value === 'string' && /^admin_[a-f0-9]{32}$/.test(value);
const fail = code => { throw new Error(code); };

/** Release only previously retired migration identities; never restore their credentials. */
export async function releaseRetiredBossLogins(client, plan) {
  const target = plan?.target;
  const local = target?.marker === 'zzsh:r07-delivery-clone:v1';
  const ecs = target?.marker === 'zzsh:ecs-test:v1';
  if (!['ROLLBACK_TEST', 'APPLY'].includes(plan?.mode) || !/^[a-z0-9][a-z0-9_-]{7,80}$/.test(plan?.requestId ?? '')
    || !Array.isArray(plan?.retiredIds) || plan.retiredIds.length !== 2 || plan.retiredIds.some(id => !validId(id))
    || new Set(plan.retiredIds).size !== 2 || plan.activeBossId !== null && (!validId(plan.activeBossId) || plan.retiredIds.includes(plan.activeBossId))
    || !target || !/^[1-9]\d*$/.test(target.oid ?? '') || !/^[1-9]\d*$/.test(target.systemIdentifier ?? '')
    || !/^[1-9]\d*$/.test(target.ownerOid ?? '') || !/^[1-9]\d*$/.test(target.roleOid ?? '')
    || local && (target.database !== 'zzsh_test_r07_delivery_20261108' || target.oid !== '16391'
      || target.systemIdentifier !== '7705473419326033954' || target.role !== 'zzsh_regression_migration'
      || target.roleOid !== '16389' || target.owner !== 'zzsh' || target.ownerOid !== '16388')
    || ecs && (!/^zzsh_ecs_test(?:_[a-z0-9_]{1,32})?$/.test(target.database ?? '') || target.role !== 'zzsh_ecs_migration'
      || target.owner !== 'zzsh_ecs_owner')
    || !local && !ecs) fail('BOSS_RELEASE_PLAN_INVALID');

  const auditId = 'audit_' + createHash('sha256').update(plan.requestId).digest('hex').slice(0, 32);
  let begun = false, commitSent = false;
  try {
    await client.query('BEGIN'); begun = true;
    await client.query("SET LOCAL lock_timeout='3s'");
    const live = (await client.query(`SELECT d.datname AS database,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,current_user AS role,r.oid::text AS role_oid,
      pg_get_userbyid(d.datdba) AS owner,d.datdba::text AS owner_oid,pg_get_userbyid(n.nspowner) AS schema_owner,
      r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
      COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS ssl
      FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_auth_admin' JOIN pg_roles r ON r.rolname=current_user
      WHERE d.datname=current_database()`)).rows[0];
    if (!live || live.database !== target.database || live.oid !== target.oid || live.marker !== target.marker
      || live.system_identifier !== target.systemIdentifier || live.role !== target.role || live.role_oid !== target.roleOid
      || live.owner !== target.owner || live.owner_oid !== target.ownerOid || live.schema_owner !== target.role
      || live.rolsuper !== false || live.rolbypassrls !== false || live.rolcreatedb !== false || live.rolcreaterole !== false
      || live.rolreplication !== false || ecs && live.ssl !== true) fail('BOSS_RELEASE_TARGET_CHANGED');
    if (!(await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', ['806007'])).rows[0]?.ok) fail('BOSS_RELEASE_TARGET_BUSY');
    if ((await client.query('SELECT 1 FROM zzsh_iam.audit_event WHERE id=$1', [auditId])).rows.length) fail('BOSS_RELEASE_ORIGINAL_READBACK_REQUIRED');

    const retired = (await client.query(`SELECT u.id,u.username,u.email,u.suspended,u."twoFactorEnabled" AS factor,
      EXISTS(SELECT 1 FROM zzsh_iam.admin_security s WHERE s.admin_user_id=u.id) AS security,
      EXISTS(SELECT 1 FROM zzsh_auth_admin.account a WHERE a."userId"=u.id) AS credentials,
      EXISTS(SELECT 1 FROM zzsh_auth_admin."twoFactor" f WHERE f."userId"=u.id) AS factors,
      EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s."userId"=u.id) AS sessions,
      EXISTS(SELECT 1 FROM zzsh_iam.audit_event e WHERE e.action='admin.migration_identity.retired' AND e.outcome='SUCCESS'
        AND (e.details->'actors') @> jsonb_build_array(jsonb_build_object('id',u.id,'kind','BOOTSTRAP'))) AS retirement_proven
      FROM zzsh_auth_admin."user" u WHERE u.id=ANY($1::text[]) ORDER BY u.username FOR UPDATE OF u`, [plan.retiredIds])).rows;
    if (retired.length !== 2 || retired.some((row, i) => row.username !== usernames[i] || !plan.retiredIds.includes(row.id)
      || row.email !== `${row.username}@admin.zzsh.invalid` || row.suspended !== true || row.factor !== false
      || row.security || row.credentials || row.factors || row.sessions || row.retirement_proven !== true)) fail('BOSS_RELEASE_RETIRED_STATE_CHANGED');

    const bosses = (await client.query(`SELECT u.id,u.username,u.email,u.suspended,u."twoFactorEnabled" AS factor,s.status,
      EXISTS(SELECT 1 FROM zzsh_auth_admin.account a WHERE a."userId"=u.id AND a."providerId"='credential' AND a.password IS NOT NULL) AS credentials
      FROM zzsh_iam.admin_security s JOIN zzsh_auth_admin."user" u ON u.id=s.admin_user_id
      WHERE s.is_boss=true ORDER BY u.id FOR UPDATE OF s,u`)).rows;
    if (plan.activeBossId === null ? bosses.length !== 0 : bosses.length !== 1 || bosses[0].id !== plan.activeBossId
      || bosses[0].username !== 'zz00005' || bosses[0].email !== 'zz00005@admin.zzsh.invalid'
      || bosses[0].suspended !== false || bosses[0].factor !== true || bosses[0].credentials !== true || bosses[0].status !== 'ACTIVE') fail('BOSS_RELEASE_ACTIVE_STATE_CHANGED');

    const aliases = retired.map(row => `retired_${row.id}`);
    if ((await client.query('SELECT 1 FROM zzsh_auth_admin."user" WHERE username=ANY($1::text[]) OR email=ANY($2::text[])',
      [aliases, aliases.map(alias => `${alias}@admin.zzsh.invalid`)])).rows.length) fail('BOSS_RELEASE_ALIAS_OCCUPIED');
    for (let i = 0; i < retired.length; i++) {
      const changed = await client.query(`UPDATE zzsh_auth_admin."user" SET username=$2,email=$3,"updatedAt"=clock_timestamp()
        WHERE id=$1 AND username=$4`, [retired[i].id, aliases[i], `${aliases[i]}@admin.zzsh.invalid`, usernames[i]]);
      if (changed.rowCount !== 1) fail('BOSS_RELEASE_UPDATE_CHANGED');
    }
    if (plan.activeBossId !== null) {
      const changed = await client.query(`UPDATE zzsh_auth_admin."user" SET username='zz00001',"displayUsername"='ZZ00001',
        email='zz00001@admin.zzsh.invalid',"updatedAt"=clock_timestamp() WHERE id=$1 AND username='zz00005'`, [plan.activeBossId]);
      if (changed.rowCount !== 1) fail('BOSS_RELEASE_ACTIVE_UPDATE_CHANGED');
    }
    await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
      VALUES($1,'system','admin.migration_login.released','admin_staging_handoff',$2,'SUCCESS',$3,$4,clock_timestamp(),$5::jsonb)`,
      [auditId, target.database, plan.requestId, '释放已退役的迁移测试身份占用的 Boss 编号', JSON.stringify({
        retired: retired.map((row, i) => ({ id: row.id, previousUsername: row.username, archivedUsername: aliases[i] })),
        activeBossId: plan.activeBossId, activeBossPreviousUsername: plan.activeBossId ? 'zz00005' : null,
      })]);
    if (plan.mode === 'ROLLBACK_TEST') {
      if ((await client.query('ROLLBACK')).command !== 'ROLLBACK') fail('BOSS_RELEASE_ROLLBACK_UNKNOWN');
      begun = false; return { status: 'ROLLBACK_TEST_PASSED', auditId };
    }
    commitSent = true;
    if ((await client.query('COMMIT')).command !== 'COMMIT') fail('BOSS_RELEASE_COMMIT_UNKNOWN');
    begun = false; return { status: 'COMMIT_ACK', auditId };
  } catch (error) {
    if (commitSent) throw Object.assign(new Error('BOSS_RELEASE_COMMIT_UNKNOWN'), { cause: error, auditId });
    if (begun) try { await client.query('ROLLBACK'); } catch (rollback) { throw Object.assign(new Error('BOSS_RELEASE_ROLLBACK_UNKNOWN'), { cause: rollback, auditId }); }
    throw error;
  }
}
