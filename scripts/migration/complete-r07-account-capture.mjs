import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writePrivate } from "../local-auth.mjs";
import { readSourceRows } from "./local-source-adapter.mjs";
import { assertLiveTarget, loadRegisteredTarget, targetIdentityQuery } from "./local-target-registry.mjs";
import { writeLoadCheckpoint } from "./local-load-checkpoint.mjs";

const root=resolve(fileURLToPath(new URL("../..",import.meta.url))),restricted=resolve("E:/zzsh-local-state/restricted");
const hex=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x),sha=x=>createHash("sha256").update(x).digest("hex");
const oldSystem="7704972584346443810", marker="zzsh:r07-delivery-clone:v1";
function safeErrorCode(error){const first=String(error?.message??"").split(/\r?\n/,1)[0].trim();
  return /^[A-Z][A-Z0-9_]+$/.test(first)?first:error?.code??error?.name??"CAPTURE_FAILED";}
function privatePath(value,output=false){
  assert(typeof value==="string"&&isAbsolute(value),"CAPTURE_PRIVATE_PATH_REQUIRED");const p=resolve(value),r=relative(restricted,p);
  assert(r&&!r.startsWith("..")&&!isAbsolute(r),"CAPTURE_PRIVATE_PATH_REQUIRED");
  for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),"CAPTURE_LINK_REFUSED");return p;
}
function pinned(ref){const path=privatePath(ref?.path),bytes=readFileSync(path);assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,"CAPTURE_INPUT_CHANGED");return JSON.parse(bytes);}
async function sourceFile(dir,entry){
  assert(entry&&entry.file===basename(entry.file)&&hex(entry.sha256),"CAPTURE_SOURCE_FILE_INVALID");
  const path=privatePath(join(dir,entry.file)),h=createHash("sha256");for await(const b of createReadStream(path))h.update(b);
  assert.equal(h.digest("hex"),entry.sha256,"CAPTURE_SOURCE_FILE_CHANGED");return path;
}
export function assertCaptureAuthority(authority,plan,planSha,now=Date.now()){
  const start=Date.parse(authority?.notBefore),end=Date.parse(authority?.expiresAt);
  assert(authority?.schema==="zzsh.r07-capture-fact-authority.v1"&&authority.status==="APPROVED"
    &&authority.operation==="APPEND_SOURCE_BOUND_ACCOUNT_CAPTURE"&&authority.planSha256===planSha
    &&JSON.stringify(authority.target)===JSON.stringify(plan.target)&&authority.maxAccounts===plan.facts.length
    &&authority.allowFinancialWrites===false&&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.approvalRef??"")
    &&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.attempt??"")&&Number.isFinite(start)&&Number.isFinite(end)
    &&start<=now&&now<end&&end>start&&end-start<=30*60_000,"CAPTURE_AUTHORITY_CHANGED");
}
export function assertCaptureCloneBinding(target,credentials,actor,datasetSha256){
  assert(target.instance&&typeof target.instance.systemIdentifier==="string"&&/^[0-9]+$/.test(target.instance.systemIdentifier)
    &&target.instance.systemIdentifier!==oldSystem&&target.marker===marker&&!target.pendingReset&&hex(datasetSha256)
    &&target.owner&&target.migrationRoleOid&&target.runtimeRoleOid&&target.protectedDataset?.manifestSha256===datasetSha256
    &&credentials.migration?.name===target.migrationRole&&credentials.migration?.oid===target.migrationRoleOid
    &&actor.realm==="admin"&&actor.resourceOid===target.oid&&actor.nonce===target.nonce
    &&/^[A-Za-z0-9._:-]{1,128}$/.test(actor.id??"")&&/^[A-Za-z0-9._:-]{1,128}$/.test(actor.sessionId??""),
    "CAPTURE_CLONE_BINDING_REQUIRED");
}
function filesProof(){
  const files=["scripts/migration/complete-r07-account-capture.mjs","scripts/migration/local-source-adapter.mjs",
    "scripts/migration/local-target-registry.mjs","scripts/migration/local-load-checkpoint.mjs","scripts/local-auth.mjs",
    "apps/api/migrations/business/0174_business_schema_comments.sql","apps/api/migrations/business/0175_legacy_account_capture_facts.sql","apps/api/migrations/business/meta/_journal.json",
    "package-lock.json","node_modules/.package-lock.json"];
  for(const p of Object.keys(require.cache)){
    const local=p.toLowerCase().startsWith(root.toLowerCase()+"\\")||p.startsWith(root+"/");
    assert(local,"CAPTURE_DEPENDENCY_OUTSIDE_BOUND_BUILD");files.push(relative(root,p));
    if(p.toLowerCase().includes("node_modules")){let dir=dirname(p);while(dir.toLowerCase().startsWith(root.toLowerCase())){
      const pkg=join(dir,"package.json");if(existsSync(pkg)){files.push(relative(root,pkg));break;}const parent=dirname(dir);if(parent===dir)break;dir=parent;
    }}
  }
  return Object.fromEntries([...new Set(files)].sort().map(p=>[p.replaceAll("\\","/"),sha(readFileSync(join(root,p)))]));
}
function bindingOf(target){return{instance:target.instance,oid:target.oid,nonce:target.nonce,database:target.database,marker:target.marker,
  owner:target.owner,migrationRole:target.migrationRole,migrationRoleOid:target.migrationRoleOid,runtimeRole:target.runtimeRole,lockKey:target.lockKey};}
const require=createRequire(import.meta.url);
async function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const modes=["--prepare","--execute","--readback"].filter(x=>args.includes(x));
  if(!modes.length){console.log(JSON.stringify({status:"PLAN_ONLY",connections:0,targetWrites:0}));return;}
  assert.equal(modes.length,1,"CAPTURE_MODE_INVALID");assert.equal(process.version,"v24.20.0","CAPTURE_NODE_VERSION_CHANGED");
  const mode=modes[0],out=privatePath(option("--out"),true);assert(!existsSync(out),"CAPTURE_OUTPUT_EXISTS");
  const inputRef={path:privatePath(option("--input")),sha256:option("--input-sha")},input=pinned(inputRef);
  assert(input.schema==="zzsh.r07-capture-fact-input.v1","CAPTURE_INPUT_INVALID");
  const receipt=pinned(input.sourceReceipt),dataset=pinned(input.datasetManifest),credentialsPath=privatePath(input.credentialsPath);
  const credentialsBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialsBytes),resourcePath=privatePath(join(dirname(credentialsPath),"resource.json"));
  const credentialSha256=sha(credentialsBytes),resourceSha256=sha(readFileSync(resourcePath));
  const target=loadRegisteredTarget(credentialsPath),actorFile=pinned(input.actor),targetBinding=bindingOf(target);
  assertCaptureCloneBinding(target,credentials,actorFile,input.datasetManifest.sha256);
  assert(receipt.status==="CAPTURED_READ_ONLY"&&receipt.rollbackConfirmed&&receipt.clientClosed
    &&dataset.schema==="zzsh.local-legacy-dataset.v1"&&dataset.status==="FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN"
    &&dataset.sourceReceiptSha256===input.sourceReceipt.sha256
    &&resolve(dataset.source).toLowerCase()===resolve(dirname(input.sourceReceipt.path)).toLowerCase(),"CAPTURE_SOURCE_BINDING_CHANGED");
  const sourcePath=await sourceFile(dirname(input.sourceReceipt.path),receipt.files.accounts),datasetPath=await sourceFile(dirname(input.datasetManifest.path),dataset.files.accounts);
  const {Client}=require("pg"),factModule=require(join(root,"apps/api/dist/src/supply/legacy-account-capture-fact.js"));
  const writer=require(join(root,"apps/api/dist/src/supply/legacy-account-capture-maintenance.js")),{canonicalize}=require(join(root,"apps/api/dist/src/supply/content-hash.js"));
  const {fingerprintRequest}=require(join(root,"apps/api/dist/src/supply/supply-util.js"));
  const proof=filesProof(),verifyFiles=()=>{assert.deepEqual(filesProof(),proof,"CAPTURE_TOOL_CHANGED");pinned(inputRef);pinned(input.sourceReceipt);
    pinned(input.datasetManifest);pinned(input.actor);assert(sha(readFileSync(credentialsPath))===credentialSha256
      &&sha(readFileSync(resourcePath))===resourceSha256,"CAPTURE_RESOURCE_FILE_CHANGED");};
  const planRef=mode==="--prepare"?null:{path:privatePath(option("--plan")),sha256:option("--plan-sha")},plan=planRef?pinned(planRef):null;
  const authority=mode==="--execute"?pinned({path:option("--authority"),sha256:option("--authority-sha")}):null;
  const common={host:target.host,port:target.port,user:credentials.migration.name,password:credentials.migration.password,
    statement_timeout:30000,lock_timeout:1000,connectionTimeoutMillis:3000};
  const client=new Client({...common,database:target.database,application_name:"r07-account-capture"});
  const lock=new Client({...common,database:target.maintenanceDatabase,application_name:"r07-account-capture-lock"});
  let held=false,begun=false,commitSent=false,commitAck=false,rollbackAck=false,closed=false,lockClosed=false,unlockAck=false;
  let result={schema:"zzsh.r07-capture-fact-receipt.v1",status:"STARTED",mode,target:targetBinding,startedAt:new Date().toISOString(),financialWrites:0};
  if(mode==="--execute")writePrivate(join(out,"receipt.json"),result);
  const save=()=>writeLoadCheckpoint(join(out,"receipt.json"),result);
  try{
    await lock.connect();held=(await lock.query("SELECT pg_try_advisory_lock($1::bigint) AS ok",[target.lockKey])).rows[0]?.ok===true;assert(held,"CAPTURE_LOCK_BUSY");
    await client.connect();await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");begun=true;
    const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,identity,"migration");assert.equal(identity.read_only,"on");
    const journal=(await client.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations WHERE created_at=ANY($1::bigint[])',[["1793730640495","1793730640496"]])).rows;
    assert(journal.length===2&&journal.some(r=>r.createdAt==="1793730640495"&&r.hash===proof["apps/api/migrations/business/0174_business_schema_comments.sql"])
      &&journal.some(r=>r.createdAt==="1793730640496"&&r.hash===proof["apps/api/migrations/business/0175_legacy_account_capture_facts.sql"]),"CAPTURE_MIGRATION_JOURNAL_CHANGED");
    const schema=(await client.query(`SELECT to_regclass('zzsh_supply.legacy_listing_capture_fact') IS NOT NULL AS ready,
      (SELECT count(*)::integer FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND NOT t.tgisinternal
        AND t.tgenabled IN ('O','A') AND ((t.tgname='legacy_capture_insert' AND t.tgfoid=to_regprocedure('zzsh_supply.guard_legacy_listing_capture_fact()'))
          OR (t.tgname='legacy_capture_immutable' AND t.tgfoid=to_regprocedure('zzsh_supply.guard_release_immutable()')))) AS guards,
      (SELECT count(*)::integer FROM pg_constraint WHERE conrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact')
        AND conname IN ('legacy_capture_ratio_check','legacy_capture_payout_check','legacy_capture_observation_fk') AND convalidated) AS constraints,
      has_table_privilege($1,'zzsh_supply.legacy_listing_capture_fact','SELECT') AS runtime_select,
      has_table_privilege($1,'zzsh_supply.legacy_listing_capture_fact','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS runtime_table_write,
      has_any_column_privilege($1,'zzsh_supply.legacy_listing_capture_fact','INSERT,UPDATE,REFERENCES') AS runtime_column_write,
      EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.oid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND x.grantee=0) AS public_access,
      EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND x.grantee=0) AS public_column_access`,[target.runtimeRole])).rows[0];
    assert(schema?.ready===true&&schema.guards===2&&schema.constraints===3&&schema.runtime_select===true
      &&schema.runtime_table_write===false&&schema.runtime_column_write===false&&schema.public_access===false&&schema.public_column_access===false,"CAPTURE_SCHEMA_OR_ACL_CHANGED");
    const targets=(await client.query(`SELECT h.account_id,h.legacy_id,h.observation_version_id,h.source_digest,h.source_updated_at,
      d.display_digest,c.account_id AS capture_account_id,c.observation_version_id AS capture_version_id,
      c.base_source_digest AS capture_source_digest,c.display_digest AS capture_display_digest,c.capture_sha256,c.source_updated_at AS capture_updated_at,
      c.base_ratio_wan_per_yuan,c.ratio_issue,c.full_payout_selected,c.payout_issue,c.evidence_digest FROM zzsh_supply.legacy_listing_read_snapshot h
      LEFT JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=h.account_id AND d.schema_version=1
      LEFT JOIN zzsh_supply.legacy_listing_capture_fact c ON c.account_id=h.account_id ORDER BY h.legacy_id COLLATE "C"`)).rows;
    const byId=new Map();for(const r of targets){assert(typeof r.legacy_id==="string"&&!byId.has(r.legacy_id)&&hex(r.source_digest)&&hex(r.display_digest)
      &&r.source_updated_at instanceof Date,"CAPTURE_TARGET_ROW_INVALID");byId.set(r.legacy_id,r);}
    let selected=0;const datasetIds=new Set();for await(const row of readSourceRows(datasetPath)){
      assert(typeof row.sourceId==="string"&&!datasetIds.has(row.sourceId),"CAPTURE_DATASET_DUPLICATE");datasetIds.add(row.sourceId);
      const dst=byId.get(row.sourceId);assert(dst&&dst.source_digest===row.sourceDigest&&dst.source_updated_at.toISOString()===row.sourceUpdatedAt,"CAPTURE_DATASET_TARGET_DIFFERS");selected++;
    }
    assert(selected===dataset.files.accounts.rows&&selected===targets.length,"CAPTURE_TARGET_SET_DIFFERS");
    const facts=[],seen=new Set();let capturedRows=0;for await(const raw of readSourceRows(sourcePath)){
      capturedRows++;
      const dst=byId.get(raw.id);if(!dst)continue;assert(!seen.has(raw.id),"CAPTURE_SOURCE_DUPLICATE");seen.add(raw.id);
      const binding={accountId:dst.account_id,legacyId:dst.legacy_id,observationVersionId:dst.observation_version_id,
        baseSourceDigest:dst.source_digest,displayDigest:dst.display_digest,captureSha256:receipt.files.accounts.sha256,sourceUpdatedAt:dst.source_updated_at.toISOString()};
      const fact=factModule.legacyAccountCaptureFactFromSource(binding,raw),digest=factModule.legacyAccountCaptureFactDigest(fact);
      if(dst.capture_account_id!=null){
        assert(dst.capture_updated_at instanceof Date,"CAPTURE_PRIOR_FACT_DIFFERS");
        const existing=factModule.parseLegacyAccountCaptureFact({schema:"legacy-account-capture-fact-v1",accountId:dst.capture_account_id,
          legacyId:dst.legacy_id,observationVersionId:dst.capture_version_id,baseSourceDigest:dst.capture_source_digest,
          displayDigest:dst.capture_display_digest,captureSha256:dst.capture_sha256,sourceUpdatedAt:dst.capture_updated_at.toISOString(),
          sourceAccountBaseRatioWanPerYuan:dst.base_ratio_wan_per_yuan,ratioIssue:dst.ratio_issue,
          sourceAccountFullPayoutSelected:dst.full_payout_selected,payoutIssue:dst.payout_issue});
        assert(dst.evidence_digest===digest&&factModule.legacyAccountCaptureFactDigest(existing)===digest
          &&canonicalize(existing)===canonicalize(fact),"CAPTURE_PRIOR_FACT_DIFFERS");
      }else assert(dst.evidence_digest==null,"CAPTURE_PRIOR_FACT_DIFFERS");
      facts.push({fact,digest,present:dst.capture_account_id!=null});
    }
    assert(facts.length===selected&&seen.size===selected&&capturedRows===receipt.files.accounts.rows,"CAPTURE_SOURCE_SET_DIFFERS");
    await sourceFile(dirname(input.sourceReceipt.path),receipt.files.accounts);await sourceFile(dirname(input.datasetManifest.path),dataset.files.accounts);verifyFiles();
    const sealed={schema:"zzsh.r07-capture-fact-plan.v1",inputSha256:inputRef.sha256,target:targetBinding,toolFiles:proof,credentialSha256,resourceSha256,
      sourceReceiptSha256:input.sourceReceipt.sha256,datasetManifestSha256:input.datasetManifest.sha256,
      facts:facts.map(({fact,digest})=>({fact,digest})),counts:{selected,alreadyPresent:facts.filter(x=>x.present).length,
        ratioKnown:facts.filter(x=>x.fact.sourceAccountBaseRatioWanPerYuan!==null).length,
        payoutSelected:facts.filter(x=>x.fact.sourceAccountFullPayoutSelected===true).length,
        payoutUnselected:facts.filter(x=>x.fact.sourceAccountFullPayoutSelected===false).length}};
    if(plan){assert(plan.schema===sealed.schema&&plan.status==="PREPARED_READ_ONLY"&&plan.readOnlyRollbackAck===true
      &&plan.unlockAck===true&&plan.connectionsClosed===true&&plan.counts?.alreadyPresent===0
      &&plan.inputSha256===sealed.inputSha256&&canonicalize(plan.target)===canonicalize(sealed.target)
      &&plan.credentialSha256===sealed.credentialSha256&&plan.resourceSha256===sealed.resourceSha256
      &&canonicalize(plan.toolFiles)===canonicalize(sealed.toolFiles)&&canonicalize(plan.facts)===canonicalize(sealed.facts),"CAPTURE_PLAN_CHANGED");}
    if(mode==="--prepare")assert.equal(sealed.counts.alreadyPresent,0,"CAPTURE_ORIGINAL_PREIMAGE_REQUIRED");
    if(mode==="--readback"){
      const applied=pinned({path:option("--apply-receipt"),sha256:option("--apply-sha")});
      assert(applied.status==="COMMIT_ACK_READBACK_REQUIRED"&&applied.commitAck===true&&applied.planSha256===planRef.sha256
        &&canonicalize(applied.target)===canonicalize(targetBinding)&&applied.unlockAck===true&&applied.connectionsClosed===true,"CAPTURE_APPLY_UNCONFIRMED");
      assert.equal(sealed.counts.alreadyPresent,sealed.counts.selected,"CAPTURE_READBACK_INCOMPLETE");
      const operation="supply.legacy.account_capture_facts",scopeKey=JSON.stringify(["admin",actorFile.id,operation,receipt.files.accounts.sha256]);
      const expected=[];for(let i=0;i<plan.facts.length;i+=400){
        const batch=plan.facts.slice(i,i+400).map(x=>x.fact).sort((a,b)=>a.accountId<b.accountId?-1:a.accountId>b.accountId?1:0);
        const batchDigest=sha(canonicalize(batch.map(f=>factModule.legacyAccountCaptureFactDigest(f))));
        expected.push({batchDigest,key:`legacy-account-capture-batch-v1:${batchDigest}`,count:batch.length,
          fingerprint:fingerprintRequest(operation,receipt.files.accounts.sha256,{batchDigest,facts:batch})});
      }
      const records=(await client.query('SELECT key,request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])',[scopeKey,expected.map(x=>x.key)])).rows;
      const audits=(await client.query(`SELECT object_id,actor_id,session_id,details FROM zzsh_iam.audit_event WHERE action=$1 AND object_type='legacy_account_capture_batch'
        AND outcome='SUCCESS' AND object_id=ANY($2::text[])`,[operation,expected.map(x=>x.batchDigest)])).rows;
      assert(records.length===expected.length&&audits.length===expected.length,"CAPTURE_READBACK_RECEIPTS_MISSING");
      for(const e of expected){const r=records.find(x=>x.key===e.key),a=audits.filter(x=>x.object_id===e.batchDigest);
        assert(r&&r.request_fingerprint===e.fingerprint&&r.response_status===200&&r.response_body?.batchDigest===e.batchDigest
          &&r.response_body?.count===e.count&&r.response_body?.created===e.count&&a.length===1&&a[0].actor_id===actorFile.id
          &&a[0].session_id===actorFile.sessionId&&a[0].details?.captureSha256===receipt.files.accounts.sha256
          &&a[0].details?.count===e.count&&a[0].details?.created===e.count&&a[0].details?.approvalRef===applied.approvalRef
          &&a[0].details?.attempt===applied.attempt&&a[0].details?.financialEffects===false,"CAPTURE_READBACK_RECEIPT_DIFFERS");
      }
    }
    assert.equal((await client.query("ROLLBACK")).command,"ROLLBACK");begun=false;rollbackAck=true;
    if(mode==="--prepare")result={...sealed,status:"PREPARED_READ_ONLY",readOnlyRollbackAck:true};
    else if(mode==="--execute"){
      assertCaptureAuthority(authority,plan,planRef.sha256);assert.equal(sealed.counts.alreadyPresent,plan.counts.alreadyPresent,"CAPTURE_PREIMAGE_CHANGED");
      result.planSha256=planRef.sha256;result.approvalRef=authority.approvalRef;result.attempt=authority.attempt;
      result.status="TRANSACTION_INTENT";save();await client.query("BEGIN");begun=true;
      assertLiveTarget(target,(await client.query(targetIdentityQuery())).rows[0],"migration");
      const wanted=new Map(plan.facts.map(item=>[item.fact.legacyId,item])),processed=new Set(),batch=[];
      const actor={id:actorFile.id,sessionId:actorFile.sessionId,requestId:authority.attempt,reviewRef:authority.approvalRef,attempt:authority.attempt};
      const flush=async()=>{if(!batch.length)return;assertCaptureAuthority(authority,plan,planRef.sha256);
        await writer.recordLegacyAccountCaptureFactsBatch(client,batch.splice(0,batch.length),actor);result.processedInOpenTransaction=processed.size;save();};
      for await(const raw of readSourceRows(sourcePath)){
        const item=wanted.get(raw.id);if(!item)continue;assert(!processed.has(raw.id),"CAPTURE_SOURCE_DUPLICATE");
        const {schema,sourceAccountBaseRatioWanPerYuan,ratioIssue,sourceAccountFullPayoutSelected,payoutIssue,...binding}=item.fact;
        const current=factModule.legacyAccountCaptureFactFromSource(binding,raw);
        assert(canonicalize(current)===canonicalize(item.fact)&&factModule.legacyAccountCaptureFactDigest(current)===item.digest,"CAPTURE_PACKET_CHANGED");
        processed.add(raw.id);batch.push({binding,source:raw});if(batch.length===400)await flush();
      }
      await flush();assert.equal(processed.size,wanted.size,"CAPTURE_SOURCE_SET_CHANGED");await sourceFile(dirname(input.sourceReceipt.path),receipt.files.accounts);verifyFiles();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");assertLiveTarget(target,(await client.query(targetIdentityQuery())).rows[0],"migration");assertCaptureAuthority(authority,plan,planRef.sha256);
      result.status="COMMIT_REQUESTED";save();commitSent=true;assert.equal((await client.query("COMMIT")).command,"COMMIT");begun=false;commitAck=true;
      result.status="COMMIT_ACK_READBACK_REQUIRED";result.commitAck=true;result.rows=processed.size;save();
    }else{
      result={schema:"zzsh.r07-capture-fact-readback.v1",status:"CAPTURE_SOURCE_AND_TARGET_MATCHED",planSha256:planRef.sha256,target:targetBinding,
        counts:sealed.counts,readOnlyRollbackAck:true};
    }
  }catch(error){result.status=commitSent&&!commitAck?"COMMIT_UNKNOWN":commitAck?"COMMIT_ACK_READBACK_REQUIRED":"STOPPED";
    result.error=safeErrorCode(error);
    if(begun&&!commitSent){try{rollbackAck=(await client.query("ROLLBACK")).command==="ROLLBACK";begun=false;}catch{rollbackAck=false;}}
    result.rollbackAck=rollbackAck;process.exitCode=1;
  }finally{
    if(begun&&!commitSent)try{rollbackAck=(await client.query("ROLLBACK")).command==="ROLLBACK";}catch{}
    try{await client.end();closed=true;}catch{}try{if(held)unlockAck=(await lock.query("SELECT pg_advisory_unlock($1::bigint) AS ok",[target.lockKey])).rows[0]?.ok===true;}catch{}
    try{await lock.end();lockClosed=true;}catch{}
  }
  Object.assign(result,{unlockAck,connectionsClosed:closed&&lockClosed,finishedAt:new Date().toISOString()});
  if(mode==="--execute")save();
  else if(rollbackAck&&unlockAck&&closed&&lockClosed){const file=join(out,mode==="--prepare"?"plan.json":"readback.json");writePrivate(file,result);
    console.log(JSON.stringify({status:result.status,error:result.error,sha256:sha(readFileSync(file)),counts:result.counts,targetWrites:0}));return;}
  console.log(JSON.stringify({status:result.status,error:result.error,rows:result.rows,processedInOpenTransaction:result.processedInOpenTransaction,
    rollbackAck,unlockAck,connectionsClosed:result.connectionsClosed,financialWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(error=>{
  console.error(JSON.stringify({status:"CAPTURE_STOPPED",code:safeErrorCode(error)}));process.exitCode=1;
});
