// Actual SQL predicate, synthetic schema/data only; no R07 or payment channel.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve}=require('node:path');
const container=process.env.R08_CAPTURE_SYNTH_CONTAINER,system=process.env.R08_CAPTURE_SYNTH_SYSTEM,oid=process.env.R08_CAPTURE_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container||'')&&/^[0-9]+$/.test(system||'')&&/^[0-9]+$/.test(oid||''),'synthetic identity required');
const run=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
const inspect=run(['inspect',container,'--format','{{.Id}}|{{index .Config.Labels "zzsh.task"}}|{{.HostConfig.NetworkMode}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}']);
assert.equal(inspect.status,0);assert.equal(inspect.stdout.trim(),`${container}|r08-account-capture-synth|none|[]|{}`);
const identity=run(['exec','-i','-u','postgres',container,'psql','-p','55432','-U','postgres','-d','zzsh_test_capture_synth3','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
  "SELECT system_identifier FROM pg_control_system(); SELECT oid||'|'||shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database(); SELECT to_regnamespace('zzsh_order') IS NULL;");
assert.equal(identity.status,0);assert.equal(identity.stdout.trim(),`${system}\n${oid}|zzsh:account-capture-synthetic:v1\nt`);
const code=String.raw`
const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{Client}=require('/work/node_modules/pg');
const {legacyPendingContributorProofSql}=require('/work/apps/api/dist/src/finance/admin-distribution-unified-read.js');
(async()=>{const c=new Client({host:'127.0.0.1',port:55432,user:'postgres',database:'zzsh_test_capture_synth3'});await c.connect();await c.query('SET ROLE r08_capture_owner');
 await c.query("CREATE SCHEMA zzsh_order;CREATE TABLE zzsh_order.legacy_order_read_snapshot(id text,legacy_id text,legacy_renter_id text,legacy_owner_id text,source_pay_status int,source_order_status int,source_digest text);CREATE TABLE zzsh_order.legacy_order_duty(kind text,order_id text,source_record_id text,counterparty_user_id text,status text,source text,source_status text,amount_cents numeric,admission_id text,continuation_version_id text,maturity_at timestamptz,settled_by text,source_digest text,level int,ratio numeric);CREATE TABLE zzsh_order.legacy_continuation_evidence(order_id text,source_kind text,source_digest text,facts_canonical text,facts jsonb,facts_digest text);CREATE TABLE zzsh_order.legacy_continuation_version(order_id text,stage int,superseded_at timestamptz)");
 const original={id:'42',user_id:'10',order_id:'7',order_type:'1',is_delete:'0',status:'1',level:'2',earnings:'0.80'},snap={amount:'0.80'};
 const evidence={evidence:{source:{legacyOrderId:'7',renterId:'11',ownerId:'12',paidPay:[{id:'13',payOrderSn:'PAY-1',orderId:'7',payMoney:'100.00'}],commissions:[{id:'42',beneficiaryId:'10',level:'2',status:'1',storedEarnings:'0.80',ratio:'20'}]}}};
 const hash=text=>createHash('sha256').update(text).digest('hex'),source='a'.repeat(64);
 await c.query("INSERT INTO zzsh_order.legacy_order_read_snapshot VALUES('order-7','7','11','12',1,3,$1)",[source]);
 await c.query("INSERT INTO zzsh_order.legacy_order_duty VALUES('COMMISSION','order-7','42','beneficiary','PENDING','LEGACY_IMPORT','1',80,NULL,NULL,NULL,NULL,$1,2,20)",[source]);
 async function setEvidence(value,corrupt=false){const text=JSON.stringify(value);await c.query('DELETE FROM zzsh_order.legacy_continuation_evidence');await c.query("INSERT INTO zzsh_order.legacy_continuation_evidence VALUES('order-7','SOURCE_IMPORT',$1,$2::text,$2::text::jsonb,$3)",[source,text,corrupt?'f'.repeat(64):hash(text)]);}
 await setEvidence(evidence);
 const sql='WITH p AS (SELECT $1::text allowed_order_id,$2::text source_id,$3::text user_id,$4::text legacy_user_id,$5::jsonb original,$6::jsonb snapshot) SELECT '+legacyPendingContributorProofSql()+' AS included FROM p';
 const evaluate=async(o=original,s=snap)=>(await c.query(sql,['order-7','42','beneficiary','10',JSON.stringify(o),JSON.stringify(s)])).rows[0].included;
 assert.equal(await evaluate(),true,'paid positive pending is counted, without a maturity or payout');
 for(const [statement,undo] of [
  ["UPDATE zzsh_order.legacy_order_duty SET status='VOID'","UPDATE zzsh_order.legacy_order_duty SET status='PENDING'"],
  ["UPDATE zzsh_order.legacy_order_duty SET amount_cents=0","UPDATE zzsh_order.legacy_order_duty SET amount_cents=80"],
  ["UPDATE zzsh_order.legacy_order_duty SET amount_cents=81","UPDATE zzsh_order.legacy_order_duty SET amount_cents=80"],
  ["UPDATE zzsh_order.legacy_order_duty SET source_digest=repeat('f',64)","UPDATE zzsh_order.legacy_order_duty SET source_digest=repeat('a',64)"],
  ["UPDATE zzsh_order.legacy_order_duty SET continuation_version_id='final'","UPDATE zzsh_order.legacy_order_duty SET continuation_version_id=NULL"],
  ["UPDATE zzsh_order.legacy_order_read_snapshot SET source_pay_status=0","UPDATE zzsh_order.legacy_order_read_snapshot SET source_pay_status=1"],
  ["UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=5","UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=3"],
 ]){await c.query(statement);assert.equal(await evaluate(),false,statement);await c.query(undo);}
 await c.query("INSERT INTO zzsh_order.legacy_continuation_version VALUES('order-7',4,NULL)");assert.equal(await evaluate(),false,'completed head cannot use old pending amount');
 await c.query("UPDATE zzsh_order.legacy_continuation_version SET stage=8");assert.equal(await evaluate(),true,'in-progress confirmation remains provisional');await c.query('DELETE FROM zzsh_order.legacy_continuation_version');
 assert.equal(await evaluate({...original,status:'3'}),false,'expired original');assert.equal(await evaluate({...original,order_id:'8'}),false,'wrong original order');
 const zero=structuredClone(evidence);zero.evidence.source.commissions[0].storedEarnings='0.00';await setEvidence(zero);await c.query('UPDATE zzsh_order.legacy_order_duty SET amount_cents=0');
 assert.equal(await evaluate({...original,earnings:'0.00'},{amount:'0.00'}),true,'source-bound zero is known');
 assert.equal((await c.query('SELECT amount_cents>0 AS counted FROM zzsh_order.legacy_order_duty')).rows[0].counted,false,'zero is excluded from people count');
 await c.query('UPDATE zzsh_order.legacy_order_duty SET amount_cents=80');await setEvidence(evidence);
 for(const change of [s=>s.paidPay=[],s=>s.paidPay[0].orderId='8',s=>s.paidPay[0].payMoney='0.00',s=>s.commissions[0].beneficiaryId='99',s=>s.commissions[0].ratio='21']){
  const x=structuredClone(evidence);change(x.evidence.source);await setEvidence(x);assert.equal(await evaluate(),false,'changed source evidence');}
 await setEvidence(evidence,true);assert.equal(await evaluate(),false,'digest mismatch');await c.end();
})().catch(e=>{console.error(e);process.exit(1)});`;
const out=run(['run','--rm','--network',`container:${container}`,'--mount',`type=bind,source=${resolve(__dirname,'../../..')},target=/work,readonly`,'node:24.20.0-bookworm-slim','node','-e',code]);
if(out.status!==0)throw Error(`synthetic pending evidence failed: ${out.stderr}`);
console.log('SYNTHETIC_PENDING_CONTRIBUTOR_PASSED');
