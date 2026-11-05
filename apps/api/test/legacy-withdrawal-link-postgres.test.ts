import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from 'pg';
import { canonicalize } from '../src/supply/content-hash';
import { financeLookupPageSql } from '../src/finance/admin-finance-query';
import { attachLegacyWithdrawalBusinessReferences, parseAdminFinanceFilters, type FinanceEntry } from '../src/finance/admin-finance-read';

// Explicit isolated synthetic database only. It must already be registered and have
// the minimal source schema plus migration 0157 installed; this test never uses R05/R06.
test('withdrawal evidence closes before pagination, remains searchable and fails closed',async()=>{
  assert.equal(process.env.LW_CERT_TEST_DATABASE,'zzsh_test_lwcert');
  const oid=process.env.LW_CERT_TEST_OID, passwordFile=process.env.LW_CERT_TEST_PASSWORD_FILE;
  assert.match(oid??'',/^[1-9]\d*$/);assert.ok(passwordFile);
  const config={host:'127.0.0.1',port:55432,database:'zzsh_test_lwcert',user:'zzsh',password:readFileSync(passwordFile!,'utf8').trim(),statement_timeout:5000,lock_timeout:500,application_name:'withdrawal-link-pg-test'};
  const client=new Client(config);await client.connect();
  let tx=false;
  try{
    const identity=(await client.query("SELECT oid::text oid,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
    assert.equal(identity.oid,oid);assert.equal(identity.marker,'zzsh:legacy-withdrawal-link-test:v1');
    await client.query('BEGIN');tx=true;await client.query('SET LOCAL ROLE zzsh_lwcert_m');
    const suffix=randomBytes(6).toString('hex'),user='fixture_'+suffix;
    const base=1000000+parseInt(suffix.slice(0,8),16)*100;
    await client.query('INSERT INTO zzsh_auth_user."user"(id) VALUES($1)',[user]);
    const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
    const proof=(entity:string,x:Record<string,unknown>)=>{const canonical=canonicalize(x);return{entity,canonical,digest:sha(canonical)};};
    const boundary=Date.parse('2023-11-14T16:00:00.000Z')/1000;
    const parentRaw={id:base,sn:'WITHDRAW-'+suffix,money:'100.00',status:4,userId:base+1,create_time:boundary-1,handling_fee:'0.00',left_money:'100.00'};
    const debitRaw={id:base+2,sn:'LOG-'+suffix,action:2,amount:'100.00',userId:base+1,sourceId:base,createdAt:boundary,changeType:1002,leftAmount:'0.00'};
    const parent={kind:'withdrawObservation',sourceId:base,sourceUserId:base+1,amount:parentRaw.money,sourceStatus:4,createdAt:parentRaw.create_time,fee:parentRaw.handling_fee,net:parentRaw.left_money,referenceId:String(base),referenceSn:parentRaw.sn,rawSource:proof('la_withdraw_apply',parentRaw)};
    const debit={kind:'earningsLog',sourceId:base+2,sourceUserId:base+1,amount:debitRaw.amount,leftAmount:debitRaw.leftAmount,action:2,createdAt:debitRaw.createdAt,referenceId:String(base),referenceSn:parentRaw.sn,legacyChangeType:1002,legacyLogNumber:debitRaw.sn,rawSource:proof('la_log_earnings',debitRaw),sourceSupplement:proof('la_log_earnings',{...debitRaw,sourceSn:parentRaw.sn})};
    const add=async(id:string,entity:string,sourceId:number,snap:Record<string,unknown>)=>{
      const canonical=canonicalize(snap);
      await client.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,snapshot)
       VALUES($1,$2,$3,'LEGACY_MYSQL','legacy_mysql_restore',$4,$5,$6,$7,$8::text,to_timestamp($9),$8::text::jsonb)`,
       [id,user,entity==='la_withdraw_apply'?'HISTORICAL_WITHDRAWAL':'HISTORICAL_EARNINGS_LOG',String(base+1),entity,String(sourceId),sha(canonical),canonical,snap.createdAt]);
    };
    const returnRaw={...debitRaw,id:base+5,sn:'RETURN-'+suffix,action:1,createdAt:boundary+1,changeType:1003,leftAmount:'100.00'};
    const returned={...debit,sourceId:base+5,leftAmount:returnRaw.leftAmount,action:1,createdAt:returnRaw.createdAt,legacyChangeType:1003,legacyLogNumber:returnRaw.sn,rawSource:proof('la_log_earnings',returnRaw),sourceSupplement:proof('la_log_earnings',{...returnRaw,sourceSn:parentRaw.sn})};
    const parentId='p_'+suffix,debitId='d_'+suffix,returnId='r_'+suffix;
    await add(parentId,'la_withdraw_apply',base,parent);await add(debitId,'la_log_earnings',base+2,debit);await add(returnId,'la_log_earnings',base+5,returned);
    const certify=async()=>String((await client.query('SELECT zzsh_order.certify_legacy_withdrawal_link($1) outcome',[parentId])).rows[0].outcome);
    assert.equal(await certify(),'CREATED');assert.equal(await certify(),'REPLAY');
    const ledger=`SELECT NULL::text id,NULL::text account_code,NULL::text subject_id,NULL::text subject_name,NULL::text event_kind,
      NULL::text source_entity,NULL::text source_kind,NULL::text beneficiary_role,NULL::text earning_state,NULL::text source_id,NULL::text order_id,NULL::text basis_id,NULL::text economic_root_id,
      NULL::text posting_id,NULL::text display_no,NULL::text at WHERE FALSE`;
    const history=`SELECT o.id,o.user_id subject_id,o.user_id subject_name,o.source_kind,o.source_type,o.source_system,o.source_entity,o.source_id,
      to_char(o.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,o.snapshot->>'referenceSn' reference_no,o.snapshot->>'action' action,o.snapshot->>'sourceStatus' source_status,
      'LEGACY_MYSQL'::text observation_origin,o.snapshot extra_evidence FROM zzsh_order.personal_finance_observation o`;
    const lookup=async(q='',allowed=true,page=1,day?:string)=>{
      const params=new URLSearchParams({scope:user,...(q?{q}:{}),...(day?{period:'1',from:day,to:day}:{period:'0'})}),filters=parseAdminFinanceFilters(params,new Date(),false);
      const query=financeLookupPageSql(ledger,history,{legacy_withdrawal_links:true},{filters,lookup:{exact:false,withdrawalLinkRead:allowed},page,pageSize:1},true);
      return (await client.query(query.text,query.values)).rows;
    };
    let rows=await lookup();assert.equal(rows[0].ref,'HISTORY_WITHDRAWAL:'+parentId);assert.equal(rows[0].document_count,'1');assert.equal(rows[0].entry_count,'3');
    rows=await lookup(debitRaw.sn);assert.equal(rows[0].ref,'HISTORY_WITHDRAWAL:'+parentId);assert.equal(rows[0].document_count,'1');
    rows=await lookup(returnRaw.sn);assert.equal(rows[0].ref,'HISTORY_WITHDRAWAL:'+parentId);
    rows=await lookup('',true,1,'2023-11-15');assert.equal(rows[0].ref,'HISTORY_WITHDRAWAL:'+parentId);assert.equal(rows[0].document_count,'1');assert.equal(rows[0].entry_count,'2');
    rows=await lookup('',false);assert.equal(rows[0].document_count,'3');assert.equal((await lookup('',false,2))[0].document_count,'3');
    await client.query('SAVEPOINT runtime_lookup');await client.query('SET LOCAL ROLE zzsh_lwcert_r');
    assert.equal((await lookup(debitRaw.sn))[0].ref,'HISTORY_WITHDRAWAL:'+parentId);await client.query('ROLLBACK TO SAVEPOINT runtime_lookup');
    const projected=[{id:'history:'+debitId,sourceType:'LEGACY_MYSQL',sourceEntity:'la_log_earnings',documentRef:'HISTORY_EARNINGS:'+debitId,documentNumber:debitRaw.sn}] as FinanceEntry[];
    assert.equal((await attachLegacyWithdrawalBusinessReferences(client as never,projected))[0]!.documentRef,'HISTORY_WITHDRAWAL:'+parentId);

    // Privileged source corruption is not a valid relation even if someone bypasses the immutable trigger.
    await client.query('ALTER TABLE zzsh_order.personal_finance_observation DISABLE TRIGGER finance_observation_immutable');
    await client.query("UPDATE zzsh_order.personal_finance_observation SET snapshot=jsonb_set(snapshot,'{amount}','\"101.00\"') WHERE id=$1",[debitId]);
    await client.query('ALTER TABLE zzsh_order.personal_finance_observation ENABLE TRIGGER finance_observation_immutable');

    rows=await lookup(debitRaw.sn);assert.equal(rows[0].ref,'HISTORY_EARNINGS:'+debitId);
    assert.equal((await attachLegacyWithdrawalBusinessReferences(client as never,projected))[0]!.documentRef,'HISTORY_EARNINGS:'+debitId);
    await client.query('ALTER TABLE zzsh_order.personal_finance_observation DISABLE TRIGGER finance_observation_immutable');
    await client.query("UPDATE zzsh_order.personal_finance_observation SET snapshot=source_canonical::jsonb WHERE id=$1",[debitId]);
    await client.query('ALTER TABLE zzsh_order.personal_finance_observation ENABLE TRIGGER finance_observation_immutable');
    assert.equal((await lookup(returnRaw.sn))[0].ref,'HISTORY_WITHDRAWAL:'+parentId);

    await client.query('SAVEPOINT duplicate_return');
    const extraReturnRaw={...returnRaw,id:base+6,sn:'EXTRA-RETURN-'+suffix,changeType:1004};
    const extraReturn={...returned,sourceId:base+6,legacyChangeType:1004,legacyLogNumber:extraReturnRaw.sn,rawSource:proof('la_log_earnings',extraReturnRaw),sourceSupplement:proof('la_log_earnings',{...extraReturnRaw,sourceSn:parentRaw.sn})};
    await add('extra_return_'+suffix,'la_log_earnings',base+6,extraReturn);
    assert.equal(await certify(),'UNRESOLVED');assert.equal((await lookup(returnRaw.sn))[0].ref,'HISTORY_EARNINGS:'+returnId);
    await client.query('ROLLBACK TO SAVEPOINT duplicate_return');

    await client.query('SAVEPOINT malformed_source');
    const badParentRaw={...parentRaw,id:base+20,sn:'BAD-WITHDRAW-'+suffix};
    const badParent={...parent,sourceId:base+20,referenceId:String(base+20),referenceSn:badParentRaw.sn,rawSource:proof('la_withdraw_apply',badParentRaw)};
    const badDebitRaw={...debitRaw,id:base+21,sn:'BAD-LOG-'+suffix,sourceId:base+20};
    const badDebit={...debit,sourceId:base+21,referenceId:String(base+20),referenceSn:badParentRaw.sn,legacyLogNumber:badDebitRaw.sn,rawSource:proof('la_log_earnings',badDebitRaw),sourceSupplement:{entity:'la_log_earnings',canonical:'{',digest:sha('{')}};
    const badParentId='bad_p_'+suffix,badDebitId='bad_d_'+suffix;
    await add(badParentId,'la_withdraw_apply',base+20,badParent);await add(badDebitId,'la_log_earnings',base+21,badDebit);
    assert.equal((await client.query('SELECT zzsh_order.certify_legacy_withdrawal_link($1) outcome',[badParentId])).rows[0].outcome,'UNRESOLVED');
    const revision=(await client.query("SELECT revision FROM zzsh_order.legacy_withdrawal_subject_revision WHERE source_system='legacy_mysql_restore' AND user_id=$1",[user])).rows[0].revision;
    await client.query('SAVEPOINT direct_forgery');
    await assert.rejects(()=>client.query('INSERT INTO zzsh_order.legacy_withdrawal_link_evidence(parent_id,debit_id,revision) VALUES($1,$2,$3)',[badParentId,badDebitId,revision]),e=>(e as {code?:string}).code==='23514');
    await client.query('ROLLBACK TO SAVEPOINT direct_forgery');
    await client.query('ROLLBACK TO SAVEPOINT malformed_source');

    for(const scenario of ['number','amount','subject','direction','time'] as const){
      await client.query('SAVEPOINT invalid_relation');
      const xParentRaw={...parentRaw,id:base+30,sn:'VERIFY-'+suffix},xParent={...parent,sourceId:base+30,referenceId:String(base+30),referenceSn:'VERIFY-'+suffix,rawSource:proof('la_withdraw_apply',xParentRaw)};
      const xRaw={...debitRaw,id:base+31,sourceId:base+30,sn:'VERIFY-LOG-'+suffix,
        ...(scenario==='amount'?{amount:'99.00'}:{}),...(scenario==='subject'?{userId:base+99}:{}),
        ...(scenario==='direction'?{action:1}:{}),...(scenario==='time'?{createdAt:boundary-2}:{})};
      const xNumber=scenario==='number'?'WRONG-NUMBER':xParentRaw.sn;
      const xDebit={...debit,sourceId:base+31,sourceUserId:base+1,amount:xRaw.amount,action:xRaw.action,createdAt:xRaw.createdAt,referenceId:String(base+30),referenceSn:xNumber,legacyLogNumber:xRaw.sn,rawSource:proof('la_log_earnings',xRaw),sourceSupplement:proof('la_log_earnings',{...xRaw,sourceSn:xNumber})};
      const xParentId='x_p_'+suffix,xDebitId='x_d_'+suffix;
      await add(xParentId,'la_withdraw_apply',base+30,xParent);await add(xDebitId,'la_log_earnings',base+31,xDebit);
      assert.equal((await client.query('SELECT zzsh_order.certify_legacy_withdrawal_link($1) outcome',[xParentId])).rows[0].outcome,'UNRESOLVED',scenario);
      const v=(await client.query("SELECT revision FROM zzsh_order.legacy_withdrawal_subject_revision WHERE source_system='legacy_mysql_restore' AND user_id=$1",[user])).rows[0].revision;
      await client.query('SAVEPOINT invalid_direct_insert');
      await assert.rejects(()=>client.query('INSERT INTO zzsh_order.legacy_withdrawal_link_evidence(parent_id,debit_id,revision) VALUES($1,$2,$3)',[xParentId,xDebitId,v]),e=>(e as {code?:string}).code==='23514',scenario);
      await client.query('ROLLBACK TO SAVEPOINT invalid_direct_insert');await client.query('ROLLBACK TO SAVEPOINT invalid_relation');
    }

    const unknownRaw={...debitRaw,id:base+3,sn:'OTHER-'+suffix,sourceId:base+100,changeType:1001,action:1,createdAt:1700000002};
    const unknown={...debit,sourceId:base+3,referenceId:String(base+100),referenceSn:'OTHER',legacyChangeType:1001,action:1,createdAt:unknownRaw.createdAt,legacyLogNumber:unknownRaw.sn,rawSource:proof('la_log_earnings',unknownRaw),sourceSupplement:proof('la_log_earnings',{...unknownRaw,sourceSn:'OTHER'})};
    await add('other_'+suffix,'la_log_earnings',base+3,unknown);
    rows=await lookup(debitRaw.sn);assert.equal(rows[0].ref,'HISTORY_EARNINGS:'+debitId);assert.equal(await certify(),'CREATED');
    rows=await lookup(debitRaw.sn);assert.equal(rows[0].ref,'HISTORY_WITHDRAWAL:'+parentId);
    const duplicateRaw={...debitRaw,id:base+4,sn:'DUP-'+suffix};
    const duplicate={...debit,sourceId:base+4,legacyLogNumber:duplicateRaw.sn,rawSource:proof('la_log_earnings',duplicateRaw),sourceSupplement:proof('la_log_earnings',{...duplicateRaw,sourceSn:parentRaw.sn})};
    await add('duplicate_'+suffix,'la_log_earnings',base+4,duplicate);
    assert.equal(await certify(),'UNRESOLVED');rows=await lookup(debitRaw.sn);assert.equal(rows[0].ref,'HISTORY_EARNINGS:'+debitId);

    await client.query('SAVEPOINT runtime_access');await client.query('SET LOCAL ROLE zzsh_lwcert_r');
    const acl=(await client.query("SELECT has_table_privilege(current_user,'zzsh_order.legacy_withdrawal_link_evidence','INSERT') can_insert,has_function_privilege(current_user,'zzsh_order.certify_legacy_withdrawal_link(text)','EXECUTE') can_certify,has_function_privilege(current_user,'zzsh_order.legacy_withdrawal_row_fingerprint(zzsh_order.personal_finance_observation)','EXECUTE') can_read")).rows[0];
    assert.deepEqual(acl,{can_insert:false,can_certify:false,can_read:true});
    await assert.rejects(()=>client.query("INSERT INTO zzsh_order.legacy_withdrawal_link_evidence(parent_id,debit_id,revision) VALUES('fake','fake',1)"),e=>(e as {code?:string}).code==='42501');
    await client.query('ROLLBACK TO SAVEPOINT runtime_access');
    await client.query('ROLLBACK');tx=false;

    // A concurrent new observation cannot commit against the old subject revision.
    await client.query('BEGIN');tx=true;await client.query('SET LOCAL ROLE zzsh_lwcert_m');
    await client.query('INSERT INTO zzsh_auth_user."user"(id) VALUES($1)',[user]);
    await add(parentId,'la_withdraw_apply',base,parent);await add(debitId,'la_log_earnings',base+2,debit);
    assert.equal(await certify(),'CREATED');await client.query('COMMIT');tx=false;
    await client.query('BEGIN');tx=true;await client.query('SET LOCAL ROLE zzsh_lwcert_m');assert.equal(await certify(),'REPLAY');
    const competing=new Client({...config,application_name:'withdrawal-link-pg-concurrent'});await competing.connect();
    try{
      await competing.query('BEGIN');await competing.query('SET LOCAL ROLE zzsh_lwcert_m');
      const canonical=canonicalize(unknown);let finished=false;
      const pending=competing.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,snapshot)
       VALUES($1,$2,'HISTORICAL_EARNINGS_LOG','LEGACY_MYSQL','legacy_mysql_restore',$3,'la_log_earnings',$4,$5,$6::text,to_timestamp($7),$6::text::jsonb)`,
       ['race_'+suffix,user,String(base+1),String(base+3),sha(canonical),canonical,unknown.createdAt]).then(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false);
      await client.query('COMMIT');tx=false;await pending;await competing.query('COMMIT');
      await client.query('BEGIN');tx=true;await client.query('SET LOCAL ROLE zzsh_lwcert_m');
      assert.equal((await lookup(debitRaw.sn))[0].ref,'HISTORY_EARNINGS:'+debitId);
      await client.query('ROLLBACK');tx=false;
    }finally{await competing.query('ROLLBACK').catch(()=>{});await competing.end();}
  }finally{if(tx)await client.query('ROLLBACK').catch(()=>{});await client.end();}
});
