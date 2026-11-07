import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const ident = text => {
  if (typeof text !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error('ADMIN_HANDOFF_UNSAFE_IDENTIFIER');
  return `"${text}"`;
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
export const deliveryAuthSnapshotDigest = value => hash(canonical(value));
async function userAccountProof(client) {
  return (await client.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY id COLLATE "C"),''),'UTF8')),'hex') digest FROM zzsh_auth_user.account t`)).rows[0];
}

/** Return exact target row IDs and database-side digests; credential values never leave PostgreSQL. */
export async function snapshotDeliveryAuth(client) {
  const admins=(await client.query(`SELECT u.id,s.is_boss,s.status,s.first_activated_at IS NOT NULL activated,
    (SELECT a.id FROM zzsh_iam.audit_event a WHERE a.object_type='admin_user' AND a.object_id=u.id AND a.outcome='SUCCESS'
      AND a.action=CASE WHEN s.is_boss THEN 'admin.bootstrap.created' ELSE 'admin.account.created' END ORDER BY a.occurred_at,a.id LIMIT 1) creation_audit_id
    FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id ORDER BY u.id COLLATE "C"`)).rows;
  if (!admins.length || admins.length>100 || admins.some(a=>!/^admin_[a-f0-9]{32}$/.test(a.id) || a.status!=='ACTIVE' || !a.activated
    || typeof a.is_boss!=='boolean' || !/^audit_[a-f0-9]{32}$/.test(a.creation_audit_id??''))) throw new Error('ADMIN_HANDOFF_ACTOR_INVENTORY_CHANGED');
  const actors=admins.map(a=>({id:a.id,creationAuditId:a.creation_audit_id,kind:a.is_boss?'BOOTSTRAP':'STAFF'})),ids=actors.map(a=>a.id),artifacts=[];
  const specs=[
    ['ADMIN_USER','zzsh_auth_admin."user"','id','id'],['ADMIN_SECURITY','zzsh_iam.admin_security','admin_user_id','admin_user_id'],
    ['ADMIN_ACCOUNT','zzsh_auth_admin.account','"userId"','id'],['ADMIN_TOTP','zzsh_auth_admin."twoFactor"','"userId"','id'],
    ['ADMIN_SESSION','zzsh_auth_admin.session','"userId"','id'],['ADMIN_ROLE','zzsh_iam.admin_user_role','admin_user_id','role_id'],
    ['ADMIN_PERMISSION','zzsh_iam.admin_user_permission','admin_user_id','permission_code'],['ADMIN_SCOPE','zzsh_supply.admin_supply_scope','admin_user_id','game_id'],
    ['ADMIN_RECOVERY','zzsh_iam.admin_recovery_request','target_admin_user_id','id'],['ADMIN_NOTIFICATION','zzsh_iam.admin_recovery_notification_target','admin_user_id','id'],
  ];
  for(const [kind,table,subject,id] of specs){const rows=(await client.query(`SELECT ${subject} AS subject,${id} AS id,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM ${table} t WHERE ${subject}=ANY($1::text[]) ORDER BY ${subject} COLLATE "C",${id} COLLATE "C"`,[ids])).rows;
    for(const row of rows)artifacts.push({kind,...row});}
  const adminVerifications=(await client.query('SELECT count(*)::int n FROM zzsh_auth_admin.verification')).rows[0].n;
  if(adminVerifications!==0)throw new Error('ADMIN_HANDOFF_UNSCOPED_ADMIN_VERIFICATION');
  const userSessions=(await client.query(`SELECT id,"userId" AS subject,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM zzsh_auth_user.session t ORDER BY id COLLATE "C"`)).rows;
  const userVerifications=(await client.query(`SELECT id,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest,
    ("expiresAt"<=clock_timestamp()) AS expired,(identifier LIKE 'phone-registration:%' AND value ~ '^[0-9]{4}:[0-3]$') AS recognized
    FROM zzsh_auth_user.verification t ORDER BY id COLLATE "C"`)).rows;
  if(userVerifications.some(v=>!v.expired||!v.recognized))throw new Error('ADMIN_HANDOFF_USER_VERIFICATION_UNPROVEN');
  const userAccounts=await userAccountProof(client);
  return{schema:'zzsh.delivery-auth-preimage.v1',actors,artifacts,userSessions,userVerifications,userAccounts};
}

export function deliveryHandoffDigest(request) {
  const actors=[...request.actors].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return hash(canonical({schema:request.schema,target:request.target,sourceDatasetSha256:request.sourceDatasetSha256,approvalRef:request.approvalRef,actors,
    ...(request.snapshotDigest?{snapshotDigest:request.snapshotDigest,attempt:request.attempt,planSha256:request.planSha256,notBefore:request.notBefore,expiresAt:request.expiresAt}: {})}));
}

/**
 * Retire reviewed local migration identities in the synthetic fixture or the exact registered R07 clone.
 * This is not an admin reset endpoint: their original identities and attribution stay in place,
 * and new human Boss accounts are created later by the existing bootstrap API.
 * The caller must hold the exact registered credentials and preserve the original input on an
 * uncertain commit. Only the named local delivery clone may use the bound reviewed plan.
 */
export async function retireStagingMigrationAdmins(client, request, options={}) {
  const clone=request?.target?.marker==='zzsh:r07-delivery-clone:v1';
  const targetOk=clone ? request.target.database==='zzsh_test_r07_delivery_20261108'&&request.target.oid==='16391'
    &&request.target.systemIdentifier==='7705473419326033954'&&request.target.role==='zzsh_regression_migration'
    &&request.target.host==='127.0.0.1'&&request.target.port===55434
    &&request.target.roleOid==='16389'&&request.target.owner==='zzsh'&&request.target.ownerOid==='16388'&&request.target.nonce==='62ca9c4e419e1039f500ac1e'
    &&request.sourceDatasetSha256==='a55730c8b0c036a1c27cfb65650a1ac9e4d21803598113ac2f2d035f91c0154b'
    &&/^[a-f0-9]{64}$/.test(request.planSha256??'')&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.attempt??'')
    : request?.target?.marker==='zzsh:r08-auth-handoff:v1';
  if (!request || request.schema !== 'zzsh.admin-staging-handoff.v1'
    || !targetOk
    || !/^zzsh_test_[a-z0-9_]{1,48}$/.test(request.target.database ?? '')
    || request.target.database === 'zzsh_test_regression'
    || !/^[0-9]+$/.test(request.target.oid ?? '') || !/^[0-9]+$/.test(request.target.systemIdentifier ?? '')
    || !/^[a-z][a-z0-9_]{0,62}$/.test(request.target.role ?? '')
    || !/^[a-f0-9]{64}$/.test(request.sourceDatasetSha256 ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.approvalRef ?? '')
    || !Array.isArray(request.actors) || request.actors.length < 1 || request.actors.length > 100)
    throw new Error('ADMIN_HANDOFF_INPUT_INVALID');
  if (request.actors.some(actor=>!actor || typeof actor!=='object' || Array.isArray(actor))) throw new Error('ADMIN_HANDOFF_ACTORS_INVALID');
  const actors=[...request.actors].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if (actors.some(a=>!/^admin_[a-f0-9]{32}$/.test(a.id ?? '') || !/^audit_[a-f0-9]{32}$/.test(a.creationAuditId ?? '')
      || !['BOOTSTRAP','STAFF'].includes(a.kind) || Object.keys(a).sort().join(',')!=='creationAuditId,id,kind')
    || new Set(actors.map(a=>a.id)).size!==actors.length || new Set(actors.map(a=>a.creationAuditId)).size!==actors.length)
    throw new Error('ADMIN_HANDOFF_ACTORS_INVALID');
  if(clone&&(!request.snapshot||typeof options.beforeCommit!=='function')||request.snapshot&&(request.snapshot.schema!=='zzsh.delivery-auth-preimage.v1'||!/^([a-f0-9]{64})$/.test(request.snapshotDigest??'')
    ||hash(canonical(request.snapshot))!==request.snapshotDigest||canonical(request.snapshot.actors)!==canonical(actors)))throw new Error('ADMIN_HANDOFF_PREIMAGE_INVALID');
  const activeWindow=()=>{if(!clone)return;const start=Date.parse(request.notBefore),end=Date.parse(request.expiresAt),now=Date.now(),iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    if(!iso.test(request.notBefore??'')||!iso.test(request.expiresAt??'')||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end<=start||end-start>30*60_000)throw new Error('ADMIN_HANDOFF_WINDOW_INACTIVE');};
  const databaseWindow=async()=>{if(!clone)return;const now=new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now).getTime();
    if(!Number.isFinite(now)||now<Date.parse(request.notBefore)||now>=Date.parse(request.expiresAt))throw new Error('ADMIN_HANDOFF_WINDOW_INACTIVE');};
  activeWindow();
  const digest=deliveryHandoffDigest({...request,actors}), auditId='audit_'+digest.slice(0,32), actorIds=actors.map(a=>a.id);
  let begun=false,commitSent=false;
  try {
    await client.query('BEGIN');begun=true;
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL TIME ZONE 'UTC'");
    const target=(await client.query(`SELECT current_database() database,d.oid::text oid,shobj_description(d.oid,'pg_database') marker,
      current_user role,r.oid::text role_oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolbypassrls,pg_get_userbyid(d.datdba) owner,d.datdba::text owner_oid,
      current_setting('zzsh.regression_run',true) nonce,(SELECT system_identifier::text FROM pg_control_system()) system_identifier
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    if (!target || target.database!==request.target.database || target.oid!==request.target.oid || target.marker!==request.target.marker
      || target.role!==request.target.role || target.rolsuper!==false || target.system_identifier!==request.target.systemIdentifier
      || clone&&(target.role_oid!==request.target.roleOid||target.owner!==request.target.owner||target.owner_oid!==request.target.ownerOid||target.nonce!==request.target.nonce
        ||target.rolcreatedb||target.rolcreaterole||target.rolinherit||target.rolbypassrls))
      throw new Error('ADMIN_HANDOFF_TARGET_MISMATCH');
    await databaseWindow();
    if (!(await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) ok',[clone?'806007':'806006'])).rows[0]?.ok) throw new Error('ADMIN_HANDOFF_TARGET_BUSY');
    await client.query(`LOCK TABLE zzsh_auth_admin."user",zzsh_iam.admin_security,zzsh_auth_admin.account,
      zzsh_auth_admin."twoFactor",zzsh_auth_admin.session,zzsh_auth_admin.verification,zzsh_iam.admin_recovery_request,
      zzsh_iam.admin_user_role,zzsh_iam.admin_user_permission,zzsh_supply.admin_supply_scope,
      zzsh_iam.admin_recovery_notification_target,zzsh_auth_user.session,zzsh_auth_user.verification,zzsh_auth_user.account IN ACCESS EXCLUSIVE MODE`);
    if(request.snapshot&&canonical(await snapshotDeliveryAuth(client))!==canonical(request.snapshot))throw new Error('ADMIN_HANDOFF_PREIMAGE_CHANGED');
    const users=(await client.query(`SELECT u.id,u.suspended,u."twoFactorEnabled",s.status,s.is_boss,s.first_activated_at,
      CASE WHEN s.admin_user_id IS NULL THEN NULL ELSE jsonb_build_object('status',s.status,'isBoss',s.is_boss,
        'bootstrapExpiresAt',s.bootstrap_expires_at,'bootstrapUsedAt',s.bootstrap_used_at,'createdAt',s.created_at,'updatedAt',s.updated_at,
        'firstActivatedAt',s.first_activated_at,'passwordChangeRequired',s.password_change_required,
        'lastFullAuthenticatedAt',s.last_full_authenticated_at,'gameScopeMode',s.game_scope_mode,'loginTwoFactorRequired',s.login_two_factor_required) END AS security_snapshot
      FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id ORDER BY u.id COLLATE "C"`)).rows;
    if (users.length!==actors.length || users.some((row,index)=>row.id!==actors[index].id)) throw new Error('ADMIN_HANDOFF_ACTOR_INVENTORY_CHANGED');
    const audits=(await client.query(`SELECT id,object_id,action,outcome FROM zzsh_iam.audit_event
      WHERE id=ANY($1::text[]) AND object_type='admin_user'`,[actors.map(a=>a.creationAuditId)])).rows;
    for (const actor of actors) {
      const matches=audits.filter(a=>a.id===actor.creationAuditId && a.object_id===actor.id && a.outcome==='SUCCESS'
        && a.action===(actor.kind==='BOOTSTRAP'?'admin.bootstrap.created':'admin.account.created'));
      if (matches.length!==1) throw new Error('ADMIN_HANDOFF_ACTOR_CREATION_UNPROVEN');
    }
    const previous=(await client.query('SELECT action,details FROM zzsh_iam.audit_event WHERE id=$1',[auditId])).rows[0];
    const credentials=async()=> (await client.query(`SELECT
      (SELECT count(*)::int FROM zzsh_auth_admin.account) accounts,
      (SELECT count(*)::int FROM zzsh_auth_admin."twoFactor") factors,
      (SELECT count(*)::int FROM zzsh_auth_admin.session) sessions,
      (SELECT count(*)::int FROM zzsh_auth_admin.verification) challenges,
      (SELECT count(*)::int FROM zzsh_iam.admin_recovery_request WHERE recovery_token_hash IS NOT NULL) recovery_tokens,
      (SELECT count(*)::int FROM zzsh_iam.admin_security) security_rows,
      (SELECT count(*)::int FROM zzsh_iam.admin_user_role) roles,
      (SELECT count(*)::int FROM zzsh_iam.admin_user_permission) permissions,
      (SELECT count(*)::int FROM zzsh_supply.admin_supply_scope) scopes,
      (SELECT count(*)::int FROM zzsh_iam.admin_recovery_notification_target WHERE active) notifications`)).rows[0];
    if ((await credentials()).challenges!==0) throw new Error('ADMIN_HANDOFF_UNSCOPED_ADMIN_VERIFICATION');
    if (previous) {
      if(clone)throw new Error('ADMIN_HANDOFF_READBACK_REQUIRED');
      const left=await credentials();
      if (previous.action!=='admin.migration_identity.retired' || previous.details?.handoffDigest!==digest
        || users.some(row=>!row.suspended || row.twoFactorEnabled!==false || row.status!==null || row.is_boss!==null)
        || Object.values(left).some(value=>value!==0)) throw new Error('ADMIN_HANDOFF_PRIOR_RECEIPT_CONFLICT');
      await client.query('ROLLBACK');begun=false;return {status:'REPLAY_VERIFIED',handoffDigest:digest,actors:actors.length};
    }
    if (users.some((row,index)=>row.suspended || row.status!=='ACTIVE' || !row.first_activated_at
      || row.is_boss!==(actors[index].kind==='BOOTSTRAP'))) throw new Error('ADMIN_HANDOFF_ACTOR_STATE_CHANGED');
    const activation=[];
    for(const row of users) {
      const events=(await client.query(`SELECT id FROM zzsh_iam.audit_event WHERE action='admin.enrollment.activated'
        AND object_type='admin_security' AND object_id=$1 AND outcome='SUCCESS' ORDER BY occurred_at,id`,[row.id])).rows;
      if(!events.length)throw new Error('ADMIN_HANDOFF_FIRST_ACTIVATION_UNPROVEN');
      activation.push({id:row.id,firstActivatedAt:row.security_snapshot.firstActivatedAt,wasBoss:row.is_boss,activationAuditId:events[0].id,securitySnapshot:row.security_snapshot});
    }
    const grants={
      roles:(await client.query('SELECT admin_user_id,role_id FROM zzsh_iam.admin_user_role WHERE admin_user_id=ANY($1::text[]) ORDER BY admin_user_id,role_id',[actorIds])).rows,
      permissions:(await client.query('SELECT admin_user_id,permission_code,effect FROM zzsh_iam.admin_user_permission WHERE admin_user_id=ANY($1::text[]) ORDER BY admin_user_id,permission_code',[actorIds])).rows,
      scopes:(await client.query(`SELECT to_jsonb(s) AS row FROM zzsh_supply.admin_supply_scope s WHERE admin_user_id=ANY($1::text[]) ORDER BY admin_user_id,game_id`,[actorIds])).rows.map(row=>row.row),
    };
    const malformedRecovery=(await client.query(`SELECT count(*)::int n FROM zzsh_iam.admin_recovery_request
      WHERE recovery_token_hash IS NOT NULL AND status NOT IN ('PENDING','ISSUED')`)).rows[0].n;
    if (malformedRecovery) throw new Error('ADMIN_HANDOFF_RECOVERY_TOKEN_STATE_UNKNOWN');
    // Never silently delete a business decision that references a session. Inspect every live FK,
    // including future additions, before deleting any authentication row.
    for (const [schema,table,ids] of [
      ['zzsh_auth_admin','session',(await client.query('SELECT id FROM zzsh_auth_admin.session')).rows.map(row=>row.id)],
      ['zzsh_auth_admin','account',(await client.query('SELECT id FROM zzsh_auth_admin.account')).rows.map(row=>row.id)],
      ['zzsh_auth_admin','twoFactor',(await client.query('SELECT id FROM zzsh_auth_admin."twoFactor"')).rows.map(row=>row.id)],
      ['zzsh_auth_admin','verification',(await client.query('SELECT id FROM zzsh_auth_admin.verification')).rows.map(row=>row.id)],
      ['zzsh_iam','admin_security',actorIds],
      ...(request.snapshot?[
        ['zzsh_auth_user','session',request.snapshot.userSessions.map(row=>row.id)],
        ['zzsh_auth_user','verification',request.snapshot.userVerifications.map(row=>row.id)],
      ]:[]),
    ]) {
      const references=(await client.query(`SELECT n.nspname schema_name,r.relname table_name,
        array_agg(a.attname::text ORDER BY k.ordinality) columns FROM pg_constraint f JOIN pg_class r ON r.oid=f.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace JOIN LATERAL unnest(f.conkey) WITH ORDINALITY k(attnum,ordinality) ON true
        JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.attnum
        WHERE f.contype='f' AND f.confrelid=to_regclass($1) GROUP BY n.nspname,r.relname,f.oid`,[`${ident(schema)}.${ident(table)}`])).rows;
      for (const ref of references) {
        if (!Array.isArray(ref.columns) || ref.columns.length!==1) throw new Error('ADMIN_HANDOFF_CREDENTIAL_FK_UNSUPPORTED');
        const found=(await client.query(`SELECT count(*)::int n FROM ${ident(ref.schema_name)}.${ident(ref.table_name)} WHERE ${ident(ref.columns[0])}=ANY($1::text[])`,[ids])).rows[0].n;
        if (found) throw new Error(table==='admin_security'?'ADMIN_HANDOFF_SECURITY_REFERENCED':'ADMIN_HANDOFF_CREDENTIAL_REFERENCED');
      }
    }
    for(const name of ['zzsh_iam.admin_user_role','zzsh_iam.admin_user_permission','zzsh_supply.admin_supply_scope']) {
      const incoming=(await client.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND confrelid=to_regclass($1)",[name])).rows[0].n;
      if(incoming)throw new Error('ADMIN_HANDOFF_GRANT_FK_UNSUPPORTED');
    }
    await client.query("SELECT set_config('zzsh.actor_type','system',true),set_config('zzsh.request_id',$1,true)",[auditId]);
    await client.query(`UPDATE zzsh_iam.admin_recovery_request SET status='EXPIRED',recovery_token_hash=NULL
      WHERE target_admin_user_id=ANY($1::text[]) AND status IN ('PENDING','ISSUED')`,[actorIds]);
    await client.query('DELETE FROM zzsh_auth_admin.session WHERE "userId"=ANY($1::text[])',[actorIds]);
    await client.query('DELETE FROM zzsh_auth_admin."twoFactor" WHERE "userId"=ANY($1::text[])',[actorIds]);
    await client.query('DELETE FROM zzsh_auth_admin.account WHERE "userId"=ANY($1::text[])',[actorIds]);
    await client.query('DELETE FROM zzsh_iam.admin_user_role WHERE admin_user_id=ANY($1::text[])',[actorIds]);
    await client.query('DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id=ANY($1::text[])',[actorIds]);
    await client.query('DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=ANY($1::text[])',[actorIds]);
    await client.query('UPDATE zzsh_iam.admin_recovery_notification_target SET active=false WHERE admin_user_id=ANY($1::text[])',[actorIds]);
    if(request.snapshot){
      for(const row of request.snapshot.userSessions){const deleted=await client.query(`DELETE FROM zzsh_auth_user.session t WHERE id=$1 AND encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=$2`,[row.id,row.digest]);
        if(deleted.rowCount!==1)throw new Error('ADMIN_HANDOFF_USER_SESSION_CHANGED');}
      for(const row of request.snapshot.userVerifications){const deleted=await client.query(`DELETE FROM zzsh_auth_user.verification t WHERE id=$1 AND "expiresAt"<=clock_timestamp()
        AND identifier LIKE 'phone-registration:%' AND value ~ '^[0-9]{4}:[0-3]$' AND encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=$2`,[row.id,row.digest]);
        if(deleted.rowCount!==1)throw new Error('ADMIN_HANDOFF_USER_VERIFICATION_CHANGED');}
      if(canonical(await userAccountProof(client))!==canonical(request.snapshot.userAccounts))throw new Error('ADMIN_HANDOFF_USER_ACCOUNT_CHANGED');
    }
    const userUpdate=await client.query('UPDATE zzsh_auth_admin."user" SET suspended=true,"twoFactorEnabled"=false WHERE id=ANY($1::text[])',[actorIds]);
    const securityDelete=await client.query('DELETE FROM zzsh_iam.admin_security WHERE admin_user_id=ANY($1::text[])',[actorIds]);
    if (userUpdate.rowCount!==actors.length || securityDelete.rowCount!==actors.length || Object.values(await credentials()).some(value=>value!==0))
      throw new Error('ADMIN_HANDOFF_SANITIZED_STATE_UNPROVEN');
    await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
      VALUES($1,'system','admin.migration_identity.retired','admin_staging_handoff',$2,'SUCCESS',$1,$3,clock_timestamp(),$4::jsonb)`,
      [auditId,digest,'交付副本停用本轮迁移执行身份；保留原身份、首次激活事实、外键及审计。',JSON.stringify({handoffDigest:digest,sourceDatasetSha256:request.sourceDatasetSha256,approvalRef:request.approvalRef,actors,activation,grants,
        ...(request.snapshot?{snapshotDigest:request.snapshotDigest,userSessionsRetired:request.snapshot.userSessions.length,userVerificationsRetired:request.snapshot.userVerifications.length}: {})})]);
    activeWindow();await databaseWindow();if(typeof options.beforeCommit==='function')await options.beforeCommit();activeWindow();await databaseWindow();commitSent=true;if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('ADMIN_HANDOFF_COMMIT_ACK_INVALID');begun=false;
    return {status:'STAGING_IDENTITIES_RETIRED',handoffDigest:digest,actors:actors.length,userSessions:request.snapshot?.userSessions.length??0,userVerifications:request.snapshot?.userVerifications.length??0};
  } catch (error) {
    if (commitSent) throw Object.assign(new Error('ADMIN_HANDOFF_COMMIT_UNKNOWN'),{cause:error,handoffDigest:digest});
    if (begun) try { await client.query('ROLLBACK'); } catch (rollback) { throw Object.assign(new Error('ADMIN_HANDOFF_ROLLBACK_UNKNOWN'),{cause:rollback,handoffDigest:digest}); }
    throw error;
  }
}

/** A missing or inconsistent original audit/state remains UNKNOWN; this never replays a write. */
export async function recoverDeliveryHandoff(client,request) {
  const t=request?.target,clone=t?.marker==='zzsh:r07-delivery-clone:v1',synthetic=t?.marker==='zzsh:r08-auth-handoff:v1';
  if(request?.schema!=='zzsh.admin-staging-handoff.v1'||!clone&&!synthetic
    ||clone&&(t.database!=='zzsh_test_r07_delivery_20261108'||t.oid!=='16391'||t.systemIdentifier!=='7705473419326033954'
      ||t.role!=='zzsh_regression_migration'||t.roleOid!=='16389'||t.owner!=='zzsh'||t.ownerOid!=='16388'||t.nonce!=='62ca9c4e419e1039f500ac1e'||t.host!=='127.0.0.1'||t.port!==55434)
    ||synthetic&&(!/^zzsh_test_[a-z0-9_]{1,48}$/.test(t.database??'')||t.database==='zzsh_test_regression')
    ||!request.snapshot||hash(canonical(request.snapshot))!==request.snapshotDigest||canonical(request.snapshot.actors)!==canonical(request.actors))
    throw new Error('ADMIN_HANDOFF_RECOVERY_INPUT_INVALID');
  const identity=(await client.query(`SELECT current_database() database,d.oid::text oid,shobj_description(d.oid,'pg_database') marker,
    current_user role,r.oid::text role_oid,r.rolsuper,pg_get_userbyid(d.datdba) owner,d.datdba::text owner_oid,current_setting('zzsh.regression_run',true) nonce,
    current_setting('transaction_read_only') ro,(SELECT system_identifier::text FROM pg_control_system()) system_identifier
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if(!identity||identity.database!==t.database||identity.oid!==t.oid||identity.marker!==t.marker||identity.role!==t.role||identity.rolsuper
    ||clone&&(identity.owner!==t.owner||identity.owner_oid!==t.ownerOid||identity.nonce!==t.nonce||identity.role_oid!==t.roleOid)
    ||identity.system_identifier!==t.systemIdentifier||identity.ro!=='on')throw new Error('ADMIN_HANDOFF_RECOVERY_TARGET_MISMATCH');
  const digest=deliveryHandoffDigest(request),auditId='audit_'+digest.slice(0,32),audit=(await client.query('SELECT action,details FROM zzsh_iam.audit_event WHERE id=$1',[auditId])).rows[0];
  if(!audit)return{knowledge:'UNKNOWN'};
  const d=audit.details;if(audit.action!=='admin.migration_identity.retired'||d?.handoffDigest!==digest||d.snapshotDigest!==request.snapshotDigest
    ||d.sourceDatasetSha256!==request.sourceDatasetSha256||d.approvalRef!==request.approvalRef||canonical(d.actors)!==canonical(request.actors)
    ||d.userSessionsRetired!==request.snapshot.userSessions.length||d.userVerificationsRetired!==request.snapshot.userVerifications.length)throw new Error('ADMIN_HANDOFF_RECOVERY_AUDIT_DIFFERS');
  const ids=request.actors.map(a=>a.id),state=(await client.query(`SELECT
    (SELECT count(*)::int FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id WHERE u.id=ANY($1::text[]) AND u.suspended AND NOT u."twoFactorEnabled" AND s.admin_user_id IS NULL) retired,
    (SELECT count(*)::int FROM zzsh_auth_admin.account WHERE "userId"=ANY($1::text[])) accounts,
    (SELECT count(*)::int FROM zzsh_auth_admin."twoFactor" WHERE "userId"=ANY($1::text[])) factors,
    (SELECT count(*)::int FROM zzsh_auth_admin.session WHERE "userId"=ANY($1::text[])) sessions,
    (SELECT count(*)::int FROM zzsh_iam.admin_user_role WHERE admin_user_id=ANY($1::text[])) roles,
    (SELECT count(*)::int FROM zzsh_iam.admin_user_permission WHERE admin_user_id=ANY($1::text[])) permissions,
    (SELECT count(*)::int FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=ANY($1::text[])) scopes,
    (SELECT count(*)::int FROM zzsh_iam.admin_recovery_request WHERE target_admin_user_id=ANY($1::text[]) AND recovery_token_hash IS NOT NULL) recovery,
    (SELECT count(*)::int FROM zzsh_iam.admin_recovery_notification_target WHERE admin_user_id=ANY($1::text[]) AND active) notifications,
    (SELECT count(*)::int FROM zzsh_auth_admin.verification) admin_verifications,
    (SELECT count(*)::int FROM zzsh_auth_user.session) user_sessions,
    (SELECT count(*)::int FROM zzsh_auth_user.verification) user_verifications`,[ids])).rows[0];
  if(state.retired!==ids.length||Object.entries(state).some(([key,value])=>key!=='retired'&&value!==0)
    ||canonical(await userAccountProof(client))!==canonical(request.snapshot.userAccounts))throw new Error('ADMIN_HANDOFF_RECOVERY_STATE_DIFFERS');
  return{knowledge:'KNOWN',handoffDigest:digest,actors:ids.length,userSessions:request.snapshot.userSessions.length,userVerifications:request.snapshot.userVerifications.length};
}
