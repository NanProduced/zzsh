import { createHash } from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const grouped=(rows,key)=>{const result=new Map();for(const row of rows){const k=row[key];if(!result.has(k))result.set(k,[]);result.get(k).push(row);}return result;};

// Read complete evidence per bounded batch without one database round trip per subject.
export async function readSystemOpeningBatch(query,inputs,{actor,window,fenceEpochs,canonical,openingPlanCore,systemOpeningReview,fingerprintRequest}){
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>200||!Array.isArray(fenceEpochs)||!fenceEpochs.length
  ||fenceEpochs.some(v=>!/^[a-f0-9]{64}$/.test(v)))throw new Error('SYSTEM_OPENING_READBACK_BINDING_REQUIRED');
 const plans=inputs.map(input=>({input,plan:openingPlanCore(input)}));
 if(new Set(plans.map(x=>x.plan.basisId)).size!==plans.length)throw new Error('SYSTEM_OPENING_READBACK_DUPLICATE_SUBJECT');
 const ids=plans.map(x=>x.plan.basisId),events=plans.map(x=>x.plan.eventId),scope=JSON.stringify(['system',actor.id,'finance.opening.import',null]);
 const base=(await query(`SELECT x.basis_id AS key,b.user_id,b.source_kind,b.source_system,b.source_entity,b.source_id,b.identity_source_digest,b.source_digest,b.available_cents::text,
  to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff,b.covered_count,b.covered_set_digest,
  r.id AS root_id,r.source_kind AS root_kind,r.source_type AS root_type,r.source_system AS root_system,r.source_entity AS root_entity,r.source_id AS root_source_id,r.subject_user_id AS root_subject,r.beneficiary_role AS root_role,r.source_digest AS root_digest,
  e.id AS event_id,e.kind AS event_kind,e.subject_user_id AS event_subject,w.origin AS wallet_origin,w.basis_id AS wallet_basis,w.opening_event_id AS wallet_event,
  v.body_digest,v.source_canonical,v.input_canonical,v.review_canonical,v.review_digest,
  i.request_fingerprint,i.response_status,i.response_body,i.publish_required
 FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) x(basis_id,root_id,event_id,receipt_key)
 LEFT JOIN zzsh_order.finance_opening_basis b ON b.id=x.basis_id
 LEFT JOIN zzsh_order.finance_economic_root r ON r.id=x.root_id AND r.basis_id=b.id
 LEFT JOIN zzsh_order.finance_event e ON e.id=x.event_id AND e.economic_root_id=r.id
 LEFT JOIN zzsh_order.wallet_coverage w ON w.user_id=b.user_id
 LEFT JOIN zzsh_order.finance_stored_opening_review v ON v.basis_id=b.id
 LEFT JOIN zzsh_supply.idempotency_record i ON i.scope_key=$5 AND i.key=x.receipt_key`,[ids,plans.map(x=>x.plan.rootId),events,plans.map(x=>x.plan.key),scope])).rows;
 const covered=(await query(`SELECT basis_id,jsonb_build_array(user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,extract(epoch FROM source_event_at)::bigint::text,source_digest) AS row
 FROM zzsh_order.finance_covered_event WHERE basis_id=ANY($1::text[]) ORDER BY basis_id COLLATE "C",source_kind COLLATE "C",source_type COLLATE "C",source_entity COLLATE "C",source_id COLLATE "C",beneficiary_role COLLATE "C"`,[ids])).rows;
 const observations=(await query(`SELECT a.basis_id,a.user_id,a.source_system,a.legacy_user_id,a.source_entity,a.source_id,a.source_digest,
  to_char(a.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS event_at,a.included_in_opening,
  o.user_id AS obs_user,o.basis_id AS obs_basis,o.source_kind AS obs_kind,o.source_type AS obs_type,o.source_system AS obs_system,o.legacy_user_id AS obs_legacy,
  o.source_digest AS obs_digest,o.source_canonical AS obs_canonical,o.snapshot AS obs_snapshot,o.included_in_opening AS obs_included,
  to_char(o.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS obs_event_at
 FROM zzsh_order.finance_observation_admission a LEFT JOIN zzsh_order.personal_finance_observation o
  ON o.source_type='LEGACY_MYSQL' AND o.source_system=a.source_system AND o.source_entity=a.source_entity AND o.source_id=a.source_id
 WHERE a.basis_id=ANY($1::text[]) ORDER BY a.basis_id COLLATE "C",a.source_entity COLLATE "C",a.source_id COLLATE "C"`,[ids])).rows;
 const extras=(await query(`SELECT o.basis_id,o.source_entity,o.source_id FROM zzsh_order.personal_finance_observation o
 LEFT JOIN zzsh_order.finance_observation_admission a ON a.basis_id=o.basis_id AND a.user_id=o.user_id AND a.source_system=o.source_system AND a.source_entity=o.source_entity AND a.source_id=o.source_id
 WHERE o.basis_id=ANY($1::text[]) AND a.basis_id IS NULL`,[ids])).rows;
 const ledger=(await query(`SELECT finance_event_id,line_no,account_code,debit_cents::text,credit_cents::text,counterparty_user_id,details
 FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ANY($1::text[]) ORDER BY finance_event_id COLLATE "C",line_no`,[events])).rows;
 const audits=(await query(`SELECT object_id,actor_type,actor_id,session_id,request_id,legacy_migration_manifest_sha256,details FROM zzsh_iam.audit_event
 WHERE action='finance.opening.imported' AND object_type='finance_event' AND outcome='SUCCESS' AND object_id=ANY($1::text[])`,[events])).rows;
 const byBase=grouped(base,'key'),byCovered=grouped(covered,'basis_id'),byObs=grouped(observations,'basis_id'),byExtra=grouped(extras,'basis_id'),byLedger=grouped(ledger,'finance_event_id'),byAudit=grouped(audits,'object_id');
 return plans.map(({input,plan})=>{
  const p=input.proof,found=byBase.get(plan.basisId)??[],row=found[0],auditRows=byAudit.get(plan.eventId)??[];
  if(found.length!==1||!row||auditRows.length!==1)return{subjectId:p.userId,matched:false};
  let review;try{review=JSON.parse(row.review_canonical);}catch{return{subjectId:p.userId,matched:false};}
  const epoch=review?.actor?.fenceEpochSha256,audit=auditRows[0],details=audit.details??{};
  const expectedReview=fenceEpochs.includes(epoch)?systemOpeningReview(input,{...actor,fenceEpochSha256:epoch},window):null;
  const same=(a,b)=>canonical(a)===canonical(b);
  const original=row.user_id===p.userId&&row.source_kind==='LEGACY_OPENING'&&row.source_system===p.source.sourceSystem&&row.source_entity==='la_user'&&row.source_id===p.source.sourceId
   &&row.identity_source_digest===p.source.identityDigest&&row.source_digest===p.sourceDigest&&row.available_cents===p.availableCents&&row.cutoff===new Date(input.cutoff).toISOString()
   &&row.covered_count===p.coveredCount&&row.covered_set_digest===p.coveredDigest&&row.root_id===plan.rootId&&row.root_kind==='LEGACY_OPENING'&&row.root_type==='LEGACY_MYSQL'
   &&row.root_system===p.source.sourceSystem&&row.root_entity==='la_user'&&row.root_source_id===p.source.sourceId&&row.root_subject===p.userId&&row.root_role==='WALLET_HOLDER'&&row.root_digest===p.sourceDigest
   &&row.event_id===plan.eventId&&row.event_kind==='OPENING'&&row.event_subject===p.userId&&row.wallet_origin==='RECONCILED_OPENING'&&row.wallet_basis===plan.basisId&&row.wallet_event===plan.eventId
   &&row.body_digest===plan.bodyDigest&&row.source_canonical===input.sourceCanonical&&row.input_canonical===canonical(input)&&expectedReview!==null&&row.review_canonical===expectedReview&&row.review_digest===sha(expectedReview)
   &&row.request_fingerprint===fingerprintRequest('finance.opening.import',p.userId,input)&&row.response_status===200&&row.publish_required===false
   &&same(row.response_body,{eventId:plan.eventId,subjectId:p.userId,bodyDigest:plan.bodyDigest});
  const auditOk=audit.actor_type==='system'&&audit.actor_id===actor.id&&audit.session_id===null&&audit.request_id===actor.requestId&&audit.legacy_migration_manifest_sha256===actor.sourceDatasetSha256
   &&details.bodyDigest===plan.bodyDigest&&details.inputSha256===input.inputSha256&&details.executionRef===window.ref&&details.attempt===window.attempt
   &&details.sourceSystem==='legacy_mysql_restore'&&details.sourceEntity==='la_user'&&details.legacyId===p.source.sourceId&&details.sourceDigest===p.sourceDigest
   &&details.subjectId===p.userId&&details.fenceEpochSha256===epoch&&details.sourceDatasetSha256===actor.sourceDatasetSha256;
  const coveredOk=same((byCovered.get(plan.basisId)??[]).map(x=>x.row),p.coveredSet);
  const expectedObservations=[...plan.observations].sort((a,b)=>a.sourceEntity<b.sourceEntity?-1:a.sourceEntity>b.sourceEntity?1:a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0),actualObs=byObs.get(plan.basisId)??[];
  const observationsOk=!byExtra.has(plan.basisId)&&actualObs.length===expectedObservations.length&&expectedObservations.every((o,index)=>{
   const a=actualObs[index];return a.user_id===p.userId&&a.source_system===o.sourceSystem&&a.legacy_user_id===o.legacyUserId&&a.source_entity===o.sourceEntity&&a.source_id===o.sourceId
    &&a.source_digest===o.sourceDigest&&a.event_at===o.sourceEventAt&&a.included_in_opening===o.includedInOpening&&a.obs_user===p.userId&&a.obs_kind===o.sourceKind&&a.obs_type==='LEGACY_MYSQL'
    &&a.obs_system===o.sourceSystem&&a.obs_legacy===o.legacyUserId&&a.obs_digest===o.sourceDigest&&a.obs_canonical===o.sourceCanonical&&a.obs_event_at===o.sourceEventAt
    &&same(a.obs_snapshot,JSON.parse(o.sourceCanonical))&&(a.obs_basis===plan.basisId&&a.obs_included===o.includedInOpening||a.obs_basis===null&&a.obs_included===false);
  });
  const ledgerDetails={basisId:plan.basisId,economicRootId:plan.rootId,sourceDigest:p.sourceDigest};
  const expectedLedger=p.availableCents==='0'?[]:[{line_no:1,account_code:'LEGACY_OPENING_SOURCE',debit_cents:p.availableCents,credit_cents:'0',counterparty_user_id:null,details:ledgerDetails},
   {line_no:2,account_code:'WALLET_AVAILABLE',debit_cents:'0',credit_cents:p.availableCents,counterparty_user_id:p.userId,details:ledgerDetails}];
  const actualLedger=(byLedger.get(plan.eventId)??[]).map(({finance_event_id,...fields})=>fields);
  return{subjectId:p.userId,matched:original&&auditOk&&coveredOk&&observationsOk&&same(actualLedger,expectedLedger)};
 });
}
