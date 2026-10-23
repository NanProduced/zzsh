import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {deriveAdminFinancePeriodBasis,readAdminFinancePeriodBasis} from '../src/finance/admin-finance-period-basis';

const filters={scope:'user-1',from:'2026-10-19',to:'2026-10-20',bucket:'ALL' as const,kind:'ALL',state:'ALL',q:''};
const original={user_id:'user-1',origin:'RECONCILED_OPENING',coverage_basis_id:'basis-1',opening_event_id:'event-1',basis_id:'basis-1',basis_user_id:'user-1',source_kind:'LEGACY_OPENING',source_system:'legacy_mysql_restore',source_entity:'la_user',source_id:'71',source_digest:'a'.repeat(64),source_cutoff:'2026-09-30T16:00:00.000001Z',native_zero:false,native_origin_verified:false,legacy_identity_verified:true,
 event_id:'event-1',event_kind:'OPENING',event_subject_id:'user-1',event_root_id:'root-1',opening_posted_at:'2026-10-19T00:00:00.000001Z',root_id:'root-1',root_basis_id:'basis-1',root_subject_id:'user-1',root_kind:'LEGACY_OPENING',root_type:'LEGACY_MYSQL',root_system:'legacy_mysql_restore',root_entity:'la_user',root_source_id:'71',root_role:'WALLET_HOLDER',root_digest:'a'.repeat(64)};
test('prior historical dates stay unknown despite covered observations; cutoff and opening time remain distinct',()=>{
 const r=deriveAdminFinancePeriodBasis({...filters,from:'2026-09-30'},original);assert.equal(r.knowledge,'UNKNOWN');assert.deepEqual(r.reasonCodes,['HISTORICAL_PERIOD_BALANCE_NOT_PROVABLE']);assert.equal(r.sourceCutoff,original.source_cutoff);assert.equal(r.openingPostedAt,original.opening_posted_at);
 assert.equal('covered_count' in r,false);assert.equal('balance' in r,false);
});
test('same Beijing opening day and subsequent periods can prove posted-ledger origin without querying or guessing balances',()=>{
 for(const from of ['2026-10-19','2026-10-20']){const r=deriveAdminFinancePeriodBasis({...filters,from},original);assert.equal(r.knowledge,'KNOWN');assert(r.reasonCodes.includes('POSTED_LEDGER_ONLY'));}
 // Source opening at 16:00 UTC belongs to the following Beijing day, irrespective of microseconds.
 const atMidnight={...original,opening_posted_at:'2026-10-18T16:00:00.000001Z'};assert.equal(deriveAdminFinancePeriodBasis(filters,atMidnight).knowledge,'KNOWN');assert.equal(deriveAdminFinancePeriodBasis({...filters,from:'2026-10-18'},atMidnight).knowledge,'UNKNOWN');
});
test('strict native genesis preserves proved zero but refuses a legacy basis, nonzero origin or unverifiable native source',()=>{
 const native={...original,origin:'NATIVE_GENESIS',source_kind:'NATIVE_GENESIS',root_kind:'NATIVE_GENESIS',root_type:'NATIVE',source_system:'zzsh-native-registration',root_system:'zzsh-native-registration',source_entity:'zzsh_auth_user.user',root_entity:'zzsh_auth_user.user',source_id:'user-1',root_source_id:'user-1',native_zero:true,native_origin_verified:true};
 assert.equal(deriveAdminFinancePeriodBasis(filters,native).knowledge,'KNOWN');
 for(const patch of [{native_zero:false},{native_origin_verified:false},{source_kind:'LEGACY_OPENING'},{source_id:'other'},{root_type:'LEGACY_MYSQL'}])assert.equal(deriveAdminFinancePeriodBasis(filters,{...native,...patch}).knowledge,'UNKNOWN');
});
test('missing coverage, mismatched user/root/basis/event or invalid original time never fabricate a proof',()=>{
 assert.equal(deriveAdminFinancePeriodBasis(filters,undefined).knowledge,'UNKNOWN');
 for(const patch of [{user_id:'other'},{basis_user_id:'other'},{basis_id:null},{event_id:null},{opening_event_id:'other'},{event_root_id:'other'},{root_basis_id:'other'},{root_subject_id:'other'},{root_digest:'b'.repeat(64)},{root_kind:'OTHER'},{event_kind:'SETTLED'},{legacy_identity_verified:false},{opening_posted_at:null},{source_cutoff:null},{source_cutoff:'2026-10-20T00:00:00Z'},{opening_posted_at:'2026-02-30T00:00:00Z'}])assert.equal(deriveAdminFinancePeriodBasis(filters,{...original,...patch}).knowledge,'UNKNOWN',JSON.stringify(patch));
});
test('ALL subjects or business subsets make no proof query; selecting a ledger bucket preserves exact-subject origin',async()=>{
 let queries=0;const c={query:async(sql:string,args:unknown[])=>{queries++;assert.deepEqual(args,['user-1']);assert(sql.includes('WHERE c.user_id=$1'));assert(!/sum\(|min\(|settlement_ledger_entry/i.test(sql));return{rows:[original]};}} as never;
 for(const patch of [{scope:'ALL'},{kind:'WITHDRAWAL'},{state:'POSTED'},{q:'a business number'}]){const r=await readAdminFinancePeriodBasis(c,{...filters,...patch});assert.equal(r.knowledge,'UNKNOWN');assert.equal(queries,0);}
 assert.equal((await readAdminFinancePeriodBasis(c,{...filters,bucket:'AVAILABLE'})).knowledge,'KNOWN');assert.equal(queries,1);
});
test('one exact query detects missing or ambiguous evidence and propagates actual SQL/permission failure',async()=>{
 for(const rows of [[],[original,original]]){let queries=0;const c={query:async()=>{queries++;return{rows};}} as never;assert.equal((await readAdminFinancePeriodBasis(c,filters)).knowledge,'UNKNOWN');assert.equal(queries,1);}
 const c={query:async()=>{throw Object.assign(Error('denied'),{code:'42501'});}} as never;await assert.rejects(readAdminFinancePeriodBasis(c,filters),(e:any)=>e.code==='42501');
});
