import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateRoundAccountSet, validateRoundTrialReceipt } from './legacy-listed-round-source.mjs';
import { NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');

export const LISTED_API_MODULES = ['auth/auth-security','auth/security-core','database/business-migrations','order/order','order/legacy-continuation-model','supply/content-hash','supply/funding-authority',
  'supply/legacy-display-snapshot','supply/legacy-listing-read','supply/legacy-published-reference','supply/legacy-trade-takeover','supply/publishing','supply/supply-util',
  'supply/legacy-listed-source-quote','supply/legacy-listed-policy','supply/legacy-listed-source','supply/legacy-listed-pricing','supply/legacy-listed-quote',
  'supply/pricing','supply/delta-rental','supply/decimal','supply/legacy-observation','supply/funding-policy','supply/full-payout-terms','credit/credit-guarantee'];

/** Pin exactly the code and database guards used by both batch execution and full readback. */
export function readListedCompiledProof(apiDist,{roundBound,sameCapture}) {
  const compiled=Object.fromEntries(LISTED_API_MODULES.map(name=>[name,sha(readFileSync(join(apiDist,name+'.js')))]));
  for(const [key,file] of Object.entries({policyDumpVerifier:'verify-legacy-listed-policy-dump.mjs',sourceAdapter:'local-source-adapter.mjs',
    planValidator:'legacy-listed-execution-plan.mjs',loader:'load-legacy-listed-accounts.mjs',targetRegistry:'local-target-registry.mjs',
    provisionalCreditVerifier:'legacy-listed-provisional-credit.mjs',...(roundBound?{roundSourceVerifier:'legacy-listed-round-source.mjs'}:{})}))
    compiled[key]=sha(readFileSync(new URL('./'+file,import.meta.url)));
  const migrationsFolder=resolve(apiDist,'../../migrations/business'),journal=JSON.parse(readFileSync(join(migrationsFolder,'meta/_journal.json'),'utf8'));
  const migrationEntry=journal.entries.find(entry=>entry.tag==='0156_legacy_listed_quote');
  if(!migrationEntry||!Number.isSafeInteger(migrationEntry.when))throw new Error('LISTED_MIGRATION_JOURNAL_INVALID');
  compiled.listedMigration=sha(readFileSync(join(migrationsFolder,'0156_legacy_listed_quote.sql')));
  compiled.migrationJournal=sha(readFileSync(join(migrationsFolder,'meta/_journal.json')));
  let sameCaptureMigrationEntry;
  if(sameCapture){
    const tag='0194_legacy_listed_policy_same_capture';sameCaptureMigrationEntry=journal.entries.find(entry=>entry.tag===tag);
    if(!sameCaptureMigrationEntry||!Number.isSafeInteger(sameCaptureMigrationEntry.when))throw new Error('LISTED_SAME_CAPTURE_MIGRATION_JOURNAL_INVALID');
    const migration=readFileSync(join(migrationsFolder,tag+'.sql'));
    compiled.sameCaptureMigration=sha(migration);compiled.sameCaptureGuard=sameCapturePolicyGuardDigest(migration.toString('utf8'));
  }
  return {compiled,migrationsFolder,migrationEntry,sameCaptureMigrationEntry};
}

export function isSameCaptureListedPolicy(canonical) {
  let schema;try{schema=JSON.parse(canonical).schema;}catch{throw new Error('SOURCE_POLICY_EVIDENCE_INVALID');}
  if(schema==='legacy-listed-policy-evidence-v2')return true;
  if(schema==='legacy-listed-policy-evidence-v1')return false;
  throw new Error('SOURCE_POLICY_EVIDENCE_INVALID');
}

export function sameCapturePolicyGuardDigest(sql) {
  const header='CREATE OR REPLACE FUNCTION zzsh_supply.guard_legacy_listed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$';
  const start=typeof sql==='string'?sql.indexOf(header):-1,end=start<0?-1:sql.indexOf('$$;',start+header.length);
  if(start<0||end<0||sql.indexOf(header,start+header.length)!==-1)throw new Error('LISTED_SAME_CAPTURE_MIGRATION_INVALID');
  return sha(sql.slice(start+header.length,end).replaceAll('\r\n','\n'));
}

export async function assertSameCapturePolicyMigration(client,digest,when,guardDigest) {
  if(!/^[a-f0-9]{64}$/.test(digest??'')||!/^[a-f0-9]{64}$/.test(guardDigest??'')||!Number.isSafeInteger(when))throw new Error('LISTED_SAME_CAPTURE_MIGRATION_NOT_READY');
  const row=(await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_business_meta.migrations WHERE hash=$1 AND created_at=$2)
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure('zzsh_supply.guard_legacy_listed_evidence()') AND l.lanname='plpgsql'
      AND p.prorettype='trigger'::regtype AND NOT p.prosecdef AND p.provolatile='v' AND p.proconfig IS NULL
      AND encode(sha256(convert_to(replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex')=$3)
    AND (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=31
      AND t.tgfoid=to_regprocedure('zzsh_supply.guard_legacy_listed_evidence()')
      AND ((t.tgrelid=to_regclass('zzsh_supply.legacy_listed_policy_evidence') AND t.tgname='legacy_listed_policy_evidence_guard')
        OR (t.tgrelid=to_regclass('zzsh_supply.legacy_listed_quote_evidence') AND t.tgname='legacy_listed_quote_evidence_guard')))=2 AS ready`,
  [digest,String(when),guardDigest])).rows[0];
  if(!row?.ready)throw new Error('LISTED_SAME_CAPTURE_MIGRATION_NOT_READY');
}

/** A missing holding is unknown; only an admitted complete set may be published. */
export async function readVerifiedLegacySkinIds(client, accountId, versionId, gameId, readLegacySkinHolding) {
  const holding = await readLegacySkinHolding(client, accountId, versionId, gameId, 'LEGACY_OBSERVATION');
  if (holding?.state !== 'ADMITTED' || !Number.isSafeInteger(holding.admittedCount) || holding.admittedCount < 0
    || !Number.isSafeInteger(holding.withheldCount) || holding.withheldCount < 0 || !Array.isArray(holding.items))
    return { blocked: 'SOURCE_SKIN_HOLDING_UNPROVEN' };
  if (holding.withheldCount > 0) return { blocked: 'CURRENT_SKIN_CATALOG_REVIEW_REQUIRED' };
  const ids = holding.items.map(item => item?.id);
  if (ids.length !== holding.admittedCount || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    return { blocked: 'SOURCE_SKIN_HOLDING_UNPROVEN' };
  return { skinIds: ids };
}

/** Check the complete reviewed batch before any per-account transaction is allowed to start. */
export function validateLegacyListedExecutionPlan(input,target,compiled,canonicalize,binding) {
  const fail=()=>{throw new Error('EXECUTION_PLAN_BINDING_CHANGED');};
  if(target?.migrationProfile===NEXT_MIGRATION_PROFILE&&(input?.targetFence!=='HELD_DURING_OPERATION'||input?.targetFenceReleased!==true))fail();
  if(!input || input.schema!=='zzsh.legacy-listed-execution-plan.v2' || canonicalize(input.target)!==canonicalize(target)
    || canonicalize(input.compiled)!==canonicalize(compiled) || !Array.isArray(input.rows)
    || !Number.isSafeInteger(input.sourceAccountCount) || input.sourceAccountCount<1 || input.sourceAccountCount>10000
    || input.rows.length!==input.sourceAccountCount || !/^[a-f0-9]{64}$/.test(input.policyBundleSha256??'')
    || !/^[a-f0-9]{64}$/.test(input.sourceReceiptSha256??'') || !/^[a-f0-9]{64}$/.test(input.policyAuthoritySha256??'')
    || new Set(input.rows.map(row=>row?.sourceId)).size!==input.rows.length)fail();
  if(input.rows.some(row=>!row?.body || row.blocked))throw new Error('PARTIAL_LISTED_BATCH_NOT_AUTHORIZED');
  const accounts=new Set();
  for(const row of input.rows){
    const intake=row.body.intake,source=intake?.source,evidence=intake?.legacyQuoteEvidence,proof=evidence?.policyBinding;
    if(!intake || !source || !evidence || !proof || typeof intake.accountId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intake.accountId)
      || !['0','1'].includes(intake.isFullPayout) || accounts.has(intake.accountId)
      || source.sourceSystem!=='legacy_mysql_restore' || source.sourceEntity!=='la_rental_accounts' || source.legacyId!==row.sourceId
      || typeof evidence.sourceCanonical!=='string' || sha(evidence.sourceCanonical)!==source.sourceDigest
      || typeof evidence.policyCanonical!=='string' || sha(evidence.policyCanonical)!==input.policyBundleSha256
      || typeof proof.authorityCanonical!=='string' || sha(proof.authorityCanonical)!==input.policyAuthoritySha256 || proof.authoritySha256!==input.policyAuthoritySha256
      || proof.proofSha256!==input.policyBundleSha256 || proof.sourceReceiptSha256!==input.sourceReceiptSha256
      || proof.sourceId!==source.legacyId || proof.sourceDigest!==source.sourceDigest || proof.expectedAccountCount!==input.sourceAccountCount
      || !/^[a-f0-9]{64}$/.test(row.sourceQuoteDigest??'') || !/^[a-f0-9]{64}$/.test(row.policyDigest??'')
      || canonicalize(binding(row.body))!==canonicalize({scope:row.scope,key:row.key,fingerprint:row.fingerprint}))fail();
    accounts.add(intake.accountId);
  }
  return input.rows;
}

/** A committed checkpoint is only a starting point for an independent readback. */
export function validateListedExecutionCheckpoint(checkpoint,inputSha,target,rows,canonicalize) {
  const invalid=()=>{throw new Error('LISTED_EXECUTION_CHECKPOINT_INCOMPLETE');};
  if(!/^[a-f0-9]{64}$/.test(inputSha??'') || checkpoint?.inputSha!==inputSha
    || canonicalize(checkpoint.target)!==canonicalize(target) || checkpoint.pending!==null
    || target?.migrationProfile===NEXT_MIGRATION_PROFILE&&(checkpoint.targetFence!=='HELD_DURING_OPERATION'||checkpoint.targetFenceReleased!==true)
    || !Array.isArray(checkpoint.completed) || checkpoint.completed.length!==rows.length || !rows.length)invalid();
  return rows.map((row,index)=>{
    const completed=checkpoint.completed[index],publication=completed?.publication,intake=row.body?.intake;
    if(completed?.sourceId!==row.sourceId || typeof completed.replayed!=='boolean'
      || publication?.state!=='PUBLISHED' || publication.accountId!==intake?.accountId
      || publication.releaseId!==row.releaseId || typeof publication.versionId!=='string' || !publication.versionId
      || !/^[a-f0-9]{64}$/.test(publication.contentHash??''))invalid();
    return {row,publication};
  });
}

/** Only a complete, independently read-back set of batches may feed the final target check. */
export function validateListedBatchReadbackSet({manifest,manifestSha256,roundInputSha256,policies,batches,target,compiled,canonicalize,binding}) {
  const invalid=()=>{throw new Error('LISTED_ALL_BATCHES_INCOMPLETE');};
  if(manifest?.schema!=='zzsh.listed-same-capture-batches.v1'||!/^[a-f0-9]{64}$/.test(manifestSha256??'')
    ||!/^[a-f0-9]{64}$/.test(roundInputSha256??'')||!Array.isArray(manifest.batches)||!manifest.batches.length
    ||!Array.isArray(policies)||!Array.isArray(batches)||policies.length!==manifest.batches.length||batches.length!==manifest.batches.length
    ||typeof canonicalize!=='function'||typeof binding!=='function')invalid();
  const all=[],entries=[],ids=new Set(),accounts=new Set();
  for(let index=0;index<batches.length;index++){
    const expected=manifest.batches[index],policy=policies[index],batch=batches[index];
    const source=batch?.sourcePlan,plan=batch?.executionPlan,roundBinding=source?.roundBinding,proof=roundBinding?.batch;
    const rows=policy?.supplement?.accountSourceDigests;
    if(expected?.index!==index+1||proof?.index!==index+1||proof.manifestSha256!==manifestSha256
      ||roundBinding?.roundInputSha256!==roundInputSha256||roundBinding?.sourceBindingSha256!==manifest.sourceBindingSha256
      ||roundBinding?.scopeAuditSha256!==batch.auditSha256||source?.schema!=='zzsh.listed-source-continuity-plan.v2'
      ||plan?.sourcePlanSha256!==batch.sourcePlanSha256||plan?.sourceReceiptSha256!==manifest.sourceReceiptSha256
      ||canonicalize(plan.roundBinding)!==canonicalize(roundBinding)||!Array.isArray(rows)||rows.length!==expected.count
      ||sha(canonicalize(policy))!==expected.policyCanonicalSha256||sha(canonicalize(rows))!==expected.accountSetSha256
      ||batch.audit?.batchManifestSha256!==manifestSha256||batch.audit?.batchIndex!==index+1
      ||batch.audit?.batchAccountSetSha256!==expected.accountSetSha256)invalid();
    validateRoundAccountSet(source,batch.audit,policy,expected.count);
    validateRoundAccountSet(plan,batch.audit,policy,expected.count);
    const verified=validateLegacyListedExecutionPlan(plan,target,compiled,canonicalize,binding);
    validateRoundTrialReceipt(batch.trial,batch.executionPlanSha256,target,verified,canonicalize);
    const current=validateListedExecutionCheckpoint(batch.checkpoint,batch.executionPlanSha256,target,verified,canonicalize);
    const readback=batch.readback;
    if(readback?.schema!=='zzsh.legacy-listed-batch-readback.v1'||readback.status!=='LISTED_BATCH_READBACK_PASS'
      ||readback.inputSha!==batch.executionPlanSha256||readback.checkpointSha!==batch.checkpointSha256
      ||canonicalize(readback.target)!==canonicalize(target)||readback.rollbackConfirmed!==true||readback.targetWrites!==0
      ||target?.migrationProfile===NEXT_MIGRATION_PROFILE&&(readback.targetFence!=='HELD_DURING_OPERATION'||readback.targetFenceReleased!==true)
      ||readback.expected!==expected.count||readback.committed!==expected.count||readback.rentable!==expected.count
      ||!Array.isArray(readback.differences)||readback.differences.length!==0)invalid();
    for(const item of rows){if(ids.has(item.id))invalid();ids.add(item.id);all.push(item);}
    for(const item of current){if(accounts.has(item.publication.accountId))invalid();accounts.add(item.publication.accountId);entries.push(item);}
  }
  const sorted=[...all].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(manifest.listedAccounts!==all.length||canonicalize(all)!==canonicalize(sorted)||sha(canonicalize(all))!==manifest.accountSetSha256)invalid();
  return entries;
}

/** Detect old-source observations or publications outside the verified listed set. */
export async function readUnexpectedListedTarget(client,entries) {
  const ids=entries.map(item=>item?.row?.sourceId);
  if(!ids.length||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('LISTED_ALL_SOURCE_SET_INVALID');
  const result=await client.query(`SELECT
    (SELECT count(*)::text FROM zzsh_supply.legacy_listing_read_snapshot h
      WHERE h.source_system='legacy_mysql_restore' AND h.source_entity='la_rental_accounts' AND h.source_status=3
        AND NOT (h.legacy_id=ANY($1::text[]))) AS observations,
    (SELECT count(*)::text FROM zzsh_supply.listing_publication p JOIN zzsh_supply.legacy_supply_map m ON m.account_id=p.account_id
      WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
        AND NOT (m.legacy_id=ANY($1::text[]))) AS publications`,[ids]);
  const row=result.rows[0];
  if(result.rows.length!==1||!['observations','publications'].every(key=>typeof row?.[key]==='string'&&/^(0|[1-9]\d*)$/.test(row[key])))
    throw new Error('LISTED_ALL_TARGET_UNAVAILABLE');
  return {status:row.observations==='0'&&row.publications==='0'?'NO_UNEXPECTED_LISTED_FACTS':'UNEXPECTED_LISTED_FACTS_REVIEW_REQUIRED',
    unexpectedObservations:row.observations,unexpectedPublications:row.publications};
}

/** Verify committed facts and the current public rental gate in one read-only snapshot. */
export async function readListedExecutionProof(client,entries,{readPublishingAccount,listingDetail,gate}) {
  const expected=entries.map(({row,publication})=>({
    source_id:row.sourceId,source_digest:row.body.intake.source.sourceDigest,
    observation_version:row.body.intake.source.expectedObservationVersionId,
    account_id:publication.accountId,owner_id:row.body.intake.source.expectedOwnerUserId,
    game_id:row.body.intake.source.expectedGameId,version_id:publication.versionId,
    release_id:publication.releaseId,content_hash:publication.contentHash,
    quote_digest:row.sourceQuoteDigest,policy_digest:row.policyDigest,scope_key:row.scope,key:row.key,
  }));
  const result=await client.query(`WITH expected AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(source_id text,source_digest text,observation_version text,
        account_id text,owner_id text,game_id text,version_id text,release_id text,content_hash text,
        quote_digest text,policy_digest text,scope_key text,key text)
    ) SELECT e.source_id AS "sourceId",
      m.account_id=e.account_id AND m.version_id=e.observation_version AND m.source_digest=e.source_digest AS "sourceMatches",
      a.current_version_id=e.version_id AND a.owner_user_id=e.owner_id AND a.game_id=e.game_id AS "currentAccountMatches",
      v.origin='NATIVE' AND v.review_state='APPROVED' AND v.rule_release_id=e.release_id AND v.content_hash=e.content_hash AS "versionMatches",
      p.source='LEGACY_APPROVED' AND p.owner_user_id=e.owner_id AND p.game_id=e.game_id
        AND p.rule_release_id=e.release_id AND p.content_hash=e.content_hash AS "publicationMatches",
      q.quote_digest=e.quote_digest AND q.policy_digest=e.policy_digest AS "quoteMatches",
      i.request_fingerprint AS "requestFingerprint",i.response_status AS "responseStatus",i.response_body AS "responseBody"
    FROM expected e
    LEFT JOIN zzsh_supply.legacy_supply_map m ON m.source_system='legacy_mysql_restore'
      AND m.source_entity='la_rental_accounts' AND m.legacy_id=e.source_id
    LEFT JOIN zzsh_supply.rental_account a ON a.id=e.account_id
    LEFT JOIN zzsh_supply.listing_version v ON v.id=e.version_id AND v.account_id=e.account_id
    LEFT JOIN zzsh_supply.listing_publication p ON p.version_id=e.version_id AND p.account_id=e.account_id
    LEFT JOIN zzsh_supply.legacy_listed_quote_evidence q ON q.listing_version_id=e.version_id AND q.account_id=e.account_id
    LEFT JOIN zzsh_supply.idempotency_record i ON i.scope_key=e.scope_key AND i.key=e.key`,[JSON.stringify(expected)]);
  if(result.rows.length!==entries.length || new Set(result.rows.map(row=>row.sourceId)).size!==entries.length)
    throw new Error('LISTED_READBACK_FACT_SET_CHANGED');
  const facts=new Map(result.rows.map(row=>[row.sourceId,row])),differences=[];
  let committed=0,rentable=0;
  for(const {row,publication} of entries){
    const fact=facts.get(row.sourceId);
    const receipt=fact?.responseBody,fields=['accountId','versionId','releaseId','contentHash','state'];
    const sameReceipt=receipt && typeof receipt==='object' && !Array.isArray(receipt)
      && Object.keys(receipt).length===fields.length && Object.keys(publication).length===fields.length
      && fields.every(field=>receipt[field]===publication[field]);
    const recorded=fact && ['sourceMatches','currentAccountMatches','versionMatches','publicationMatches','quoteMatches'].every(key=>fact[key]===true)
      && fact.requestFingerprint===row.fingerprint && fact.responseStatus===200
      && sameReceipt;
    if(!recorded){differences.push({sourceId:row.sourceId,reason:'PUBLICATION_FACT_MISMATCH'});continue;}
    committed++;
    const account=await readPublishingAccount(client,publication.accountId);
    let publicListing;
    try{publicListing=await listingDetail(client,account,'public',gate,'public',account,true,'RENTABLE');}
    catch(error){if(error?.status!==404)throw error;}
    if(publicListing?.id!==publication.accountId || publicListing.versionId!==publication.versionId
      || publicListing.releaseId!==publication.releaseId || publicListing.availability?.state!=='RENTABLE'
      || publicListing.canCreateOrder!==true){differences.push({sourceId:row.sourceId,reason:'PUBLIC_LISTING_NOT_RENTABLE'});continue;}
    rentable++;
  }
  return {status:differences.length?'LISTED_BATCH_READBACK_REVIEW_REQUIRED':'LISTED_BATCH_READBACK_PASS',
    expected:entries.length,committed,rentable,differences};
}
