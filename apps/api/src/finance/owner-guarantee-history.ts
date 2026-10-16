import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {SecurityApiError} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid,conflict} from '../supply/supply-util';
import {prepareFinanceSourceSet} from './personal-finance-coverage';
import {sourceYuanToCents,exactCents,decodeFinanceCursor,encodeFinanceCursor} from './personal-finance-read';
import type {ListingCursorKey} from '../supply/listing-cursor';
import {assertAdminContextInTransaction} from '../auth/auth-security';
import {loadEffectiveAdminAccess,requirePermission,ADMIN_PERMISSION} from '../auth/admin-authorization';
import {readAdminGameScope,assertGameScopeUsable,gameScopeSql} from '../auth/admin-scope';
import {notFound} from '../supply/supply-util';

export type LegacyGuaranteeAccountSource=Record<string,string|null|number>;
export type LegacyGuaranteeHistoryInput={userId:string;legacyUserId:string;accountId:string|null;source:LegacyGuaranteeAccountSource;payOrders:Record<string,string|null>[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),oldId=/^[1-9]\d{0,23}$/,newId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Owner guarantee finance source is inconsistent');
const accountFields=['id','user_id','no','status','is_delete','pay_is','pay_money','pay_time','create_pay_time','pay_way','order_sn','leshua_order_id','yj_order_id','transaction_id','return_is','service_id','team_id','base_bot','update_time','pay_url_present'];
const paymentFields=['id','order_id','order_type','pay_way','pay_order_sn','pay_money','pay_is','pay_time','create_time'];
/** CF-3's existing classification, kept as source observations. It cannot create held balance, refund or eligibility. */
export function prepareOwnerGuaranteeHistory(value:LegacyGuaranteeHistoryInput){
 const i=JSON.parse(JSON.stringify(value)) as LegacyGuaranteeHistoryInput;
 if(!i||typeof i.userId!=='string'||!newId.test(i.userId)||!oldId.test(i.legacyUserId)||i.accountId!==null&&!newId.test(i.accountId)||!i.source||!Array.isArray(i.payOrders)||i.payOrders.length>1000)throw invalid('Exact owner guarantee source binding required');
 ensureOnlyFields(i,['userId','legacyUserId','accountId','source','payOrders']);ensureOnlyFields(i.source,accountFields);
 const s=i.source;if(typeof s.id!=='string'||!oldId.test(s.id)||s.user_id!==i.legacyUserId||typeof s.pay_money!=='string'||!['0','1'].includes(String(s.pay_is))||s.return_is!==null&&s.return_is!=='1')throw invalid('Historical account guarantee fields invalid');
 const current=sourceYuanToCents(s.pay_money),seen=new Set<string>();
 const payments=i.payOrders.map(p=>{ensureOnlyFields(p,paymentFields);if(!oldId.test(p.id??'')||p.order_id!==s.id||p.order_type!=='2'||!['0','1'].includes(p.pay_is??'')||seen.has(p.id!))throw invalid('Guarantee attempts must bind typed account source, not rental order');seen.add(p.id!);return{source:p,amount:sourceYuanToCents(p.pay_money),digest:sha(canonicalize(p))};});
 const paid=payments.filter(p=>p.source.pay_is==='1'),trace=s.pay_time!==null&&s.pay_time!==undefined&&s.pay_time!==''&&s.pay_time!=='0';
 const classification=s.return_is==='1'?(current==='0'?'ZERO_AMOUNT_RETURN_MARK':'SOURCE_RETURN_MARK_CHANNEL_UNKNOWN'):
  paid.length?(s.pay_is==='1'?'SOURCE_PAID_REFUND_UNKNOWN':'PAID_RECORD_RESET_REFUND_UNKNOWN'):current==='0'&&s.pay_is==='1'?'ZERO_AMOUNT_PAID_MARK':
  current!=='0'&&s.pay_is==='1'?'PAID_MARK_WITHOUT_PAY_ORDER_UNKNOWN':trace?'HISTORICAL_TRACE_UNKNOWN':'NO_PAYMENT_EVIDENCE_UNKNOWN';
 const conflicts=[...(paid.length>1?['MULTIPLE_PAID_ATTEMPTS']:[]),...(paid.some(p=>p.amount!==current)?['CURRENT_AMOUNT_DIFFERS_FROM_PAID_ATTEMPT']:[])];
 const canonical=canonicalize(i);
 return{...i,sourceId:s.id,sourceCanonical:canonical,sourceDigest:sha(canonical),accountSourceDigest:sha(canonicalize(s)),classification,conflicts,
  accountFieldCents:current,paidRecordCents:paid.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),paidRecordCount:String(paid.length),
  observedSourcePaid:paid.length?'SOURCE_PAID_RECORD':s.pay_is==='1'?'SOURCE_PAID_MARK_ONLY':trace?'SOURCE_CALLBACK_TIME_ONLY':'NOT_EVIDENCED',
  payments:payments.map(p=>({source:{type:'LEGACY_MYSQL',system:'legacy_mysql_restore',entity:'la_pay_order',id:p.source.id},sourceDigest:p.digest,sourceStatus:p.source.pay_is,amountCents:p.amount,merchantOrderNumber:p.source.pay_order_sn||null,sourcePaidAt:sourceTime(p.source.pay_time),sourceCreatedAt:sourceTime(p.source.create_time),channelArrival:'UNKNOWN' as const})),
  liability:{knowledge:'UNKNOWN' as const,amountCents:null,reason:'HISTORICAL_PAYMENT_IS_NOT_CURRENT_HELD_PROOF'},refund:{knowledge:'UNKNOWN' as const,amountCents:null,reason:'NO_TYPED_ACCOUNT_REFUND_EVIDENCE'},channelArrival:'UNKNOWN' as const};
}
function sourceTime(value:unknown){if(value===null||value===undefined||value===''||value==='0')return null;if(typeof value!=='string'||!/^\d{1,10}$/.test(value)||BigInt(value)>4294967295n)throw invalid('Historical guarantee time unsupported');return new Date(Number(value)*1000).toISOString();}

export type OwnerGuaranteeHistoryBatch={userId:string;legacyUserId:string;identityDigest:string;inputSha256:string;cutoff:string;sourceCount:number;rows:LegacyGuaranteeHistoryInput[];isolated:{sourceId:string;sourceDigest:string;reason:string}[]};
/** Reuse the existing exact source-set coverage preparation; no generic new import/ledger engine. */
export function planOwnerGuaranteeHistoryBatch(input:OwnerGuaranteeHistoryBatch){
 if(!input||!Array.isArray(input.rows)||!Array.isArray(input.isolated)||!newId.test(input.userId)||!oldId.test(input.legacyUserId)||!['identityDigest','inputSha256'].every(k=>typeof input[k as keyof OwnerGuaranteeHistoryBatch]==='string'&&/^[a-f0-9]{64}$/.test(input[k as keyof OwnerGuaranteeHistoryBatch] as string))
  ||typeof input.cutoff!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.cutoff)||!Number.isFinite(Date.parse(input.cutoff)))throw invalid('Exact owner guarantee coverage binding required');
 ensureOnlyFields(input,['userId','legacyUserId','identityDigest','inputSha256','cutoff','sourceCount','rows','isolated']);
 const rows=input.rows.map(prepareOwnerGuaranteeHistory);
 if(rows.some(r=>r.userId!==input.userId||r.legacyUserId!==input.legacyUserId))throw invalid('Guarantee batch subject changed');
 const set=prepareFinanceSourceSet({sourceCount:input.sourceCount,imported:rows.map(r=>({sourceId:r.sourceId,sourceDigest:r.sourceDigest})),isolated:input.isolated});
 return{rows,coverage:{...set,id:'guarantee_coverage_'+sha(canonicalize([input.userId,input.cutoff])).slice(0,40),userId:input.userId,legacyUserId:input.legacyUserId,inputSha256:input.inputSha256,identityDigest:input.identityDigest,cutoff:input.cutoff,sourceKind:'OWNER_GUARANTEE_HISTORY',sourceEntity:'la_rental_accounts'},bodyDigest:sha(canonicalize(input)),key:'guarantee-history-'+sha(canonicalize([input.userId,input.cutoff])).slice(0,40)};
}

type AdminHistoryScope={actorId:string;isBoss:boolean;allGames:boolean;version:string};
/** Source-only history DTO. Current finance-held amount remains separate and never offsets historical observations. */
export async function readOwnerGuaranteeHistory(c:PoolClient,actor:{userId:string;sessionId:string},cursor:string|null,key:ListingCursorKey|undefined){return readHistory(c,actor,cursor,key);}
async function readHistory(c:PoolClient,actor:{userId:string;sessionId:string},cursor:string|null,key:ListingCursorKey|undefined,admin?:AdminHistoryScope){
 const installed=(await c.query(`/* owner guarantee history schema */ SELECT to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL AND to_regclass('zzsh_order.legacy_owner_guarantee_coverage') IS NOT NULL AS ready,
  to_regclass('zzsh_order.owner_guarantee_payment') IS NOT NULL AND to_regclass('zzsh_order.settlement_ledger_entry') IS NOT NULL AS native_ready`)).rows[0];
 if(typeof installed?.ready!=='boolean'||typeof installed.native_ready!=='boolean')throw unavailable();
 const native=installed.native_ready?await readPostedOwnerGuarantee(c,actor.userId,admin):{knowledge:'UNKNOWN' as const,amountCents:null,scope:'POSTED_LEDGER_ONLY' as const,reason:'GUARANTEE_FINANCE_SCHEMA_NOT_INSTALLED'};
 if(!installed.ready)return{contractVersion:'owner-guarantee-history.read.v1',subjectId:actor.userId,items:[],nextCursor:null,coverage:{knowledge:'UNKNOWN',count:null,reason:'HISTORY_NOT_INSTALLED'},postedHeld:native,liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN'};
 const coverage=(await c.query(`/* owner guarantee history coverage */ SELECT c.*,to_char(c.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff,
  (SELECT count(*)::text FROM zzsh_order.legacy_owner_guarantee_observation o WHERE o.user_id=c.user_id AND o.source_cutoff=c.source_cutoff) AS actual_count,
  (SELECT encode(sha256(convert_to(COALESCE(string_agg(o.legacy_account_id||':'||o.source_digest,chr(10) ORDER BY o.legacy_account_id COLLATE "C"),''),'UTF8')),'hex') FROM zzsh_order.legacy_owner_guarantee_observation o WHERE o.user_id=c.user_id AND o.source_cutoff=c.source_cutoff) AS actual_digest
  FROM zzsh_order.legacy_owner_guarantee_coverage c WHERE c.user_id=$1 ORDER BY c.source_cutoff DESC,c.id COLLATE "C" DESC LIMIT 1`,[actor.userId])).rows[0];
 if(!coverage)return{contractVersion:'owner-guarantee-history.read.v1',subjectId:actor.userId,items:[],nextCursor:null,coverage:{knowledge:'UNKNOWN',count:null,reason:'HISTORY_NOT_IMPORTED'},postedHeld:native,liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN'};
 if(coverage.actual_count!==String(coverage.imported_count)||coverage.actual_digest!==coverage.imported_set_digest||Number(coverage.source_count)!==Number(coverage.imported_count)+Number(coverage.isolated_count)||!/^[a-f0-9]{64}$/.test(coverage.body_digest))throw unavailable();
 const scoped=admin?(await c.query(`/* owner guarantee admin scoped counts */ SELECT count(*) FILTER(WHERE ${gameScopeSql('a.game_id','$3','$4')})::text AS visible_count,
  count(*) FILTER(WHERE a.id IS NULL)::text AS unmapped_count FROM zzsh_order.legacy_owner_guarantee_observation o LEFT JOIN zzsh_supply.rental_account a ON a.id=o.account_id WHERE o.user_id=$1 AND o.source_cutoff=$2::timestamptz`,[actor.userId,coverage.cutoff,admin.actorId,admin.isBoss])).rows[0]:null;
 if(admin&&(!scoped||!['visible_count','unmapped_count'].every(k=>typeof scoped[k]==='string'&&/^(0|[1-9]\d{0,8})$/.test(scoped[k]))))throw unavailable();
 const visibleCount=scoped?.visible_count??coverage.actual_count,complete=coverage.isolated_count===0&&(!admin||admin.allGames||scoped?.unmapped_count==='0');
 const snapshot='owner-guarantee-history.v1:'+sha(canonicalize([coverage.id,coverage.body_digest,admin?.version??null,native])),binding={userId:actor.userId,sessionHash:sha(actor.sessionId),snapshotVersion:snapshot,bucket:admin?'ADMIN_OWNER_GUARANTEE_HISTORY':'OWNER_GUARANTEE_HISTORY'},after=cursor?decodeFinanceCursor(cursor,binding,key):null;
 const asOf=after?.asOf??(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
 const rows=(await c.query(`/* owner guarantee history page */ SELECT o.id,o.account_id,o.legacy_account_id,o.source_canonical,o.source_digest,to_char(o.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM zzsh_order.legacy_owner_guarantee_observation o ${admin?'LEFT JOIN zzsh_supply.rental_account a ON a.id=o.account_id':''} WHERE o.user_id=$1 AND o.source_cutoff=$2::timestamptz AND o.imported_at<=$3::timestamptz
  AND($4::timestamptz IS NULL OR(o.imported_at,o.id COLLATE "C")<($4::timestamptz,$5 COLLATE "C")) ${admin?'AND '+gameScopeSql('a.game_id','$6','$7'):''} ORDER BY o.imported_at DESC,o.id COLLATE "C" DESC LIMIT 21`,[actor.userId,coverage.cutoff,asOf,after?.position.at??null,after?.position.id??null,...(admin?[admin.actorId,admin.isBoss]:[])])).rows;
 const visible=rows.slice(0,20),last=visible.at(-1),items=visible.map(row=>{let p:ReturnType<typeof prepareOwnerGuaranteeHistory>;try{p=prepareOwnerGuaranteeHistory(JSON.parse(row.source_canonical));}catch{throw unavailable();}if(p.userId!==actor.userId||p.sourceId!==row.legacy_account_id||p.accountId!==row.account_id||p.sourceDigest!==row.source_digest||p.sourceCanonical!==row.source_canonical)throw unavailable();return{id:row.id,accountId:p.accountId,legacyAccountId:p.sourceId,accountNumber:p.source.no??null,classification:p.classification,conflicts:p.conflicts,accountFieldCents:p.accountFieldCents,paidRecordCents:p.paidRecordCents,paidRecordCount:p.paidRecordCount,sourcePaidMark:p.source.pay_is,sourceReturnMark:p.source.return_is,sourcePaidAt:sourceTime(p.source.pay_time),payments:p.payments,liability:p.liability,refund:p.refund,channelArrival:p.channelArrival};});
 return{contractVersion:'owner-guarantee-history.read.v1',subjectId:actor.userId,asOf,snapshotVersion:snapshot,coverage:{knowledge:complete?'KNOWN':'UNKNOWN',count:complete?visibleCount:null,mappedRecordCount:visibleCount,reason:complete?'SOURCE_COMPLETE_THROUGH_CUTOFF':coverage.isolated_count!==0?'ISOLATED_ACCOUNT_SOURCES':'UNMAPPED_ACCOUNT_GAME_SOURCE',cutoff:coverage.cutoff},items,postedHeld:native,liability:{knowledge:'UNKNOWN',amountCents:null,reason:'HISTORICAL_PAYMENT_IS_NOT_CURRENT_HELD_PROOF'},channelArrival:'UNKNOWN',nextCursor:rows.length>20&&last?encodeFinanceCursor({id:last.id,at:last.at},asOf,binding,key):null};
}

export async function readPostedOwnerGuarantee(c:PoolClient,userId:string,admin?:AdminHistoryScope){
 const row=(await c.query(`/* owner guarantee posted held only */ SELECT COALESCE(sum(l.credit_cents-l.debit_cents),0)::text AS held
  FROM zzsh_order.settlement_ledger_entry l JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  ${admin?`LEFT JOIN zzsh_order.owner_guarantee_payment gp ON r.source_entity='owner_guarantee_payment' AND gp.id=r.source_id LEFT JOIN zzsh_order.owner_guarantee_refund gf ON r.source_entity='owner_guarantee_refund' AND gf.id=r.source_id JOIN zzsh_order.owner_guarantee_requirement gr ON gr.id=COALESCE(gp.requirement_id,gf.requirement_id) JOIN zzsh_supply.rental_account a ON a.id=gr.account_id AND a.owner_user_id=gr.owner_user_id`:''}
  WHERE l.counterparty_user_id=$1 AND l.account_code='GUARANTEE_HELD' AND r.source_kind='NATIVE_GUARANTEE' AND e.kind IN('GUARANTEE_CAPTURE','GUARANTEE_REFUND') ${admin?'AND '+gameScopeSql('a.game_id','$2','$3'):''}`,[userId,...(admin?[admin.actorId,admin.isBoss]:[])])).rows[0];
 if(!row)throw unavailable();const amount=exactCents(row.held);if(BigInt(amount)<0n)throw conflict('GUARANTEE_HELD_RECONCILIATION_REQUIRED');
 return{knowledge:'KNOWN' as const,amountCents:amount,scope:'POSTED_LEDGER_ONLY' as const,reason:'NATIVE_GUARANTEE_POSTINGS_ONLY'};
}

/** E supplies its existing target-object scope function; F owns current admin permission and scoped finance projection.
 * No self-user context/cookie, target header, or caller-authored isBoss can enter this function via HTTP. */
export async function readAdminOwnerGuaranteeHistory(c:PoolClient,actor:{userId:string;sessionId:string},targetUserId:string,cursor:string|null,key:ListingCursorKey|undefined,
 assertSubjectScope:(client:PoolClient,actor:{userId:string;isBoss:boolean},targetUserId:string)=>Promise<void>){
 if(typeof targetUserId!=='string'||!newId.test(targetUserId)||typeof assertSubjectScope!=='function')throw invalid('Bound target and domain object scope required');
 const authorize=async()=>{
  await assertAdminContextInTransaction(c,actor);const access=await loadEffectiveAdminAccess(c,actor.userId);requirePermission(access,ADMIN_PERMISSION.creditGuaranteeRead);
  if(access?.status!=='ACTIVE'||access.passwordChangeRequired)throw new SecurityApiError(403,'FORBIDDEN','Current guarantee read permission required');
  const games=await readAdminGameScope(c,actor.userId);assertGameScopeUsable(games,access.isBoss);await assertSubjectScope(c,{userId:actor.userId,isBoss:access.isBoss},targetUserId);
  if(!(await c.query('SELECT 1 FROM zzsh_auth_user."user" WHERE id=$1',[targetUserId])).rowCount)throw notFound();
  return{actorId:actor.userId,isBoss:access.isBoss,allGames:access.isBoss||games.mode==='ALL_GAMES',version:sha(canonicalize({actor:actor.userId,session:actor.sessionId,permissions:[...access.permissions].sort(),boss:access.isBoss,games}))};
 };
 const before=await authorize(),page=await readHistory(c,{userId:targetUserId,sessionId:canonicalize(['admin',actor.userId,actor.sessionId,before.version])},cursor,key,before),after=await authorize();if(before.version!==after.version)throw conflict('Admin guarantee scope changed; reload');
 return{...page,contractVersion:'admin-owner-guarantee-history.read.v1',adminActorId:actor.userId,contextKey:before.version};
}
