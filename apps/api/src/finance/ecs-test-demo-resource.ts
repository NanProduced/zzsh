import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { ConfigurationError, type AppConfig } from "../config/config";
import { assertBusinessRuntimeIdentity } from "../database/business";
import { canonicalize } from "../supply/content-hash";
import { conflict, notFound } from "../supply/supply-util";

export type EcsTestDemoResource = Readonly<{ kind: "ECS_TEST_DEMO_FINANCE" }>;
export type LocalDemoCloneResource = Readonly<{ kind: "LOCAL_DEMO_CLONE_FINANCE" }>;
export type DemoFinanceResource = EcsTestDemoResource | LocalDemoCloneResource;
export type LocalDemoCloneProof = Readonly<{ kind: "VERIFIED_R07_DEMO_CLONE" }>;
export type DemoOrigins = Readonly<{ apiOrigin: string; userOrigin: string; adminOrigin: string; secureCookies: boolean }>;
export type DemoResourceBinding = Readonly<{
  database: string; databaseOid: number; systemIdentifier: string; marker: string;
  owner: string; ownerOid: number; migrationRole: string; migrationRoleOid: number; runtimeRole: string; runtimeRoleOid: number;
}>;
type Registration = Readonly<{
  schema: "ecs-test-demo-finance.v1" | "local-demo-clone-finance.v1"; reference: string; sourceSnapshotSha256: string;
  restoreReceiptSha256: string; administratorId: string; resource: DemoResourceBinding; origins: DemoOrigins; nonce?: string;
}>;
type CloneReceipt = Readonly<{ receiptSha256:string; sourceSnapshotSha256:string; resource:DemoResourceBinding; nonce:string }>;
const scopes = new WeakMap<DemoFinanceResource, { registration: Registration; canonical: string; digest: string }>();
const cloneProofs = new WeakMap<LocalDemoCloneProof, CloneReceipt>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value);
const oid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
const receiptOid = (value: unknown): number | undefined => typeof value==='string' && /^[1-9]\d{0,9}$/.test(value) && oid(Number(value)) ? Number(value) : undefined;
const origin = (value: string) => { try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password; } catch { return false; } };
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "测试支付资源未就绪");
const joinpayFlags = ["JOINPAY_COLLECTION_ENABLED", "JOINPAY_REFUND_ENABLED", "JOINPAY_PAYOUT_ENABLED", "JOINPAY_ACCOUNTS_ENABLED"] as const;

/** An opt-in test capability; it contains no provider client and never authorizes JoinPay. */
export function createEcsTestDemoResource(input: {
  config: Pick<AppConfig, "profile" | "provider" | "testOperationsEnabled" | "database">;
  env: NodeJS.ProcessEnv; origins: DemoOrigins; reference: string;
  sourceSnapshotSha256: string; restoreReceiptSha256: string; administratorId: string; resource: DemoResourceBinding;
}): EcsTestDemoResource | undefined {
  const { config, env } = input;
  // The registration is persisted. Never copy unspecified configuration or credential fields.
  const resource: DemoResourceBinding = Object.freeze({ database: input.resource.database,
    databaseOid: input.resource.databaseOid, systemIdentifier: input.resource.systemIdentifier,
    marker: input.resource.marker, owner: input.resource.owner, ownerOid: input.resource.ownerOid,
    migrationRole: input.resource.migrationRole, migrationRoleOid: input.resource.migrationRoleOid,
    runtimeRole: input.resource.runtimeRole, runtimeRoleOid: input.resource.runtimeRoleOid });
  const origins: DemoOrigins = Object.freeze({ apiOrigin: input.origins.apiOrigin,
    userOrigin: input.origins.userOrigin, adminOrigin: input.origins.adminOrigin,
    secureCookies: input.origins.secureCookies });
  const enabled = env.ECS_TEST_DEMO_FINANCE_ENABLED ?? "false";
  if (enabled === "false") return undefined;
  if (enabled !== "true" || env.APP_PROFILE !== "ecs-test" || env.NODE_ENV !== "production"
    || env.LOCAL_DEMO_CLONE_FINANCE_ENABLED === "true"
    || config.profile !== "ecs-test" || config.provider !== "real" || config.testOperationsEnabled
    || joinpayFlags.some(key => env[key] !== "false")
    || config.database.target !== "ecs-test" || config.database.targetProfile !== "ecs-test"
    || config.database.user !== config.database.runtimeUser || config.database.ssl?.rejectUnauthorized !== true
    || !/^zzsh_ecs_test(?:_[a-z0-9_]{1,32})?$/.test(config.database.name)
    || resource.database !== config.database.name || resource.runtimeRole !== config.database.runtimeUser
    || ![resource.owner, resource.migrationRole, resource.runtimeRole].every(id) || new Set([resource.owner, resource.migrationRole, resource.runtimeRole]).size!==3
    || ![resource.databaseOid, resource.ownerOid, resource.migrationRoleOid, resource.runtimeRoleOid].every(oid)
    || new Set([resource.ownerOid,resource.migrationRoleOid,resource.runtimeRoleOid]).size!==3 || !/^[1-9]\d{0,19}$/.test(resource.systemIdentifier)
    || resource.marker !== "zzsh:ecs-test:v1"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.reference)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.administratorId)
    || ![input.sourceSnapshotSha256, input.restoreReceiptSha256].every(value => /^[a-f0-9]{64}$/.test(value))
    || origins.secureCookies !== true || ![origins.apiOrigin, origins.userOrigin, origins.adminOrigin].every(origin)
    || new Set([origins.apiOrigin, origins.userOrigin, origins.adminOrigin]).size !== 3) {
    throw new ConfigurationError("ECS_TEST_DEMO_FINANCE_CONTEXT_INVALID");
  }
  const registration: Registration = Object.freeze({ schema: "ecs-test-demo-finance.v1", reference: input.reference,
    sourceSnapshotSha256: input.sourceSnapshotSha256, restoreReceiptSha256: input.restoreReceiptSha256, administratorId: input.administratorId,
    resource, origins });
  const canonical = canonicalize(registration), scope = Object.freeze({ kind: "ECS_TEST_DEMO_FINANCE" as const });
  scopes.set(scope, Object.freeze({ registration, canonical, digest: hash(canonical) }));
  return scope;
}

/** Parse only an independently pinned completed clone receipt; it grants no provider authority. */
export function verifyLocalDemoCloneProof(bytes:Uint8Array,expectedSha256:string):LocalDemoCloneProof {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength>131072 || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || createHash('sha256').update(bytes).digest('hex')!==expectedSha256) throw new ConfigurationError('LOCAL_DEMO_CLONE_RECEIPT_INVALID');
  let doc:Record<string,any>;try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ConfigurationError('LOCAL_DEMO_CLONE_RECEIPT_INVALID');}
  const source=doc?.source,target=doc?.target;
  const v=doc?.verification,exceptions=Array.isArray(v?.intentionalExceptions)?v.intentionalExceptions:[];
  if(doc?.schema!=='zzsh.r07-demo-clone-restored.v1' || doc.status!=='RESTORED_AND_VERIFIED'
    || v?.sameExportedSnapshot!==true || v?.dataSummaryMatched!==true || v?.keySetsMatched!==true || v?.objectAclMatched!==true
    || v?.roleSecurityMatchedWithDeclaredExceptions!==true || v?.rlsAndDefinerMatched!==true || v?.runtimeAccessTested!==true || v?.sourceWrites!==0
    || exceptions.length!==2 || !exceptions.some((item:any)=>item?.code==='OWNER_DEPRIVILEGED'&&item?.role==='zzsh')
    || !exceptions.some((item:any)=>item?.code==='DATABASE_EPOCH_CHANGED')
    || source?.database!=='zzsh_test_regression' || source?.marker!=='zzsh:regression-test:v1' || !receiptOid(source?.oid)
    || !/^[1-9]\d{0,19}$/.test(source?.systemIdentifier??'') || !/^[a-f0-9]{64}$/.test(source?.archiveSha256??'')
    || !/^[a-f0-9]{64}$/.test(source?.aclSha256??'')
    || target?.host!=='127.0.0.1' || target?.port!==55434 || target?.database!=='zzsh_test_r07_delivery_20261108'
    || target?.marker!=='zzsh:r07-delivery-clone:v1' || !receiptOid(target?.oid) || !/^[1-9]\d{0,19}$/.test(target?.systemIdentifier??'')
    || target.systemIdentifier===source.systemIdentifier
    || !/^[a-z0-9_]{12,64}$/.test(target?.nonce??'') || ![target?.owner?.name,target?.migration?.name,target?.runtime?.name].every(id)
    || target.owner.name!=='zzsh' || target.migration.name!=='zzsh_regression_migration' || target.runtime.name!=='zzsh_regression_runtime'
    || ![target?.owner?.oid,target?.migration?.oid,target?.runtime?.oid].every(value=>receiptOid(value)!==undefined)
    || target.runtime.name===target.owner.name || target.runtime.name===target.migration.name
    || target.runtime.oid===target.owner.oid || target.runtime.oid===target.migration.oid)
    throw new ConfigurationError('LOCAL_DEMO_CLONE_RECEIPT_INVALID');
  const resource=Object.freeze({database:target.database,databaseOid:receiptOid(target.oid)!,systemIdentifier:target.systemIdentifier,marker:target.marker,
    owner:target.owner.name,ownerOid:receiptOid(target.owner.oid)!,migrationRole:target.migration.name,migrationRoleOid:receiptOid(target.migration.oid)!,
    runtimeRole:target.runtime.name,runtimeRoleOid:receiptOid(target.runtime.oid)!});
  const proof=Object.freeze({kind:'VERIFIED_R07_DEMO_CLONE' as const});
  cloneProofs.set(proof,Object.freeze({receiptSha256:expectedSha256,sourceSnapshotSha256:source.archiveSha256,resource,nonce:target.nonce}));return proof;
}

/** Separate loopback-only capability for validating the registered R07 clone; ECS rules stay unchanged. */
export function createLocalDemoCloneResource(input:{config:AppConfig;env:NodeJS.ProcessEnv;origins:DemoOrigins;proof:LocalDemoCloneProof;reference:string;administratorId:string}):LocalDemoCloneResource {
  const clone=cloneProofs.get(input.proof),{config,env}=input,origins=Object.freeze({apiOrigin:input.origins.apiOrigin,userOrigin:input.origins.userOrigin,
    adminOrigin:input.origins.adminOrigin,secureCookies:input.origins.secureCookies});
  if(!clone || env.LOCAL_DEMO_CLONE_FINANCE_ENABLED!=='true' || env.ECS_TEST_DEMO_FINANCE_ENABLED==='true'
    || env.APP_PROFILE!=='dev' || env.NODE_ENV!=='development' || joinpayFlags.some(key=>env[key]!=='false')
    || config.profile!=='dev' || config.provider!=='fake' || config.testOperationsEnabled || config.host!=='127.0.0.1' || config.port!==4232
    || config.database.target!=='local-compose' || config.database.targetProfile!=='dev' || config.database.host!=='127.0.0.1' || config.database.port!==55434
    || config.database.name!==clone.resource.database || config.database.user!==clone.resource.runtimeRole || config.database.runtimeUser!==clone.resource.runtimeRole
    || config.database.ssl!==undefined || origins.apiOrigin!=='http://127.0.0.1:4232' || origins.userOrigin!=='http://127.0.0.1:4230'
    || origins.adminOrigin!=='http://127.0.0.1:4231' || origins.secureCookies!==false
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.reference) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.administratorId))
    throw new ConfigurationError('LOCAL_DEMO_CLONE_CONTEXT_INVALID');
  const registration:Registration=Object.freeze({schema:'local-demo-clone-finance.v1',reference:input.reference,
    sourceSnapshotSha256:clone.sourceSnapshotSha256,restoreReceiptSha256:clone.receiptSha256,administratorId:input.administratorId,
    resource:clone.resource,origins,nonce:clone.nonce});
  const canonical=canonicalize(registration),scope=Object.freeze({kind:'LOCAL_DEMO_CLONE_FINANCE' as const});
  scopes.set(scope,Object.freeze({registration,canonical,digest:hash(canonical)}));return scope;
}

export function readEcsTestDemoRegistration(scope: DemoFinanceResource) {
  const registered = scopes.get(scope);
  if (!registered) throw unavailable();
  return registered;
}

/** The actual cloned database must have its own owner-enrolled registration after restore. */
export async function assertEcsTestDemoResource(client: PoolClient, scope: DemoFinanceResource, mode: "WRITE" | "READ_ORIGINAL" = "WRITE") {
  if (mode !== "WRITE" && mode !== "READ_ORIGINAL") throw unavailable();
  const proof = readEcsTestDemoRegistration(scope), expected = proof.registration.resource;
  try {
    if(proof.registration.schema==='local-demo-clone-finance.v1'){
      const connection=(client as PoolClient&{connectionParameters?:{host?:string;port?:number;database?:string;user?:string}}).connectionParameters;
      if(client.getTransactionStatus()!=='T'||!connection||connection.host!=='127.0.0.1'||Number(connection.port)!==55434
        ||connection.database!==expected.database||connection.user!==expected.runtimeRole)throw unavailable();
    }
    await client.query("SELECT set_config('max_parallel_workers_per_gather','0',true),set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true)");
    await assertBusinessRuntimeIdentity(client, { database: { name: expected.database, user: expected.runtimeRole, runtimeUser: expected.runtimeRole } });
    const row = (await client.query(`SELECT current_database() AS database,d.oid::text AS database_oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,shobj_description(d.oid,'pg_database') AS marker,
      pg_get_userbyid(d.datdba) AS owner,d.datdba::text AS owner_oid,current_user AS runtime_role,r.oid::text AS runtime_role_oid,
      own.rolsuper AS owner_super,own.rolbypassrls AS owner_bypass,own.rolcreatedb AS owner_createdb,
      own.rolcreaterole AS owner_createrole,own.rolreplication AS owner_replication,own.rolcanlogin AS owner_login,
      r.rolsuper,r.rolbypassrls,current_setting('zzsh.regression_run',true) AS clone_nonce,
      m.oid::text AS migration_role_oid,m.rolsuper AS migration_super,m.rolbypassrls AS migration_bypass,
      m.rolcreaterole AS migration_createrole,m.rolcreatedb AS migration_createdb,m.rolreplication AS migration_replication,m.rolcanlogin AS migration_login,
      (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='zzsh_order') AS schema_owner,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname IN
        ('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')) AS runtime_owns_business_routine,
      s.canonical_registration,s.registration_digest,s.active${mode === "WRITE" ? ",pg_current_xact_id()::text AS demo_xid" : ""}
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user JOIN pg_roles own ON own.oid=d.datdba LEFT JOIN pg_roles m ON m.rolname=$2
      LEFT JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=$1 WHERE d.datname=current_database()`,
    [proof.registration.reference,expected.migrationRole])).rows[0];
    if (!row || row.database !== expected.database || Number(row.database_oid) !== expected.databaseOid
      || row.system_identifier !== expected.systemIdentifier || row.marker !== expected.marker
      || row.owner !== expected.owner || Number(row.owner_oid) !== expected.ownerOid
      || row.owner_super!==false || row.owner_bypass!==false || row.owner_createrole!==false || row.owner_createdb!==false
      || row.owner_replication!==false || row.owner_login!==false
      || Number(row.migration_role_oid)!==expected.migrationRoleOid || row.schema_owner!==expected.migrationRole
      || row.migration_super!==false || row.migration_bypass!==false || row.migration_createrole!==false || row.migration_createdb!==false || row.migration_replication!==false
      || row.runtime_role !== expected.runtimeRole || Number(row.runtime_role_oid) !== expected.runtimeRoleOid
      || row.rolsuper !== false || row.rolbypassrls !== false || row.runtime_owns_business_routine !== false || row.canonical_registration !== proof.canonical
      || row.registration_digest !== proof.digest || typeof row.active !== "boolean" || mode === "WRITE" && row.active !== true
      || proof.registration.schema==='local-demo-clone-finance.v1' && row.clone_nonce!==proof.registration.nonce) throw unavailable();
    if (mode === "WRITE") {
      const locked = (await client.query(`SELECT canonical_registration,registration_digest,active,pg_current_xact_id()::text AS demo_xid
        FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=$1 FOR SHARE`, [proof.registration.reference])).rows[0];
      if (!locked || locked.active !== true || locked.canonical_registration !== proof.canonical || locked.registration_digest !== proof.digest
        || typeof row.demo_xid !== "string" || !/^[1-9][0-9]*$/.test(row.demo_xid) || locked.demo_xid !== row.demo_xid) throw unavailable();
    }
    return Object.freeze({ ...proof.registration, active: row.active });
  } catch (error) {
    if (error instanceof SecurityApiError) throw error;
    throw Object.assign(unavailable(), { cause: error });
  }
}

export function assertEcsTestDemoAssembly(scope: DemoFinanceResource, options: DemoOrigins & {
  joinpayCollection?: unknown; joinpayRefund?: unknown; joinpayWithdrawal?: unknown; joinpayAccountObservation?: unknown;
}) {
  const { origins } = readEcsTestDemoRegistration(scope).registration;
  if (options.joinpayCollection || options.joinpayRefund || options.joinpayWithdrawal || options.joinpayAccountObservation
    || options.secureCookies !== origins.secureCookies || (["apiOrigin", "userOrigin", "adminOrigin"] as const).some(key => options[key] !== origins[key]))
    throw new ConfigurationError("ECS_TEST_DEMO_FINANCE_ASSEMBLY_MISMATCH");
}

/** Only a new order created by its payer after enrollment can acquire a demo-money admission. */
export async function ensureEcsTestDemoOrderAdmission(client: PoolClient, scope: DemoFinanceResource, orderId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(orderId)) throw notFound();
  const proof = readEcsTestDemoRegistration(scope), reg = await assertEcsTestDemoResource(client, scope), r = reg.resource;
  const find = () => client.query(`SELECT id,mode,resource_oid,resource_name,resource_marker,approval_digest,active
    FROM zzsh_order.distribution_order_admission WHERE order_id=$1`, [orderId]);
  const exact = (row: Record<string, unknown> | undefined) => row?.mode === "LOCAL_CONTROLLED" && Number(row.resource_oid) === r.databaseOid
    && row.resource_name === r.database && row.resource_marker === r.marker && row.approval_digest === proof.digest && row.active === true;
  const existing = (await find()).rows[0];
  if (existing) { if (!exact(existing)) throw conflict("Order belongs to another payment source"); return existing.id as string; }
  const audits = (await client.query(`SELECT a.id FROM zzsh_order.rental_order o
    JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=$2 AND s.active
    JOIN zzsh_iam.audit_event a ON a.object_id=o.id AND a.object_type='rental_order' AND a.action='order.reservation.created'
      AND a.actor_type='user' AND a.actor_id=o.renter_user_id AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at
    WHERE o.id=$1 AND o.status='PENDING_PAYMENT' AND o.paid_confirmation_id IS NULL AND o.created_at>=s.registered_at
    ORDER BY a.id LIMIT 2`, [orderId, reg.reference])).rows;
  if (audits.length !== 1) throw unavailable();
  const id = "demo_order_" + hash(proof.digest + ":" + orderId).slice(0, 40);
  await client.query(`INSERT INTO zzsh_order.distribution_order_admission(id,order_id,mode,resource_oid,resource_name,resource_marker,
    approval_digest,native_creation_audit_id,revision,active,admitted_at,expires_at,created_by_admin_id,reason)
    VALUES($1,$2,'LOCAL_CONTROLLED',$3,$4,$5,$6,$7,1,true,clock_timestamp(),'infinity'::timestamptz,$8,'ECS test simulation; no real provider')
    ON CONFLICT(order_id) DO NOTHING`, [id, orderId, r.databaseOid, r.database, r.marker, proof.digest, audits[0].id, reg.administratorId]);
  const actual = (await find()).rows[0];
  if (!exact(actual)) throw conflict("Concurrent order admission belongs to another payment source");
  return actual.id as string;
}

export async function assertEcsTestDemoOrderAdmission(client: PoolClient, scope: DemoFinanceResource, orderId: string) {
  const proof = readEcsTestDemoRegistration(scope), { resource } = await assertEcsTestDemoResource(client, scope);
  const row = (await client.query(`SELECT id FROM zzsh_order.distribution_order_admission WHERE order_id=$1 AND mode='LOCAL_CONTROLLED'
    AND resource_oid=$2 AND resource_name=$3 AND resource_marker=$4 AND approval_digest=$5 AND active
    AND admitted_at<=clock_timestamp() AND expires_at>clock_timestamp()`,
  [orderId, resource.databaseOid, resource.database, resource.marker, proof.digest])).rows[0];
  if (!row) throw unavailable();
  return row.id as string;
}

export function demoFinanceScope(scope:DemoFinanceResource) {
  return readEcsTestDemoRegistration(scope).registration.schema==='ecs-test-demo-finance.v1'?'ECS_TEST_SIMULATED' as const:'LOCAL_DEMO_SIMULATED' as const;
}
export function ecsTestDemoPaymentAnchor(scope: DemoFinanceResource, orderId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(orderId)) throw notFound();
  const digest = readEcsTestDemoRegistration(scope).digest, anchor = hash(digest + ":" + orderId).slice(0, 40);
  return Object.freeze({ declarationId: "demo_decl_" + anchor, providerTransactionId: "demo_pay_" + anchor,
    requestId: "demo_payment_" + anchor, merchantScopeId: (scope.kind==='ECS_TEST_DEMO_FINANCE'?'ecs_demo_':'local_demo_') + digest.slice(0, 32) });
}
