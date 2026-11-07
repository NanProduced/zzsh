// Independent synthetic PostgreSQL only; all fixture writes roll back.
const assert = require('node:assert/strict');
const Module = require('node:module');
const {Pool} = require('pg');
const originalLoad = Module._load;
Module._load = function(name, ...args) { if (name === 'sharp') return function() { throw Error('unused synthetic media'); }; return originalLoad.call(this,name,...args); };
const {updatePriceDraft} = require('../dist/src/supply/rules.js');
const env=process.env;
assert.equal(env.PRICE_PRECISION_SYNTH_OPT_IN,'1');
assert.match(env.PRICE_PRECISION_SYNTH_OID??'',/^[1-9]\d*$/);
assert.match(env.PRICE_PRECISION_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:10000,lock_timeout:5000});
const line={itemId:'precision-item',customerTier:'STANDARD',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'1.234',ownerUnitAmount:'0.567'};

(async()=>{
 const c=await pool.connect();
 try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',host:'127.0.0.1/32',oid:env.PRICE_PRECISION_SYNTH_OID,marker:'zzsh:synthetic-settlement-test:v1',system_id:env.PRICE_PRECISION_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES('precision-admin','Synthetic','precision@example.invalid',now(),now())`);
  await c.query("INSERT INTO zzsh_supply.game(id,code,name) VALUES('precision-game','precision_fixture','Synthetic')");
  await c.query("INSERT INTO zzsh_supply.billable_item(id,game_id,code,name,unit,quantity_scale) VALUES('precision-item','precision-game','precision_item','Synthetic','PIECE',0)");
  await c.query(`INSERT INTO zzsh_supply.price_version(id,game_id,mode,status,created_by_admin_id,sealed_by_admin_id,sealed_at)
   VALUES('precision-draft','precision-game','SPREAD','DRAFT','precision-admin',NULL,NULL),
   ('precision-empty','precision-game','SPREAD','DRAFT','precision-admin',NULL,NULL),
   ('precision-sealed','precision-game','SPREAD','SEALED','precision-admin','precision-admin',now())`);
  await c.query(`INSERT INTO zzsh_supply.price_line(id,price_version_id,item_id,customer_tier,pricing_kind,unit_quantity,buyer_unit_amount,owner_unit_amount)
   VALUES('precision-old','precision-draft','precision-item','STANDARD','FIXED_UNIT',1,1.234,0.567),
   ('precision-live','precision-sealed','precision-item','STANDARD','FIXED_UNIT',1,1.234,0.567)`);
  await c.query("SET LOCAL session_replication_role='origin'");
  const state=async id=>(await c.query(`SELECT v.revision::text AS revision,l.buyer_unit_amount::text AS buyer,l.owner_unit_amount::text AS owner
    FROM zzsh_supply.price_version v LEFT JOIN zzsh_supply.price_line l ON l.price_version_id=v.id WHERE v.id=$1`,[id])).rows[0];
  const write=(id,revision,entry)=>updatePriceDraft(c,'precision-admin',true,id,{expectedRevision:revision,lines:[entry]});
  await assert.rejects(()=>write('precision-draft','1',{...line,buyerUnitAmount:'1.235'}),/最多两位小数/);
  assert.deepEqual(await state('precision-draft'),{revision:'1',buyer:'1.23400000',owner:'0.56700000'});
  await write('precision-draft','1',line);
  assert.deepEqual(await state('precision-draft'),{revision:'2',buyer:'1.23400000',owner:'0.56700000'});
  await assert.rejects(()=>write('precision-draft','2',{...line,unitQuantity:'2'}),/最多两位小数/);
  await write('precision-draft','2',{...line,buyerUnitAmount:'1.24',ownerUnitAmount:'0.56'});
  assert.deepEqual(await state('precision-draft'),{revision:'3',buyer:'1.24000000',owner:'0.56000000'});
  await assert.rejects(()=>write('precision-empty','1',{...line,buyerUnitAmount:'1.235'}),/最多两位小数/);
  await assert.rejects(()=>write('precision-empty','1',{...line,buyerUnitAmount:'1.24000000'}),/最多两位小数/);
  await write('precision-empty','1',line);
  assert.deepEqual(await state('precision-empty'),{revision:'2',buyer:'1.23400000',owner:'0.56700000'});
  console.log('synthetic PostgreSQL price precision: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
