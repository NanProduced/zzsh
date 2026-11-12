import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertContinuationCommissionCoverage, assertContinuationSourceCoverage, isExactLegacyRefundRelationship, LEGACY_REFUND_RELATIONSHIP_POLICY, NEXT_CONTINUATION_COMMISSION_POLICY, NEXT_CONTINUATION_POLICY, readBoundSourceRows, sourceFinanceObservation } from "./local-source-adapter.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
async function fileSha(file) { const h=createHash("sha256"); for await(const bytes of createReadStream(file)) h.update(bytes); return h.digest("hex"); }
const accountFields=["id","user_id","no","status","is_delete","pay_is","pay_money","pay_time","create_pay_time","pay_way","order_sn","leshua_order_id","yj_order_id","transaction_id","return_is","service_id","team_id","base_bot","update_time","pay_url_present","pay_url_sha256"];
const paymentFields=["id","order_id","order_type","pay_way","pay_order_sn","pay_money","pay_is","pay_time","create_time"];
const pick=(row,fields)=>Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));

/** Old sealed packages keep their original fingerprint; new packages require a nonblank order number. */
export function isPreparedRefundRelationshipVerified(refund,order,policy){
 if(policy==null)return order?.user_id===refund.user_id&&order?.order_sn===refund.order_sn;
 if(policy!==LEGACY_REFUND_RELATIONSHIP_POLICY)throw Error('LEGACY_REFUND_RELATIONSHIP_POLICY_UNSUPPORTED');
 return isExactLegacyRefundRelationship(refund,order);
}

/**
 * Empty history coverage is one entry per subject and source kind, so a full-source round would hold
 * roughly five entries for every legacy user at once. The sink keeps the same 400-entry chunking the
 * loader already used, hands each complete chunk to `onChunk`, and records an ordered digest per
 * chunk; without a sink it still collects the entries so small rounds and tests are unchanged.
 */
export const EMPTY_COVERAGE_CHUNK_SIZE = 400;
export function emptyCoverageChunkDigest(rows) { return sha(rows.map(row => row.sourceId).join("\n")); }
export function assertEmptyCoverageReceiptMode(phase,isNext){
 if(typeof isNext!=='boolean'||!phase||typeof phase!=='object'||Array.isArray(phase))throw Error('EMPTY_COVERAGE_RECEIPT_MODE_UNPROVEN');
 if(isNext&&phase.receiptMode!=='BATCH_V2')throw Error('EMPTY_COVERAGE_RECEIPT_MODE_UNPROVEN');
 if(!isNext&&Object.hasOwn(phase,'receiptMode'))throw Error('EMPTY_COVERAGE_RECEIPT_MODE_UNSUPPORTED');
}

/** Compare original batch receipts and audits without interpreting absence as success. */
export function compareCompactCoverageEvidence(expected,receipts,audits,actor){
 if(!Array.isArray(expected)||!Array.isArray(receipts)||!Array.isArray(audits)||!actor?.userId||!actor?.sessionId
  ||expected.some(row=>!/^history-empty-batch-[a-f0-9]{40}$/.test(row?.batchId??'')||!/^[a-f0-9]{64}$/.test(row?.fingerprint??'')
   ||row.body?.schema!=='finance-empty-coverage-batch.v1'||row.body.batchId!==row.batchId||row.body.actor?.userId!==actor.userId
   ||row.body.actor?.sessionId!==actor.sessionId||typeof row.body.requestId!=='string'||!row.body.requestId)
  ||new Set(expected.map(row=>row.batchId)).size!==expected.length)throw Error('COMPACT_COVERAGE_READBACK_INPUT_INVALID');
 const receiptById=Map.groupBy(receipts,row=>row.key),auditById=Map.groupBy(audits,row=>row.object_id),differences=[];
 const scopeKey=JSON.stringify(['admin',actor.userId,'finance.history.empty_batch.import.v1',null]);
 for(const proof of expected){
  const receipt=receiptById.get(proof.batchId)??[],audit=auditById.get(proof.batchId)??[];
  if(receipt.length!==1||receipt[0].scope_key!==scopeKey||receipt[0].request_fingerprint!==proof.fingerprint||receipt[0].response_status!==200
   ||receipt[0].publish_required!==false||!isDeepStrictEqual(receipt[0].response_body,proof.body))
   differences.push({batchId:proof.batchId,reason:'BATCH_RECEIPT_MISSING_OR_CHANGED'});
  if(audit.length!==1||audit[0].action!=='finance.history.empty_batch.imported'||audit[0].object_type!=='personal_finance_observation_coverage_batch'
   ||audit[0].actor_type!=='admin'||audit[0].outcome!=='SUCCESS'||audit[0].actor_id!==actor.userId||audit[0].session_id!==actor.sessionId
   ||audit[0].request_id!==proof.body.requestId||!isDeepStrictEqual(audit[0].details,proof.body))
   differences.push({batchId:proof.batchId,reason:'BATCH_AUDIT_MISSING_OR_CHANGED'});
 }
 if(receipts.length!==expected.length||audits.length!==expected.length)differences.push({batchId:'COHORT',reason:'BATCH_EVIDENCE_COUNT_DIFFERS'});
 return{expected:expected.length,matched:expected.length-new Set(differences.filter(row=>row.batchId!=='COHORT').map(row=>row.batchId)).size,differences};
}

/** Independent readback queries only the exact frozen batch keys, in bounded groups. */
export async function readCompactCoverageEvidence(query,expected,actor){
 if(typeof query!=='function'||!Array.isArray(expected)||!actor?.userId||!actor?.sessionId
  ||new Set(expected.map(row=>row.batchId)).size!==expected.length)throw Error('COMPACT_COVERAGE_READBACK_INPUT_INVALID');
 compareCompactCoverageEvidence(expected,[],[],actor);
 const scopeKey=JSON.stringify(['admin',actor.userId,'finance.history.empty_batch.import.v1',null]),differences=[];let matched=0;
 for(let i=0;i<expected.length;i+=500){const part=expected.slice(i,i+500),ids=part.map(row=>row.batchId);
  const receipts=(await query(`SELECT scope_key,key,request_fingerprint,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])`,[scopeKey,ids])).rows;
  const audits=(await query(`SELECT object_id,action,object_type,actor_type,outcome,actor_id,session_id,request_id,details FROM zzsh_iam.audit_event WHERE action='finance.history.empty_batch.imported' AND object_type='personal_finance_observation_coverage_batch' AND object_id=ANY($1::text[])`,[ids])).rows;
  const checked=compareCompactCoverageEvidence(part,receipts,audits,actor);matched+=checked.matched;differences.push(...checked.differences);
 }
 const receiptTotal=(await query(`SELECT count(*)::text AS n FROM zzsh_supply.idempotency_record WHERE right(scope_key,length($1::text))=$1`,[',"finance.history.empty_batch.import.v1",null]'])).rows[0]?.n;
 const auditTotal=(await query(`SELECT count(*)::text AS n FROM zzsh_iam.audit_event WHERE action='finance.history.empty_batch.imported' AND object_type='personal_finance_observation_coverage_batch'`,[])).rows[0]?.n;
 if(!/^\d+$/.test(receiptTotal??'')||!/^\d+$/.test(auditTotal??''))throw Error('COMPACT_COVERAGE_TOTAL_UNAVAILABLE');
 if(receiptTotal!==String(expected.length)||auditTotal!==String(expected.length))differences.push({batchId:'COHORT',reason:'BATCH_TOTAL_DIFFERS'});
 return{expected:expected.length,matched,differences};
}

/** Compare a newly derived source chunk with the exact immutable bytes the loader consumed. */
export function assertRebuiltEmptyCoverageChunk(descriptor, rebuilt, savedBytes) {
  if (!descriptor || !rebuilt || !Buffer.isBuffer(savedBytes) || !Array.isArray(rebuilt.entries)
    || !/^[a-f0-9]{64}$/.test(descriptor.digest ?? "") || descriptor.digest !== rebuilt.digest
    || descriptor.sourceId !== "empty-" + descriptor.digest.slice(0, 40) || descriptor.sourceId !== rebuilt.sourceId
    || !Number.isSafeInteger(descriptor.rows) || descriptor.rows < 1 || descriptor.rows > EMPTY_COVERAGE_CHUNK_SIZE
    || descriptor.rows !== rebuilt.rows || descriptor.rows !== rebuilt.entries.length
    || emptyCoverageChunkDigest(rebuilt.entries) !== descriptor.digest
    || JSON.stringify(Object.entries(descriptor.domains ?? {}).sort()) !== JSON.stringify(Object.entries(rebuilt.domains ?? {}).sort())
    || sha(savedBytes) !== sha(JSON.stringify(rebuilt.entries))) throw Error("EMPTY_COVERAGE_REBUILT_CHUNK_DIFFERS");
}

/** Validate both ordered chunk coverage and the frozen aggregate before declaring a readback. */
export function assertRebuiltEmptyCoverageManifest(saved, rebuilt, checkedChunks) {
  if (saved?.schema !== "zzsh.empty-coverage-chunks.v1" || rebuilt?.schema !== saved.schema
    || saved.chunkSize !== EMPTY_COVERAGE_CHUNK_SIZE || rebuilt.chunkSize !== saved.chunkSize
    || !Array.isArray(saved.chunks) || saved.chunks.length !== checkedChunks || rebuilt.chunks !== checkedChunks
    || !Number.isSafeInteger(saved.rows) || rebuilt.rows !== saved.rows
    || !/^[a-f0-9]{64}$/.test(saved.digest ?? "") || rebuilt.digest !== saved.digest
    || sha(saved.chunks.map(chunk => chunk.digest).join("\n")) !== saved.digest
    || new Set(saved.chunks.map(chunk => chunk.digest)).size !== saved.chunks.length
    || saved.chunks.reduce((sum, chunk) => sum + chunk.rows, 0) !== saved.rows
    || JSON.stringify(Object.entries(saved.domainRows ?? {}).sort()) !== JSON.stringify(Object.entries(rebuilt.domainRows ?? {}).sort()))
    throw Error("EMPTY_COVERAGE_REBUILT_MANIFEST_DIFFERS");
}
export function createEmptyCoverageSink({ onChunk = null } = {}) {
  const buffered = [], chunks = [], collected = [], subjects = new Set(), kinds = {}, domainRows = {};
  const flush = () => {
    if (!buffered.length) return;
    const rows = buffered.splice(0, buffered.length), digest = emptyCoverageChunkDigest(rows);
    const domains = {};
    for (const row of rows) { domains[row.domain] = (domains[row.domain] ?? 0) + 1; domainRows[row.domain] = (domainRows[row.domain] ?? 0) + 1; const subject = row.input?.coverage?.legacyUserId; if (subject !== undefined) subjects.add(subject); const kind = row.input?.coverage?.sourceKind; if (kind !== undefined) kinds[row.domain] = kind; }
    const chunk = { sourceId: "empty-" + digest.slice(0, 40), digest, rows: rows.length, domains };
    chunks.push(chunk);
    if (onChunk) onChunk({ ...chunk, entries: rows });
    else collected.push(...rows);
  };
  return {
    push(entry) { buffered.push(entry); if (buffered.length >= EMPTY_COVERAGE_CHUNK_SIZE) flush(); },
    finish() {
      flush();
      return { chunks, entries: collected, manifest: {
        schema: "zzsh.empty-coverage-chunks.v1", chunkSize: EMPTY_COVERAGE_CHUNK_SIZE,
        chunks: chunks.length, rows: chunks.reduce((n, chunk) => n + chunk.rows, 0),
        digest: sha(chunks.map(chunk => chunk.digest).join("\n")), subjects: [...subjects], kinds, domainRows,
      } };
    },
  };
}

export function continuationCommissionEffects(rows,mod){
 const model=mod("order/legacy-continuation-model"),users=mod("supply/legacy-user-migration");
 return rows.flatMap(({body})=>body.source.commissions.filter(c=>c.status==='1').map(c=>({dutyId:model.legacyEconomicDutyId(body.orderId,'COMMISSION',c.id),kind:'COMMISSION',sourceRecordId:c.id,amountCents:model.legacyPlanYuanToCents(c.storedEarnings),beneficiaryUserId:users.legacyOwnerUserId('legacy_mysql_restore','la_user',c.beneficiaryId),level:c.level,ratio:c.ratio,sourceDigest:body.sourceDigest,status:'PENDING',settledBy:null})));
}
export function assertPendingCommissionCoverage(rows,source){
 const seen=new Set();for(const row of rows){const raw=source.get(row?.sourceRecord?.id);
  if(!raw||seen.has(raw.id)||row.parentLegacyOrderId!==raw.order_id||!isDeepStrictEqual(row.sourceRecord,raw))throw Error('FUNDS_PENDING_COMMISSION_SOURCE_SET_CHANGED');seen.add(raw.id);}
 if(seen.size!==source.size)throw Error('FUNDS_PENDING_COMMISSION_SOURCE_SET_CHANGED');
}

const restrictedWithdrawalFields=["real_name","account","money_qr_code","apply_remark","pay_desc","pay_search_result","audit_remark","transfer_voucher","transfer_remark","bank_card_no","bank_name","mobile","admin_id"];
/** Old payout destinations are evidence only; never a new beneficiary, verified bank binding or usable URL. */
export function safeLegacyWithdrawalEvidence(raw,ref,canonical){
 const card=typeof raw.bank_card_no==='string'?raw.bank_card_no.replace(/\D/g,''):'';
 const first=typeof raw.real_name==='string'?Array.from(raw.real_name.trim())[0]:null;
 const name=first&&/^\p{L}$/u.test(first)?first+'**':null;
 const phone=typeof raw.mobile==='string'&&/^\d{11}$/.test(raw.mobile)?raw.mobile.slice(0,3)+'****'+raw.mobile.slice(-4):null;
 const bank=typeof raw.bank_name==='string'&&!/https?:|@/i.test(raw.bank_name)?raw.bank_name.replace(/[\u0000-\u001f\u007f]/g,'').replace(/\d{5,}/g,'****').slice(0,80)||null:null;
 const account=typeof raw.account==='string'&&raw.account?'****'+(raw.account.match(/\d{4}$/)?.[0]??''):null;
 return{legacyDestination:{bankName:bank,cardLast4:card.length>4?card.slice(-4):null,nameMasked:name,phoneMasked:phone,accountMasked:account},restrictedSourceRef:ref,restrictedSourceDigest:sha(canonical(raw)),legacyOperatorId:typeof raw.admin_id==='string'&&/^\d{1,24}$/.test(raw.admin_id)?raw.admin_id:null,
  restrictedFields:Object.fromEntries(restrictedWithdrawalFields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,{present:raw[k]!==null&&raw[k]!=="",sha256:sha(canonical(raw[k]))}]))};
}

/** Additive source contract: original dataset/display bytes and all earlier observation fingerprints stay frozen. */
export async function prepareLocalFundsPlan({manifest,domainFile,mod,fundsSource,refundAttemptsSource,apiDist,emitEmptyChunk=null}) {
 const receiptBytes=readFileSync(join(manifest.source,"receipt.json"));
 if(sha(receiptBytes)!==manifest.sourceReceiptSha256)throw Error("FUNDS_CAPTURE_BINDING_CHANGED");
 const receipt=JSON.parse(receiptBytes),canonical=mod("supply/content-hash").canonicalize;
 const selected={};
 for(const domain of ["users","accounts","orders"]){selected[domain]=new Map();for await(const row of readBoundSourceRows(domainFile(domain),manifest.files[domain])){
  if(typeof row.sourceId!=="string"||selected[domain].has(row.sourceId))throw Error("FUNDS_SELECTED_SOURCE_DUPLICATE:"+domain);
  selected[domain].set(row.sourceId,row);
 }}
  const selectedCounts = {};
  const source = {}, continuationCommissionSource = [];
  const verifyContinuation=manifest.domains?.continuations?.preparedEvidence?.policy===NEXT_CONTINUATION_POLICY;
  for(const domain of ["accounts","orders","earnings","withdraws","distributionOrders","pays","refunds",...(verifyContinuation?['tradePolicy']:[])]){
  const file=receipt.files[domain];if(!file||file.file!==basename(file.file))throw Error("FUNDS_SOURCE_FILE_CHANGED:"+domain);
  source[domain]=[];
  for await(const row of readBoundSourceRows(join(manifest.source,file.file),file)){
   if(domain==='distributionOrders'&&selected.orders.has(row.order_id))continuationCommissionSource.push(row);
   const keep=domain==='tradePolicy'?true:domain==="accounts"||domain==="orders"?selected[domain].has(row.id):domain==="pays"?(row.order_type==="1"?selected.orders.has(row.order_id):row.order_type==="2"&&selected.accounts.has(row.order_id)):selected.users.has(row.user_id);
   if(keep)source[domain].push(row);
  }
  const domainMeta = manifest.domains[domain] ?? {};
  // A domain marked as retained source-relation evidence keeps its full-source count, so the selected
  // count is not comparable to it; record it instead of asserting equality against a different scope.
  const retainedAsEvidence = String(domainMeta.disposition ?? "").startsWith("RETAINED_SOURCE_RELATION_EVIDENCE");
  const expected = domain==='tradePolicy'?file.rows:domainMeta.selected ?? domainMeta.source;
  if (!retainedAsEvidence && source[domain].length !== expected) throw Error("FUNDS_SELECTED_DENOMINATOR_CHANGED:" + domain);
  selectedCounts[domain] = source[domain].length;
}
let supplementSha256 = null;
if (fundsSource) {
  const bytes = readFileSync(join(fundsSource.path, "receipt.json"));
  if(sha(bytes)!==fundsSource.sha256)throw Error("FUNDS_SUPPLEMENT_SHA_CHANGED");
  const supplement=JSON.parse(bytes);
  if(supplement.containerId!==receipt.containerId||supplement.database!==receipt.database||supplement.status!=="CAPTURED_READ_ONLY"||!supplement.rollbackConfirmed||!supplement.clientClosed||supplement.sourceSupplement?.baseReceiptSha256!==manifest.sourceReceiptSha256||supplement.sourceSupplement?.fullSourcePopulation!==true)throw Error("FUNDS_SUPPLEMENT_ORIGIN_NOT_CONFIRMED");
  supplementSha256=fundsSource.sha256;
  for(const domain of ["accounts","earnings","withdraws"]){
   const file=supplement.files[domain],comparison=supplement.sourceSupplement.domains?.[domain];
   if(!comparison||comparison.remainingIds!==0||comparison.comparedRows!==receipt.files[domain].rows||comparison.expectedCommonSha256!==comparison.actualCommonSha256)throw Error("FUNDS_SUPPLEMENT_SOURCE_COMPARISON_NOT_CLOSED:"+domain);
   if(!file||file.file!==basename(file.file)||file.rows!==receipt.files[domain].rows)throw Error("FUNDS_SUPPLEMENT_FILE_CHANGED:"+domain);
   const prior=new Map(source[domain].map(row=>[row.id,row])),replacement=[];
   for await(const row of readBoundSourceRows(join(fundsSource.path,file.file),file)){
    const original=prior.get(row.id);if(!original)continue;
    for(const [key,value]of Object.entries(original))if(canonical(value)!==canonical(row[key]))throw Error("FUNDS_SUPPLEMENT_COMMON_FIELD_DRIFT:"+domain+":"+key);
    replacement.push(row);prior.delete(row.id);
   }
   if(prior.size||replacement.length!==source[domain].length)throw Error("FUNDS_SUPPLEMENT_SELECTED_SET_CHANGED:"+domain);
   source[domain]=replacement;
  }
 }
 const orderById=new Map(source.orders.map(r=>[r.id,r])),accountById=new Map(source.accounts.map(r=>[r.id,r]));
 const refundAttempts=new Map(),refundFlags=new Map();let refundAttemptReceiptSha256=null,refundAttemptCoverage=null;
 if(refundAttemptsSource){
  const bytes=readFileSync(join(refundAttemptsSource.path,"receipt.json"));if(sha(bytes)!==refundAttemptsSource.sha256)throw Error("REFUND_ATTEMPT_RECEIPT_CHANGED");
  const extra=JSON.parse(bytes);if(extra.status!=="CAPTURED_READ_ONLY"||!extra.rollbackConfirmed||!extra.clientClosed||extra.containerId!==receipt.containerId||extra.database!==receipt.database||extra.sourceSupplement?.baseReceiptSha256!==manifest.sourceReceiptSha256||extra.files.refunds?.sha256!==receipt.files.refunds.sha256)throw Error("REFUND_ATTEMPT_SOURCE_BINDING_CHANGED");
  for(const [name,file] of Object.entries(extra.files))if(file.file!==basename(file.file)||(!['refundLogs','sourceParentBindings'].includes(name)&&await fileSha(join(refundAttemptsSource.path,file.file))!==file.sha256))throw Error("REFUND_ATTEMPT_FILE_CHANGED");
  refundAttemptReceiptSha256=refundAttemptsSource.sha256;
  const parents=new Map(source.refunds.map(row=>[row.id,row])),seen=new Set(),statusCounts={},amount=mod("finance/personal-finance-read").sourceYuanToCents;let total=0n;
  for await(const raw of readBoundSourceRows(join(refundAttemptsSource.path,extra.files.refundLogs.file),extra.files.refundLogs)){
   const parent=parents.get(raw.record_id);if(!parent||seen.has(raw.id))throw Error("REFUND_ATTEMPT_PARENT_OR_ID_NOT_CLOSED");seen.add(raw.id);
   const child={sourceEntity:'la_refund_log',sourceId:raw.id,sourceRecordId:raw.record_id,legacyUserId:raw.user_id,legacyOperatorId:raw.handle_id,sourceNumber:raw.sn,amountCents:amount(raw.refund_amount),orderAmountCents:amount(raw.order_amount),sourceStatus:raw.refund_status,createdEpoch:raw.create_time,updatedEpoch:raw.update_time,subjectMatchesParent:raw.user_id===parent.user_id,sourceDigest:sha(canonical(raw)),restrictedSourceRef:'restricted-refund-attempt:'+refundAttemptsSource.sha256+':la_refund_log:'+raw.id,messagePresence:raw.refund_msg===null?'NULL':raw.refund_msg===''?'EMPTY':'PRESENT',messageSha256:sha(canonical(raw.refund_msg))};
   if(!refundAttempts.has(raw.record_id))refundAttempts.set(raw.record_id,[]);refundAttempts.get(raw.record_id).push(child);statusCounts[raw.refund_status]=(statusCounts[raw.refund_status]??0)+1;total+=BigInt(child.amountCents);
  }
  if(seen.size!==extra.files.refundLogs.rows)throw Error("REFUND_ATTEMPT_DENOMINATOR_CHANGED");
  for await(const row of readBoundSourceRows(join(refundAttemptsSource.path,extra.files.sourceParentBindings.file),extra.files.sourceParentBindings)){
   const parent=parents.get(row.record_id),order=parent?.order_type==='order'?orderById.get(parent.order_id):null;
   if(!seen.has(row.id)||row.parent_source_entity!=='la_refund_record'||!parent||parent.id!==row.parent_record_id||parent.user_id!==row.parent_user_id||parent.order_type!==row.parent_order_type||parent.order_id!==row.parent_order_id||!order||row.order_source_entity!=='la_order'||row.resolved_order_id!==order.id||['user_id','sale_user_id','order_sn','pay_money','order_status','is_delete'].some(k=>row['order_'+({order_sn:'sn',pay_money:'pay_money',order_status:'status',is_delete:'is_delete'}[k]??k)]!==order[k]))throw Error("REFUND_ATTEMPT_TYPED_PARENT_DRIFT");
  }
  const byOrder=new Map();for(const row of source.refunds){const key=row.order_type+':'+row.order_id;if(!byOrder.has(key))byOrder.set(key,[]);byOrder.get(key).push(row);}
  let multipleRefundOrders=0,exceedsSourceBasePaidOrders=0;
  for(const group of byOrder.values())if(group.length>1){
   multipleRefundOrders++;const flags=['MULTIPLE_REFUND_RECORDS_FOR_TYPED_ORDER'],original=orderById.get(group[0].order_id),sum=group.flatMap(p=>refundAttempts.get(p.id)??[]).filter(a=>a.sourceStatus==='1').reduce((n,a)=>n+BigInt(a.amountCents),0n);
   if(original&&sum>BigInt(amount(original.pay_money))){flags.push('SOURCE_REFUND_SUM_EXCEEDS_RECORDED_PAID_AMOUNT');exceedsSourceBasePaidOrders++;}
   for(const row of group)refundFlags.set(row.id,flags);
  }
  refundAttemptCoverage={selected:seen.size,planned:seen.size,writer:0,recordedAmountCents:total.toString(),statusCounts,multipleRefundOrders,exceedsSourceBasePaidOrders,externalUnrecordedCalls:'UNKNOWN'};
 }
 const toolFiles=Object.fromEntries(["local-funds-plan.mjs","local-source-adapter.mjs","local-opening-proof.mjs","local-load-checkpoint.mjs","local-target-finance.mjs","readback-local-dataset.mjs"].map(name=>[name,sha(readFileSync(new URL(name,import.meta.url)))]));
 const compiledModules=apiDist?Object.fromEntries(["finance/legacy-finance-source-preparation","finance/personal-finance-observation-maintenance","finance/personal-finance-coverage","finance/personal-finance-read","finance/legacy-invitation-facts","finance/legacy-invitation-facts-maintenance"].map(name=>[name,sha(readFileSync(join(apiDist,name+".js")))])):null;
 const binding={refundAttemptReceiptSha256,toolFiles,compiledModules,supplementSha256,datasetManifestSha256:sha(readFileSync(join(dirname(domainFile("users")),"manifest.json"))),schema:"legacy-funds-supplement.v1",captureReceiptSha256:manifest.sourceReceiptSha256,sourceCutoff:manifest.sourceCutoff,sourceFiles:Object.fromEntries(Object.keys(source).map(d=>[d,receipt.files[d].sha256])),selectedFiles:Object.fromEntries(["users","accounts","orders"].map(d=>[d,manifest.files[d].sha256]))};
 const cutoff=new Date(manifest.sourceCutoff).toISOString();
 const {toolFiles:executionTools,compiledModules:executionModules,...sourceBinding}=binding;
 const inputSha256=sha(canonical(sourceBinding)),groups=new Map(),summary={};
 // The old listing deposit (order_type=2) is out of scope: it is neither rental money nor a current
 // platform fact, so it is counted once and never turned into a historical payment observation.
 const listingDepositPays=source.pays.filter(raw=>raw.order_type==="2");
 const rentalPays=source.pays.filter(raw=>raw.order_type==="1");
 const scopeSource=domain=>domain==="pays"?rentalPays:source[domain];
 for(const domain of ["earnings","withdraws","distributionOrders","pays","refunds"]){
  const seen=new Set();
  for(const raw of scopeSource(domain)){
   let subjectId=raw.user_id;
   if(domain==="pays")subjectId=raw.order_type==="1"?orderById.get(raw.order_id)?.user_id:accountById.get(raw.order_id)?.user_id;
   if(domain==="refunds"&&raw.order_type!=="order")throw Error("FUNDS_REFUND_TYPE_UNKNOWN");
   const subject=selected.users.get(subjectId);if(!subject||seen.has(raw.id))throw Error("FUNDS_SUBJECT_OR_SOURCE_ID_INVALID:"+domain);seen.add(raw.id);
   const order=domain==='refunds'?orderById.get(raw.order_id):undefined;
   const refundLinked=isPreparedRefundRelationshipVerified(raw,order,manifest.refundRelationshipPolicy);
   const observed=domain==="pays"||domain==="refunds"?{kind:domain==="pays"?"HISTORICAL_PAYMENT":"HISTORICAL_REFUND",row:{...raw,userId:subjectId,relationship:domain==="pays"||refundLinked?"VERIFIED":"UNRESOLVED"}}:sourceFinanceObservation(domain,raw);
   if(domain==="withdraws"&&fundsSource)Object.assign(observed.row,safeLegacyWithdrawalEvidence(raw,"restricted-funds-source:"+fundsSource.sha256+":la_withdraw_apply:"+raw.id,canonical));
   if(domain==='refunds'&&refundAttemptsSource)Object.assign(observed.row,{refundAttempts:refundAttempts.get(raw.id)??[],sourceRefundFlags:refundFlags.get(raw.id)??[]});
   const key=subject.userId+":"+observed.kind;
   if(!groups.has(key))groups.set(key,{subject:{userId:subject.userId,legacyUserId:subjectId,identityDigest:subject.sourceDigest},sourceKind:observed.kind,domain,rows:[]});
   groups.get(key).rows.push(observed.row);
  }
  summary[domain]={selected:scopeSource(domain).length,planned:0,writer:0,recordedAmountCents:"0",statusCounts:{}};
  for(const raw of scopeSource(domain)){
   const amount=domain==="earnings"?raw.change_amount:domain==="withdraws"?raw.money:domain==="distributionOrders"?raw.earnings:domain==="pays"?raw.pay_money:raw.refund_amount;
   summary[domain].recordedAmountCents=(BigInt(summary[domain].recordedAmountCents)+BigInt(mod("finance/personal-finance-read").sourceYuanToCents(amount))).toString();
   const status=raw.status??raw.pay_is??raw.refund_status??raw.action;summary[domain].statusCounts[status]=(summary[domain].statusCounts[status]??0)+1;
  }
  if(domain==="distributionOrders")summary[domain].originalLevels=Object.fromEntries(["1","2","3"].map(level=>[level,source[domain].filter(r=>r.level===level).length]));
  if(domain==="refunds")summary[domain].unresolvedAssociations=source[domain].filter(r=>orderById.get(r.order_id)?.user_id!==r.user_id||orderById.get(r.order_id)?.order_sn!==r.order_sn).length;
 }
 const history=[];
 for(const group of groups.values()){
  let input;try{input=mod("finance/legacy-finance-source-preparation").prepareFrozenFinanceHistory({...group,inputSha256,cutoff,sourceCount:group.rows.length,isolated:[]});}catch(e){throw new Error("FUNDS_HISTORY_PLAN_REFUSED:"+group.domain+":"+String(e.message),{cause:e});}
  const plan=mod("finance/personal-finance-observation-maintenance").planFinanceObservations(input);
  summary[group.domain].planned+=plan.observations.length;
  history.push({sourceId:group.subject.legacyUserId+":"+group.sourceKind,domain:group.domain,input});
 }
 const emptySink=createEmptyCoverageSink({onChunk:emitEmptyChunk});
 const kinds={earnings:'HISTORICAL_EARNINGS_LOG',withdraws:'HISTORICAL_WITHDRAWAL',distributionOrders:'HISTORICAL_DISTRIBUTION',pays:'HISTORICAL_PAYMENT',refunds:'HISTORICAL_REFUND'};
 for(const [domain,sourceKind]of Object.entries(kinds)){
  summary[domain].coverageSelected=selected.users.size;summary[domain].nonemptyCoverage=history.filter(row=>row.domain===domain).length;summary[domain].emptyCoverage=0;
  for(const [legacyUserId,user]of selected.users)if(!groups.has(user.userId+":"+sourceKind)){
   const input=mod("finance/legacy-finance-source-preparation").prepareFrozenFinanceHistory({subject:{userId:user.userId,legacyUserId,identityDigest:user.sourceDigest},sourceKind,inputSha256,cutoff,sourceCount:0,rows:[],isolated:[]});
   emptySink.push({sourceId:legacyUserId+":"+sourceKind,domain,input});summary[domain].emptyCoverage++;
  }
  summary[domain].coveragePlanned=summary[domain].nonemptyCoverage+summary[domain].emptyCoverage;
  if(summary[domain].coveragePlanned!==selected.users.size)throw Error("FUNDS_COVERAGE_SUBJECT_SET_GAP:"+domain);
 }
 // Owner decision: the old platform has no outstanding listing deposit, so the new platform neither
 // migrates nor displays it. Nothing here becomes a target fact; the count stays only so the report
 // can prove the exclusion was deliberate rather than a silent gap.
 const guaranteeHistory=[];
 const listingDepositExclusion={schema:"zzsh.listing-deposit-exclusion.v1",policy:"NOT_MIGRATED_OWNER_CONFIRMED_NO_OUTSTANDING",
  sourcePayments:listingDepositPays.length,sourcePaymentAmountCents:listingDepositPays.reduce((n,raw)=>n+BigInt(mod("finance/personal-finance-read").sourceYuanToCents(raw.pay_money)),0n).toString(),
  sourceAccountsWithPaidMark:source.accounts.filter(raw=>raw.pay_is==="1").length,sourceAccountsWithReturnMark:source.accounts.filter(raw=>raw.return_is==="1").length,targetRows:0};
 let completedPending=0,continuationPending=0,pendingAmount=0n;const pendingSource=new Map();
 for(const row of source.distributionOrders)if(row.status==="1"&&row.is_delete==="0"){
  if(verifyContinuation&&(row.order_type!=='1'||pendingSource.has(row.id)))throw Error('FUNDS_PENDING_COMMISSION_SOURCE_INVALID');pendingSource.set(row.id,row);
  const parent=orderById.get(row.order_id);if(parent?.order_status==="4")completedPending++;else if(["3","8","9"].includes(parent?.order_status))continuationPending++;else throw Error("FUNDS_PENDING_COMMISSION_PARENT_NOT_CLOSED");
  pendingAmount+=BigInt(mod("finance/personal-finance-read").sourceYuanToCents(row.earnings));
 }
 const continuationRows=[];for await(const row of readBoundSourceRows(domainFile("continuations"),manifest.files.continuations))continuationRows.push(row);
 const pendingRows=[];for await(const row of readBoundSourceRows(domainFile("pending-commissions"),manifest.files["pending-commissions"]))pendingRows.push(row);
 if(verifyContinuation)assertPendingCommissionCoverage(pendingRows,pendingSource);
 const continuationPolicy=manifest.domains?.continuations?.preparedEvidence;
 if(verifyContinuation){
  if(continuationPolicy.commissionPolicy!==NEXT_CONTINUATION_COMMISSION_POLICY)throw Error('CONTINUATION_COMMISSION_POLICY_UNPROVEN');
  assertContinuationSourceCoverage(continuationRows,source);
  assertContinuationCommissionCoverage(continuationRows,continuationCommissionSource,manifest.sourceRef);
 }
 const continuationPendingRows=continuationRows.reduce((n,r)=>n+r.source.commissions.filter(c=>c.status==='1').length,0);
 if(pendingRows.length!==completedPending+continuationPending||continuationPendingRows!==continuationPending)throw Error("FUNDS_PENDING_COMMISSION_WRITER_SOURCE_GAP");
 const pendingCommissionCoverage={selected:pendingRows.length,completedDutyCandidates:completedPending,continuationEvidence:continuationPending,recordedAmountCents:pendingAmount.toString(),targetDuties:"TARGET_PARENT_AND_RECEIPT_CHECK_REQUIRED"};
 summary.guarantees={selected:0,planned:0,writer:0,policyExcluded:true,listingDeposit:listingDepositExclusion};
 for(const [domain,count]of Object.entries(summary))if(count.selected!==count.planned)throw Error("FUNDS_SOURCE_PLAN_MISMATCH:"+domain);
 if(refundAttemptCoverage){refundAttemptCoverage.writer=history.filter(r=>r.domain==='refunds').reduce((n,r)=>n+r.input.observations.reduce((m,o)=>m+(o.sourceAttempts?.length??0),0),0);if(refundAttemptCoverage.writer!==refundAttemptCoverage.selected)throw Error("REFUND_ATTEMPT_WRITER_COVERAGE_GAP");}
 const emptyCoverage=emptySink.finish();
 return{binding,inputSha256,history,emptyHistory:emptyCoverage.entries,emptyCoverage:emptyCoverage.manifest,emptyChunks:emptyCoverage.chunks,guaranteeHistory,listingDepositExclusion,summary,pendingCommissionCoverage,refundAttemptCoverage};
}

/** Called with the exact frozen phase items handed to runItems, before the first writer is invoked. */
export function assertFundsWriterCoverage(plan,history,guarantees,emptyHistory=plan.emptyHistory??[]){
 if(sha(JSON.stringify(history))!==sha(JSON.stringify(plan.history))||sha(JSON.stringify(guarantees))!==sha(JSON.stringify(plan.guaranteeHistory)))throw Error("FUNDS_WRITER_SOURCE_SET_CHANGED");
 const streamedEmpty=emptyHistory?.schema==="zzsh.empty-coverage-chunks.v1";
 if(streamedEmpty){if(!plan.emptyCoverage||plan.emptyCoverage.digest!==emptyHistory.digest||plan.emptyCoverage.rows!==emptyHistory.rows||plan.emptyCoverage.chunks!==emptyHistory.chunks)throw Error("FUNDS_EMPTY_COVERAGE_SOURCE_SET_CHANGED");}
 else if(sha(JSON.stringify(emptyHistory))!==sha(JSON.stringify(plan.emptyHistory??[])))throw Error("FUNDS_EMPTY_COVERAGE_SOURCE_SET_CHANGED");
 const summary=structuredClone(plan.summary);
 for(const row of history){if(!summary[row.domain])throw Error("FUNDS_WRITER_DOMAIN_UNKNOWN");summary[row.domain].writer+=row.input.observations.length;}
 for(const [domain,count]of Object.entries(summary))if(domain!=="guarantees"&&count.coverageSelected!==undefined){count.coverageWriter=history.filter(r=>r.domain===domain).length+(streamedEmpty?emptyHistory.domainRows?.[domain]??0:emptyHistory.filter(r=>r.domain===domain).length);if(count.coverageWriter!==count.coverageSelected)throw Error("FUNDS_COVERAGE_WRITER_SET_GAP:"+domain);}
 summary.guarantees.writer=guarantees.reduce((n,g)=>n+g.input.rows.length,0);
 for(const [domain,count]of Object.entries(summary))if(count.selected!==count.planned||count.planned!==count.writer)throw Error("FUNDS_WRITER_COVERAGE_MISMATCH:"+domain);
 return summary;
}
