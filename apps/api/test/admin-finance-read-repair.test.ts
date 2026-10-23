import {test} from 'node:test';
import assert from 'node:assert/strict';
import {financeDocuments,financePeriodProjection,projectAdminFinanceLedger,projectAdminFinanceObservation,parseAdminFinanceFilters,ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql,filterAdminFinanceEntries,loadAdminFinanceFacts,readAdminFinanceDocument} from '../src/finance/admin-finance-read';
import {generateAdminFinanceCsv} from '../src/finance/admin-finance-export';
import {financeVersionSql,scopedFinanceSql,financeLookupPageSql} from '../src/finance/admin-finance-query';
import {FinanceSqlFixture,legacyFinanceOrder} from './admin-finance-fixture';

const line=(overrides:Record<string,unknown>={})=>projectAdminFinanceLedger({id:'refund',account_code:'RENTER_REFUND_PAYABLE',subject_id:'renter',subject_name:'租客',delta:'5000',at:'2026-10-19T11:51:00.000000Z',recorded_at:'2026-10-19T11:51:00.002000Z',posting_id:'posting',order_id:'order',display_no:'ZZ-1',source_entity:'settlement_posting',...overrides});

test('order document root is stable across refund-first and owner-first slices',()=>{
 const a=line(),b=line({id:'owner',account_code:'OWNER_AVAILABLE',subject_id:'owner',delta:'9000'});
 for(const entries of [[a,b],[b,a],[a],[b]]){
  const doc=financeDocuments(entries)[0]!;
  assert.equal(doc.kind,'SETTLEMENT');assert.equal(doc.state,'POSTED');assert.equal(doc.ref,'ORDER:order');
 }
 assert.deepEqual(financeDocuments([a,b]),financeDocuments([b,a]));
});

test('R1 polymorphic distribution log cannot match an unrelated old order solely through a coincident referenceId',()=>{
 const entry=projectAdminFinanceObservation({id:'distribution-log',source_entity:'la_log_earnings',source_type:'LEGACY_MYSQL',source_system:'source-A',source_id:'99',subject_id:'u1',amount:'1.00',action:'1',reference_id:'42',extra_evidence:{snapshot:{legacyChangeType:1001}},at:null});
 entry.historical!.association={state:'MATCHED',kind:'DISTRIBUTION',documentRef:'HISTORY_DISTRIBUTION:correct',number:'DISTRIBUTION-NUMBER',path:null,role:'BENEFICIARY',originalStatus:'2',originalStatusLabel:'旧平台已结算'};
 const order={ref:'LEGACY_ORDER:unrelated',id:'unrelated',number:'ORDER-NUMBER-42',sourceType:'LEGACY_MYSQL',sourceSystem:'source-A',sourceId:'42',ownerId:'u1',renterId:'u2'} as any;
 for(const q of ['ORDER-NUMBER-42','ORDER_LINK:unrelated']){const filters=parseAdminFinanceFilters(new URLSearchParams({q,period:'0'}),new Date(),false),facts={entries:[entry],orders:[order],subjects:[],revisions:[],withdrawalsReady:false,version:'v',asOf:''};assert.deepEqual(filterAdminFinanceEntries(facts,filters,false),[]);}
});
test('R1 SQL count and page locate the old order root without deriving unverified polymorphic log membership',()=>{
 const fixture=new FinanceSqlFixture({history:[{id:'distribution-log',source_type:'LEGACY_MYSQL',source_entity:'la_log_earnings',source_system:'source-A',subject_id:'u1',source_id:'99',reference_id:'42',extra_evidence:{snapshot:{legacyChangeType:1001}}}],legacy:[legacyFinanceOrder('unrelated',{source_system:'source-A',legacy_id:'42',owner_user_id:'u1',original_order_no:'ORDER-NUMBER-42'})]});
 try{for(const q of ['ORDER-NUMBER-42','ORDER_LINK:unrelated']){const filters=parseAdminFinanceFilters(new URLSearchParams({q,period:'0'}),new Date(),false),page=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({}),{legacy_orders:true},{filters,lookup:{exact:false},page:1,pageSize:20});const rows=fixture.query(page.text,page.values).rows;assert.equal(Number(rows[0]!.document_count),1);assert.equal(Number(rows[0]!.entry_count),0);assert.deepEqual(rows.map(row=>row.ref),['LEGACY_ORDER:unrelated']);}}
 finally{fixture.close();}
});
function zeroAccrualFixture(){
 const before='2026-10-18T15:59:59.999999Z',after='2026-10-18T16:00:00.000001Z',digest='b'.repeat(64);
 const fixture=new FinanceSqlFixture({earnings:[{id:'zero-root',economic_root_id:'zero-root',beneficiary_user_id:'u1',beneficiary_role:'OWNER_REFERRAL',amount_cents:'0',state:'SETTLED',funds_disposition:'SETTLED',version:'2',seed_digest:'a'.repeat(64),posting_digest:digest,order_id:'order-1',created_at:before,due_at:after}]});
 fixture.db.prepare('INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,created_at) VALUES(?,?,?,?,?)').run('accrue-event','zero-root','EARNING_PENDING','u1',after);
 fixture.db.prepare('INSERT INTO zzsh_order.rental_referral_transition(id,earning_id,action,expected_version,result_version,finance_event_id,source_digest) VALUES(?,?,?,?,?,?,?)').run('accrue-receipt','zero-root','ACCRUE','0','1','accrue-event',digest);
 return{fixture,before,after};
}
test('R1 zero native earning uses the original ACCRUE event day while keeping earning creation only as recordedAt',()=>{
 const {fixture,before,after}=zeroAccrualFixture();
 try{const source=adminFinanceObservationSql({native_distribution:true});for(const [day,count] of [['2026-10-18',0],['2026-10-19',1]] as const){const filters=parseAdminFinanceFilters(new URLSearchParams({from:day,to:day,kind:'DISTRIBUTION'})),q=scopedFinanceSql(source,'history',{filters},20,false),rows=fixture.query(q.text,q.values).rows;assert.equal(rows.length,count);if(rows.length){const r=projectAdminFinanceObservation(rows[0]!);assert.equal(r.occurredAt,after);assert.equal(r.evidence.recordedAt,before);assert.equal(r.evidence.eventAction,'ACCRUE');assert.equal(r.deltaCents,'0');}}}
 finally{fixture.close();}
});
test('R1 missing or ambiguous zero-earning ACCRUE proof does not fall back to root creation time',()=>{
 for(const ambiguous of [false,true]){const {fixture}=zeroAccrualFixture();try{
  if(ambiguous)fixture.db.exec("INSERT INTO zzsh_order.rental_referral_transition SELECT 'duplicate',earning_id,action,expected_version,result_version,finance_event_id,source_digest FROM zzsh_order.rental_referral_transition");else fixture.db.exec('DELETE FROM zzsh_order.rental_referral_transition');
  const source=adminFinanceObservationSql({native_distribution:true}),q=scopedFinanceSql(source,'history',{documentRef:'DISTRIBUTION:zero-root'},20,false),row=fixture.query(q.text,q.values).rows[0]!;assert.equal(row.at,null);const projected=projectAdminFinanceObservation(row);assert.equal(projected.occurredAt,null);assert.equal(projected.evidence.eventAction,null);assert(projected.reasonCodes.includes('ORIGINAL_ACCRUAL_EVENT_UNAVAILABLE'));
 }finally{fixture.close();}}
});
test('R1 zero legacy duty shares its joined finance event clock and retains later fact recording time across midnight',()=>{
 const before='2026-10-18T15:59:59.999999Z',after='2026-10-18T16:00:00.000001Z',fixture=new FinanceSqlFixture();
 fixture.db.prepare('INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,created_at) VALUES(?,?,?,?,?)').run('duty-event','duty-root','LEGACY_DUTY_SETTLED','u1',before);
 fixture.db.prepare('INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,subject_user_id,facts_digest,created_at,kind,order_id,ref_type,ref_id,event_id,root_id,amount_cents,zero_finalization) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('duty-zero','u1','digest',after,'RENTER_REFUND','legacy-order','FINANCE_EVENT','duty-event','duty-event','duty-root','0',1);
 fixture.db.prepare('INSERT INTO zzsh_order.legacy_order_duty(id,status,settled_by,settled_ref_type,settled_ref_id,settled_ref_digest) VALUES(?,?,?,?,?,?)').run('duty-zero','SETTLED','FINANCE','FINANCE_EVENT','duty-event','digest');
 try{const source=adminFinanceObservationSql({legacy_duty_finance:true}),query=scopedFinanceSql(source,'history',{documentRef:'LEGACY_DUTY:duty-zero'},20,false),row=fixture.query(query.text,query.values).rows[0]!,entry=projectAdminFinanceObservation(row);assert.equal(entry.occurredAt,before);assert.equal(entry.evidence.recordedAt,after);assert.equal(entry.evidence.eventKind,'LEGACY_DUTY_SETTLED');
  const facts={entries:[entry],subjects:[],revisions:[],withdrawalsReady:false,asOf:after,version:'v'};for(const [day,count]of [['2026-10-18',1],['2026-10-19',0]]as const){const filters=parseAdminFinanceFilters(new URLSearchParams({from:day,to:day}));assert.equal(filterAdminFinanceEntries(facts,filters,true).length,count);}assert.equal(entry.deltaCents,'0');assert.equal(entry.affectsCurrentLedger,false);
 }finally{fixture.close();}
});
test('R1 formatted and NFKC phone tokens are refused by finance GET without matching substrings of long business numbers',()=>{
 for(const q of ['+86 (138) 1234-5678','138.1234.5678','１３８１２３４５６７８','客服：＋８６（１３８）１２３４－５６７８','13812345678请核对'])assert.throws(()=>parseAdminFinanceFilters(new URLSearchParams({q})),(e:any)=>e.status===400,q);
 for(const q of ['20260630184504906252','１３８１２３４５６７８０１２３４５６７','ORDER:1381234567890123456','user_aa13812345678bb0123456789abcdef012345678','13812345-678a-4abc-8abc-0123456789ab','ORDER:order_aa13812345678bb0123456789abcdef012345678','http://127.0.0.1:4221/users/user_aa13812345678bb0123456789abcdef012345678'])assert.equal(parseAdminFinanceFilters(new URLSearchParams({q})).q,q);
 for(const q of ['备注user_aa13812345678bb0123456789abcdef012345678','http://13812345678.example/users/user_aa13812345678bb0123456789abcdef012345678','http://127.0.0.1:4221/users/user_aa13812345678bb0123456789abcdef012345678?q=13812345678'])assert.throws(()=>parseAdminFinanceFilters(new URLSearchParams({q})),(e:any)=>e.status===400,q);
});
test('R2 changed read semantics invalidate before-r2 content versions even when every source table is unchanged',()=>{
 const fixture=new FinanceSqlFixture();try{const current=financeVersionSql({});assert(current.includes("'admin-finance-proof.r2'"));const old=current.replace("'admin-finance-proof.r2'","'admin-finance-proof.before-r2'");assert.notEqual(fixture.query(current,[]).rows[0]!.finance_version,fixture.query(old,[]).rows[0]!.finance_version);}finally{fixture.close();}
});
test('R1 omitted period basis remains UNKNOWN despite complete book arithmetic',()=>{
 const row=financePeriodProjection([],[{bucket:'AVAILABLE',opening:'0',closing:'0',movement:'0'}]).find(row=>row.bucket==='AVAILABLE')!;assert.equal(row.knowledge,'UNKNOWN');assert.equal(row.openingBalance,null);assert.equal(row.closingBalance,null);assert.equal(row.difference,null);assert.equal(row.ledgerDifference,'0');
});
test('R1 finance scope cannot carry a clear phone while full typed and canonical UUID identities remain usable',()=>{
 assert.throws(()=>parseAdminFinanceFilters(new URLSearchParams({scope:'13812345678'})),(e:any)=>e.status===400);
 for(const scope of ['user_aa13812345678bb0123456789abcdef012345678','13812345-678a-4abc-8abc-0123456789ab'])assert.equal(parseAdminFinanceFilters(new URLSearchParams({scope})).scope,scope);
});
test('period retains known book arithmetic but does not invent historical balance proof',()=>{
 const basis={knowledge:'UNKNOWN',origin:'RECONCILED_OPENING',sourceCutoff:'2026-09-13T13:31:22.000000Z',openingPostedAt:'2026-10-19T11:00:00.000000Z',reasonCodes:['HISTORICAL_PERIOD_BALANCE_NOT_PROVABLE']};
 const rows=(financePeriodProjection as any)([],[{bucket:'AVAILABLE',opening:'0',closing:'0',movement:'0'}],basis);
 const row=rows.find((r:any)=>r.bucket==='AVAILABLE');assert.equal(row.knowledge,'UNKNOWN');assert.equal(row.openingBalance,null);assert.equal(row.closingBalance,null);assert.equal(row.difference,null);assert.equal(row.ledgerOpeningBalance,'0');assert.equal(row.ledgerDifference,'0');
});
test('withdrawal business classification preserves the old earnings record identity and effect',()=>{
 for(const code of ['1002','1003','1004','1005']){
  const row=projectAdminFinanceObservation({id:'old-log',source_entity:'la_log_earnings',source_system:'legacy_mysql_restore',source_type:'LEGACY_MYSQL',source_id:'77',subject_id:'owner',subject_name:'号主',amount:'734.00',action:code==='1002'?'2':'1',included_in_opening:true,at:null,imported_at:'2026-10-19T00:00:00.000000Z',extra_evidence:{snapshot:{legacyChangeType:code}}});
  assert.equal(row.kind,'WITHDRAWAL');assert.equal(row.documentRef,'HISTORY_EARNINGS:old-log');assert.equal(row.affectsCurrentWallet,false);assert.equal(row.affectsCurrentLedger,false);
 }
});
test('finance GET rejects phone tokens and preserves long public business numbers',()=>{
 assert.throws(()=>parseAdminFinanceFilters(new URLSearchParams({q:'19900000000'})),(e:any)=>e.status===400);
 assert.throws(()=>parseAdminFinanceFilters(new URLSearchParams({q:'客服:19900000000'})),(e:any)=>e.status===400);
 assert.equal(parseAdminFinanceFilters(new URLSearchParams({q:'20260630184504906252'})).q,'20260630184504906252');
});
test('Admin ledger uses one authoritative posting/event time and separately retains line recording time',()=>{
 assert.match(ADMIN_FINANCE_LEDGER_SQL,/CASE WHEN l\.finance_event_id IS NOT NULL THEN e\.created_at ELSE p\.posted_at END/);
 assert.match(ADMIN_FINANCE_LEDGER_SQL,/AS recorded_at/);
});
test('subject summaries name only their own entry count and keep the full document count unknown',()=>{
 const entry=line(),doc=financeDocuments([entry],'SUBJECT')[0]!;assert.equal(doc.summaryScope,'SUBJECT');assert.equal(doc.subjectEntryCount,1);assert.equal(doc.documentEntryCount,null);assert.equal(doc.kind,'SETTLEMENT');
});
test('known ledger arithmetic does not convert unknown event time into proved balances; legitimate known zero and opening survive',()=>{
 const known={knowledge:'KNOWN' as const,origin:'NATIVE_GENESIS',sourceCutoff:'2026-10-19T00:00:00.000000Z',openingPostedAt:'2026-10-19T00:00:00.000000Z',reasonCodes:['POSTED_LEDGER_ONLY']};
 const zero=financePeriodProjection([],[],known).find(r=>r.bucket==='AVAILABLE')!;assert.equal(zero.knowledge,'KNOWN');assert.equal(zero.openingBalance,'0');
 const opening=line({event_kind:'OPENING',basis_id:'basis',account_code:'WALLET_AVAILABLE',delta:'18000'}),r=financePeriodProjection([opening],[{bucket:'AVAILABLE',opening:'0',closing:'18000',movement:'18000'}],known).find(r=>r.bucket==='AVAILABLE')!;assert.equal(r.migrationMovement,'18000');assert.equal(r.closingBalance,'18000');assert.equal(r.difference,'0');
 const missing=line({account_code:'WALLET_AVAILABLE',delta:'0',at:null}),unknown=financePeriodProjection([missing],[],known).find(r=>r.bucket==='AVAILABLE')!;assert.equal(unknown.knowledge,'UNKNOWN');assert.equal(unknown.openingBalance,null);assert.equal(unknown.ledgerDifference,'0');
});
test('same authoritative posting day keeps all lines together and CSV retains original recording time',()=>{
 const before='2026-10-18T15:59:59.999999Z',after='2026-10-18T16:00:00.000001Z';
 const a=line({account_code:'OWNER_AVAILABLE',delta:'-100',at:before,recorded_at:before}),b=line({id:'credit',account_code:'WALLET_AVAILABLE',delta:'100',at:before,recorded_at:after});
 const f=parseAdminFinanceFilters(new URLSearchParams('from=2026-10-18&to=2026-10-18')),facts={entries:[a,b],subjects:[],revisions:[],withdrawalsReady:false,version:'v',asOf:after};
 const selected=filterAdminFinanceEntries(facts,f,true);assert.equal(selected.length,2);assert.equal(selected.reduce((n,e)=>n+BigInt(e.deltaCents!),0n),0n);
 const csv=generateAdminFinanceCsv(selected,f,after,'v').bytes.toString();assert(csv.includes(after));assert.equal(b.evidence.recordedAt,after);assert.equal(b.occurredAt,before);
});
test('SQL withdrawal filter includes 1002 through 1005 while preserving every original history reference',()=>{
 const fixture=new FinanceSqlFixture({history:['1001','1002','1003','1004','1005','1006','1007','1008','1009'].map(code=>({id:'log-'+code,subject_id:'u1',source_type:'LEGACY_MYSQL',source_entity:'la_log_earnings',source_id:code,extra_evidence:{snapshot:{legacyChangeType:code}}}))});
 try{const f=parseAdminFinanceFilters(new URLSearchParams('kind=WITHDRAWAL&period=0'),new Date(),false),sql=scopedFinanceSql('SELECT * FROM fixture_history','history',{filters:f},20001,false),rows=fixture.query(sql.text,sql.values).rows;assert.deepEqual(rows.map(r=>r.source_id),['1002','1003','1004','1005']);}
 finally{fixture.close();}
});
test('raw legacy IDs do not derive order search membership; exact links remain in verified detail evidence',()=>{
 const row={id:'original',subject_id:'u1',source_type:'LEGACY_MYSQL',source_system:'source-A',source_entity:'la_log_earnings',source_id:'log1',reference_id:'71',extra_evidence:{snapshot:{legacyChangeType:'1001'}}};
 const fixture=new FinanceSqlFixture({history:[row,{...row,id:'other-source',source_system:'source-B'},{...row,id:'other-owner',subject_id:'u2'}],legacy:[legacyFinanceOrder('old-order',{source_system:'source-A',legacy_id:'71',owner_user_id:'u1',original_order_no:'OLD-NUMBER'})]});
 try{for(const q of ['OLD-NUMBER','ORDER_LINK:old-order']){const f=parseAdminFinanceFilters(new URLSearchParams({q,period:'0'}),new Date(),false),sql=scopedFinanceSql('SELECT * FROM fixture_history','history',{filters:f},20001,false);assert.deepEqual(fixture.query(sql.text,sql.values).rows.map(r=>r.id),[]);}}
 finally{fixture.close();}
});
test('source-content version includes event clock, actual frozen basis and transitions without unrelated cluster state',()=>{
 const sql=financeVersionSql({native_distribution:true});for(const text of ['finance_event','created_at','posted_at','canonical_seed','canonical_basis','rental_referral_transition','opening_event_id','native_origin_canonical'])assert(sql.includes(text));assert(!/pg_current_snapshot|count\(|max\(/i.test(sql));
});
test('loaded native roots batch their event receipts once, expose calculation only on detail and never choose one document-level event',async()=>{
 const seen:string[]=[],rows=['pending-a','pending-b','settled-a','settled-b'].map((id,n)=>({id,account_code:n<2?'WALLET_PENDING_EARNINGS':'WALLET_AVAILABLE',subject_id:'referrer',subject_name:'推荐人',delta:n%2===0?'-95':'95',at:'2026-10-19T11:51:00.000000Z',finance_event_id:n<2?'event-accrue':'event-settle',event_kind:n<2?'EARNING_PENDING':'EARNING_SETTLED',source_kind:'NATIVE_RENTAL_REFERRAL',source_type:'NATIVE',source_entity:'rental_order',source_id:'order',economic_root_id:'earning-1',order_id:'order',earning_state:'SETTLED',earning_role:'OWNER_REFERRAL',earning_amount:'95',earning_due_at:'2026-10-19T11:51:00.000000Z'}));
 const client={query:async(sql:string)=>{seen.push(sql);
  if(sql.startsWith('SELECT to_regclass'))return{rows:[{ready:true,native_distribution:true,earning_basis:true,earning_transitions:true}]};
  if(sql.includes('AS finance_version'))return{rows:[{finance_version:'frozen-fixture-version'}]};
  if(sql.includes('clock_timestamp()'))return{rows:[{at:'2026-10-19T11:51:00.000000Z'}]};
  if(sql.startsWith('WITH finance_scoped_rows'))return{rows:sql.includes('settlement_ledger_entry')?rows:[]};
  if(sql.startsWith('SELECT id,COALESCE(name'))return{rows:[{id:'referrer',name:'推荐人'}]};
  if(sql.includes('FROM zzsh_order.rental_referral_transition'))return{rows:[['event-accrue','ACCRUE','EARNING_PENDING','0','1'],['event-settle','SETTLE','EARNING_SETTLED','1','2']].map(([event_id,action,kind,expected_version,result_version])=>({event_id,action,kind,expected_version,result_version,earning_id:'earning-1',economic_root_id:'earning-1',subject_user_id:'referrer',beneficiary_user_id:'referrer',source_digest:'a'.repeat(64)}))};
  if(sql.includes('FROM zzsh_order.rental_referral_earning e'))return{rows:[{id:'earning-1',canonical_basis:null}]};
  throw Error('unexpected core query');}} as never;
 const facts=await loadAdminFinanceFacts(client,{documentRef:'DISTRIBUTION:earning-1'}),detail=readAdminFinanceDocument(facts,'DISTRIBUTION:earning-1');
 assert.deepEqual(detail.entries.map(e=>e.evidence.eventAction),['ACCRUE','ACCRUE','SETTLE','SETTLE']);assert.equal(detail.evidence.eventAction,null);assert.equal(detail.evidence.eventId,null);assert.equal(detail.document.state,'SETTLED');assert.equal(detail.distributionCalculation?.knowledge,'UNKNOWN');assert(!('distributionCalculation' in detail.entries[0]!));
 assert.equal(seen.filter(sql=>sql.startsWith('SELECT t.finance_event_id')).length,1);assert.equal(seen.filter(sql=>sql.startsWith('SELECT e.id,e.order_id')).length,1);assert(detail.entries.every(e=>e.related.length===0),'missing object read projection cannot leak domain links');
 seen.length=0;const list=await loadAdminFinanceFacts(client);assert.equal(list.distributionCalculation,undefined);assert.equal(seen.filter(sql=>sql.startsWith('SELECT e.id,e.order_id')).length,0);
});
