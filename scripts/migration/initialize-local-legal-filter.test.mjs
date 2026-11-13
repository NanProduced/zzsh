import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkPublicFilters, executeInitialization, initialSession, inspectInitialization, readbackInitialization, validateInputs } from './initialize-local-legal-filter.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const enc = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const nonce = 'abcdef012345abcdef012345', time = Date.parse('2026-11-05T08:00:00.000Z');
const asRow = (type, title, body, id, effectiveAt) => ({ docType:type, title, body, id, digest:sha(body), status:'DRAFT', revision:'1', effectiveAt });

function fixture(overrides = {}) {
  const bytes = {}, refs = {};
  const add = (name, value) => { bytes[name] = enc(value); refs[name] = { path:name, sha256:sha(bytes[name]) }; };
  const config = { schemaVersion:1, fields:[{ key:'resources', enabled:true, items:[{itemId:'item_one',min:'0',max:'9'}] }], sorts:[] };
  add('terms','测试协议\n'); add('privacy','测试隐私\n'); add('filter',config);
  add('businessManifest',{gameCode:'delta',tables:[]});
  const actor = { id:'admin_new',actorId:'admin_new',sessionId:'session_new',realm:'admin',resourceOid:'6',nonce };
  add('actor',actor);
  add('profile',{version:1,localTest:true,resource:'round06',actors:{'boss-one':{realm:'admin',origin:'http://127.0.0.1:4241',
    userId:'admin_new',username:'zz00001',password:'synthetic',totp:{encoding:'base32',secret:'JBSWY3DPEHPK3PXP'}}}});
  add('session',{cookies:[{name:'zzsh_admin.session',value:'synthetic',domain:'127.0.0.1',path:'/',expires:-1}]});
  add('businessReceipt',{status:'REFERENCE_BOOTSTRAP_COMMITTED',oid:'6',nonce,manifestSha256:refs.businessManifest.sha256,
    maintenanceAdminId:'admin_new',commitAck:true,poolClosed:true,unlock:true,maintenanceClosed:true});
  add('buildManifest',{layout:{apiDistDir:'apps/api/dist/src'},components:{api:[{path:'apps/api/dist/src/app.js',sha256:'b'.repeat(64)}]}});
  const round = {schema:'zzsh.local-round.v1',target:{oid:'6',nonce,migrationRoleOid:'9',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'},
    actor:{sha256:refs.actor.sha256},dataset:{sha256:'a'.repeat(64)},buildFiles:{'app.js':'b'.repeat(64)},apiDist:'E:/synthetic/api/src',
    dependencyBinding:{buildManifest:{sha256:refs.buildManifest.sha256}},bootstrapEvidence:{business:{sha256:refs.businessReceipt.sha256},bundle:{sha256:'c'.repeat(64)}}};
  add('roundInput',round);
  add('roundReceipt',{status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',inputSha256:refs.roundInput.sha256,datasetSha256:round.dataset.sha256,
    target:round.target,completion:{status:'COMPLETE'}});
  const resource = {database:'zzsh_test_regression',oid:'6',nonce,marker:'zzsh:regression-test:v1'};
  add('binding',{status:'R06_MAINTENANCE_API_LISTENING',pid:17,port:4282,at:'2026-11-05T07:59:00.000Z',resource,
    actualResource:{...resource,read_only:'on',migration_role_oid:'9',runtime_role:'runtime',runtime_role_oid:'8'},
    roundInputSha256:refs.roundInput.sha256,roundReceiptSha256:refs.roundReceipt.sha256,NoIM:true,financialCommandCapabilities:false,
    workersEnabled:false,formalAppMounted:true,maintenanceLockReleased:true,maintenanceClosed:true,finalBuildManifestSha256:refs.buildManifest.sha256,
    compiledRoot:'E:/synthetic/api/src',bundleSha256:'c'.repeat(64),
    origins:{apiOrigin:'http://127.0.0.1:4282'},stopFile:'synthetic-stop'});
  add('registry',{...resource,pendingReset:null,roles:{migration:{oid:'9'},runtime:{name:'runtime',oid:'8'}}});
  const requestIds = Object.fromEntries(['filter','draft-terms','draft-privacy','seal-terms','seal-privacy'].map(name=>[name,'req_'+name]));
  const plan = {schema:'zzsh.round06-legal-filter-plan.v1',refs,effectiveAtUtc:'2026-11-05T08:02:00.000Z',filterKey:'r06_filter_original',requestIds};
  const seedGame = {id:'game_new',code:'delta',enabled:true};
  const seedItems = [{id:'item_one',code:'haff',name:'哈夫币',unit:'HAFF_BASE',enabled:true,game_id:'game_new'}];
  const hashes = Object.fromEntries(['terms','privacy','filter','businessManifest'].map(k=>[k,refs[k].sha256]));
  const read = ref => { const key = Object.keys(refs).find(k => refs[k] === ref); assert(key); assert.equal(sha(bytes[key]),ref.sha256); return bytes[key]; };
  const tableRead = (_manifest,_path,table) => table === 'game' ? [seedGame] : seedItems;
  const validate = () => validateInputs(plan, read, {expectedHashes:hashes,tableRead});
  return { bytes,refs,plan,actor,config,seedGame,seedItems,validate, ...overrides };
}

function service(f, { failAt, statusAt, wrongCatalog, wrongCurrent, wrongPublicFilter } = {}) {
  const calls = [], docs = {}, filter = {revision:'0',config:null,history:[]};
  const call = async args => {
    calls.push(structuredClone(args));
    if (args.path === failAt) throw new Error('SYNTHETIC_NETWORK_FAILURE');
    if (args.path === statusAt) return {status:403,body:{}};
    let body;
    if (args.path === '/api/auth/admin/get-session') body = {user:{id:f.actor.id,twoFactorEnabled:true},session:{id:f.actor.sessionId}};
    else if (args.path === '/api/v1/admin/supply/games') body = {games:[f.seedGame]};
    else if (args.path.endsWith('/catalog')) body = {game:f.seedGame,items:f.seedItems.map(item=>({...item,code:wrongCatalog?'wrong':item.code}))};
    else if (args.path.endsWith('/listing-filters') && args.path.startsWith('/api/v1/admin/')) {
      if (args.verb === 'PUT') { assert.equal(args.key,f.plan.filterKey); filter.revision='1';filter.config=args.body.config;filter.history=[{}]; }
      body = {gameId:f.seedGame.id,...filter};
    } else if (args.path === '/api/v1/admin/legal-documents') body = {versions:Object.values(docs)};
    else if (args.path === '/api/v1/admin/legal-documents/drafts') {
      const d = args.body, key = d.docType === 'PLATFORM_TERMS' ? 'terms' : 'privacy';
      docs[key] = asRow(d.docType,d.title,d.body.trim(),'doc_'+key,d.effectiveAt); body=docs[key];
    } else if (args.path.includes('/drafts/') && args.path.endsWith('/seal')) {
      const key = args.path.includes('doc_terms') ? 'terms' : 'privacy'; docs[key].status='SEALED'; body=docs[key];
    } else if (args.path === '/api/v1/legal-documents/current') {
      const summary = row => row?.status === 'SEALED' ? {id:row.id,digest:wrongCurrent?'wrong':row.digest} : null;
      body = {terms:summary(docs.terms),privacy:summary(docs.privacy)};
    } else if (args.path === '/api/v1/legal-documents/terms' || args.path === '/api/v1/legal-documents/privacy') {
      const key=args.path.endsWith('/terms')?'terms':'privacy'; body={state:'PUBLISHED',docType:docs[key].docType,document:docs[key]};
    } else if (args.path.startsWith('/api/v1/supply/games/') && args.path.split('?')[0].endsWith('/listing-filters'))
      body={gameId:f.seedGame.id,filterRevision:wrongPublicFilter?'0':'1',available:true,reasonCode:null,fields:f.config.fields,sorts:f.config.sorts};
    else throw new Error('UNEXPECTED_SYNTHETIC_ROUTE');
    return {status:200,body:structuredClone(body)};
  };
  return {call,calls,docs,filter};
}

async function execute(f, s) {
  const snapshots=[];
  const receipt = await executeInitialization({plan:f.plan,ctx:f.validate(),call:s.call,save:r=>snapshots.push(structuredClone(r)),listener:async()=>{},now:()=>time});
  return {receipt,snapshots};
}

test('sealed R06 sources, target, actor, registry and business match before any HTTP', () => {
  const f=fixture(), ctx=f.validate();
  assert.equal(ctx.game.id,'game_new'); assert.equal(ctx.items.length,1);
  assert.equal(ctx.documents.terms.digest,sha('测试协议'));
});

test('next migration cannot use the old administrator-driven legal initialization', () => {
  const f=fixture(), round=JSON.parse(f.bytes.roundInput);
  round.target.migrationProfile='LOCAL_MIGRATION_NEXT_V1';
  f.bytes.roundInput=enc(round); f.refs.roundInput.sha256=sha(f.bytes.roundInput);
  let reads=0;
  assert.throws(() => validateInputs(f.plan, ref => {
    reads++; assert.equal(ref,f.refs.roundInput); assert.equal(sha(f.bytes.roundInput),ref.sha256);
    return f.bytes.roundInput;
  }), /NEXT_LEGACY_LEGAL_FILTER_RETIRED/);
  assert.equal(reads,1);
});

test('next-profile registry cannot be paired with an old round input', () => {
  const f=fixture(), registry=JSON.parse(f.bytes.registry);
  registry.migrationProfile='LOCAL_MIGRATION_NEXT_V1';
  f.bytes.registry=enc(registry); f.refs.registry.sha256=sha(f.bytes.registry);
  const expected=[f.refs.roundInput,f.refs.registry];
  assert.throws(() => validateInputs(f.plan, ref => {
    assert.equal(ref,expected.shift());
    const bytes=ref === f.refs.roundInput ? f.bytes.roundInput : f.bytes.registry;
    assert.equal(sha(bytes),ref.sha256); return bytes;
  }), /NEXT_LEGACY_LEGAL_FILTER_RETIRED/);
  assert.equal(expected.length,0);
});

test('R07 legal/filter sources and runtime are bound to the same registered cluster', () => {
  const f=fixture(),instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'};
  const edit=(name,fn)=>{const value=JSON.parse(f.bytes[name]);fn(value);f.bytes[name]=enc(value);f.refs[name].sha256=sha(f.bytes[name]);};
  edit('businessManifest',x=>{x.catalogModel='OWNER_KIND_V2';});
  edit('businessReceipt',x=>{x.instance=instance;x.manifestSha256=f.refs.businessManifest.sha256;});
  f.refs.registry.path='E:/zzsh-local-state/restricted/r07/resource.json';
  edit('registry',x=>{x.instance=instance;});
  edit('roundInput',x=>{x.target.instance=instance;x.target.bootstrapReservation='ROUND07_BOOTSTRAP_RESERVED';x.credentials='E:/zzsh-local-state/restricted/r07/credentials.json';x.bootstrapEvidence.business.sha256=f.refs.businessReceipt.sha256;});
  edit('roundReceipt',x=>{x.target.instance=instance;x.target.bootstrapReservation='ROUND07_BOOTSTRAP_RESERVED';x.inputSha256=f.refs.roundInput.sha256;});
  edit('binding',x=>{x.status='R07_MAINTENANCE_API_LISTENING';x.resource.instance=instance;x.actualResource.instance=instance;x.roundInputSha256=f.refs.roundInput.sha256;x.roundReceiptSha256=f.refs.roundReceipt.sha256;});
  f.plan.schema='zzsh.round07-legal-filter-plan.v1';f.plan.sourceHashes={filter:f.refs.filter.sha256,businessManifest:f.refs.businessManifest.sha256};
  assert.equal(f.validate().game.id,'game_new');
  edit('registry',x=>{x.instance.systemIdentifier='456';});
  assert.throws(()=>f.validate(),/R07_INSTANCE_BINDING_REQUIRED/);
});

test('public filter readback rejects missing or changed configured regions', () => {
  const field={key:'regions',enabled:true,regions:[{province:'上海市',city:'浦东新区'},{province:'北京市',city:'朝阳区'}]};
  const config={fields:[field],sorts:[]}, result={available:true,reasonCode:null,fields:[structuredClone(field)],sorts:[]};
  assert.doesNotThrow(()=>checkPublicFilters(config,result));
  result.fields[0].regions.pop();
  assert.throws(()=>checkPublicFilters(config,result),/PUBLIC_FILTER_REGIONS_DIFFER/);
});

test('wrong target, different actor, stale core and changed source are rejected', () => {
  for (const [name,edit] of [
    ['binding',x=>{x.actualResource.oid='5';}],['actor',x=>{x.actorId='admin_old';}],
    ['roundReceipt',x=>{x.completion.status='INCOMPLETE';}],['registry',x=>{x.oid='5';}],
  ]) {
    const f=fixture(), value=JSON.parse(f.bytes[name]); edit(value); f.bytes[name]=enc(value); f.refs[name].sha256=sha(f.bytes[name]);
    assert.throws(()=>f.validate(),undefined,name);
  }
  const f=fixture(); f.bytes.terms=enc('其他正文'); f.refs.terms.sha256=sha(f.bytes.terms);
  assert.throws(()=>f.validate(),/REVIEWED_SOURCE_CHANGED/);
});

test('NoIM, disabled workers, closed maintenance and exact role are mandatory', () => {
  for (const edit of [x=>{x.NoIM=false;},x=>{x.workersEnabled=true;},x=>{x.maintenanceClosed=false;},x=>{x.actualResource.migration_role_oid='7';}]) {
    const f=fixture(), x=JSON.parse(f.bytes.binding);edit(x);f.bytes.binding=enc(x);f.refs.binding.sha256=sha(f.bytes.binding);assert.throws(()=>f.validate());
  }
});

test('formal writes stage both drafts, preserve original filter key, and public readback verifies both', async () => {
  const f=fixture(), s=service(f), {receipt,snapshots}=await execute(f,s);
  assert.equal(receipt.status,'SEALED_AWAITING_EFFECTIVE_PUBLIC_READBACK');
  assert.equal(receipt.writeAcksComplete,true);assert.equal(receipt.httpWriteInFlight,false);
  assert.equal(receipt.isolation.maintenanceEvidence,'RUNTIME_BINDING_AT_START_ONLY');
  assert.deepEqual(s.calls.filter(c=>c.verb).map(c=>c.verb),['PUT','POST','POST','POST','POST']);
  assert(snapshots.some(x=>x.pending?.name==='filter' && x.pending.idempotencyKey===f.plan.filterKey && x.pending.requestFingerprint));
  assert(s.calls.every(c=>!c.path.includes('accept'))); assert.equal(receipt.legal.terms.status,'SEALED');
  assert.equal(receipt.legal.terms.effectiveAt,receipt.legal.privacy.effectiveAt);
  const result=await readbackInitialization({plan:f.plan,ctx:f.validate(),original:receipt,call:s.call,listener:async()=>{},now:()=>time+120000});
  assert.equal(result.status,'FORMAL_LOCAL_LEGAL_FILTER_INITIALIZED');
  assert.equal(result.legal.terms.publicId,result.legal.terms.id);assert.equal(result.legal.privacy.publicDigest,result.legal.privacy.digest);
  assert.equal(result.filter.publicRevision,result.filter.revision);assert.equal(result.isolation.userAcceptanceWritten,false);
});

test('catalog mismatch and permission rejection cause no legal write', async () => {
  for (const opts of [{wrongCatalog:true},{statusAt:'/api/v1/admin/supply/games'}]) {
    const f=fixture(), s=service(f,opts), {receipt}=await execute(f,s);
    assert.equal(receipt.status,'STOPPED_BEFORE_OR_AFTER_ACK');assert(!s.calls.some(c=>c.verb));
  }
});

test('filter unknown retains original key, fingerprint and pending intent; no subsequent write', async () => {
  const f=fixture(), path='/api/v1/admin/supply/games/game_new/listing-filters';
  const s=service(f), call=async args=>args.verb==='PUT'?(()=>{s.calls.push(args);throw new Error('LOST_REPLY');})():s.call(args);
  const {receipt}=await execute(f,{...s,call});
  assert.equal(receipt.status,'STOPPED_MUTATION_RESULT_UNKNOWN_OR_REJECTED');assert.equal(receipt.pending.name,'filter');
  assert.equal(receipt.pending.idempotencyKey,f.plan.filterKey);assert(receipt.pending.requestFingerprint);
  assert.equal(receipt.httpWriteInFlight,'UNKNOWN');assert.equal(receipt.writeAcksComplete,false);
  assert(!s.calls.some(c=>c.path==='/api/v1/admin/legal-documents/drafts'));
});

test('filter lost reply resumes with identical original key, request ID and body before legal drafts', async () => {
  const f=fixture(),s=service(f);let dropped=false;
  const call=async args=>{const result=await s.call(args);if(args.verb==='PUT'&&!dropped){dropped=true;throw new Error('LOST_AFTER_COMMIT');}return result;};
  const first=await execute(f,{...s,call});
  assert.equal(first.receipt.pending.name,'filter');assert.equal(s.filter.revision,'1');
  const inspected=await inspectInitialization({plan:f.plan,ctx:f.validate(),original:first.receipt,call:s.call,listener:async()=>{}});
  assert.equal(inspected.status,'INSPECTED_NOT_A_SUCCESS_OR_ABSENCE_PROOF');assert.equal(inspected.filter.configMatches,true);
  const resumed=await executeInitialization({plan:f.plan,ctx:f.validate(),resumeFilter:first.receipt,call:s.call,save:()=>{},listener:async()=>{},now:()=>time});
  assert.equal(resumed.status,'SEALED_AWAITING_EFFECTIVE_PUBLIC_READBACK');
  const puts=s.calls.filter(c=>c.verb==='PUT');assert.equal(puts.length,2);
  assert.equal(puts[0].key,puts[1].key);assert.equal(puts[0].requestId,puts[1].requestId);assert.deepEqual(puts[0].body,puts[1].body);
  const changed=structuredClone(first.receipt);changed.pending.idempotencyKey='another_key';
  await assert.rejects(()=>executeInitialization({plan:f.plan,ctx:f.validate(),resumeFilter:changed,call:s.call,save:()=>{},listener:async()=>{},now:()=>time}),/ORIGINAL_FILTER_INTENT_REQUIRED/);
});

test('draft or second seal unknown remains pending, without automatic retry', async () => {
  for (const failAt of ['/api/v1/admin/legal-documents/drafts','/api/v1/admin/legal-documents/drafts/doc_privacy/seal']) {
    const f=fixture(),s=service(f,{failAt}),{receipt}=await execute(f,s);
    assert.equal(receipt.status,'STOPPED_MUTATION_RESULT_UNKNOWN_OR_REJECTED');
    assert.equal(s.calls.filter(c=>c.path===failAt).length,1);
    if (failAt.includes('seal')) assert.equal(receipt.legal.terms.status,'SEALED');
  }
});

test('independent readback rejects early, changed legal version and missing public filter', async () => {
  const f=fixture(),s=service(f),{receipt}=await execute(f,s),ctx=f.validate();
  await assert.rejects(()=>readbackInitialization({plan:f.plan,ctx,original:receipt,call:s.call,listener:async()=>{},now:()=>time}),/DOCUMENTS_NOT_YET_EFFECTIVE/);
  for (const mutate of [r=>{r.legal.terms.digest='0'.repeat(64);},r=>{r.steps[0].requestId='changed';},r=>{r.filter.revision='2';}]) {
    const r=structuredClone(receipt);mutate(r);
    await assert.rejects(()=>readbackInitialization({plan:f.plan,ctx,original:r,call:s.call,listener:async()=>{},now:()=>time+120000}));
  }
  const bad=async args=>args.path.startsWith('/api/v1/supply/games/')?{status:200,body:{gameId:'game_new',filterRevision:'0'}}:s.call(args);
  await assert.rejects(()=>readbackInitialization({plan:f.plan,ctx,original:receipt,call:bad,listener:async()=>{},now:()=>time+120000}),/PUBLIC_FILTER_READBACK_MISMATCH/);
  const unavailable=async args=>args.path.startsWith('/api/v1/supply/games/')?{status:200,body:{gameId:'game_new',filterRevision:'1',available:false}}:s.call(args);
  await assert.rejects(()=>readbackInitialization({plan:f.plan,ctx,original:receipt,call:unavailable,listener:async()=>{},now:()=>time+120000}),/PUBLIC_FILTER_UNAVAILABLE/);
});

test('actual isolated HTTP adapter preserves PUT, exact key, body, local origin and admin cookie', async () => {
  const seen=[];
  const server=createServer(async (req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    seen.push({method:req.method,path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString('utf8')});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const call=initialSession({apiOrigin:origin,state:{cookies:[{name:'zzsh_admin.session',value:'test-only',domain:'127.0.0.1',path:'/',expires:-1}]}},fetch);
    const body={expectedRevision:'0',config:{schemaVersion:1},reason:'本地合成测试'};
    const result=await call({path:'/api/v1/admin/supply/games/game_new/listing-filters',body,verb:'PUT',requestId:'req_filter',key:'same_original_key'});
    assert.equal(result.status,200);assert.equal(seen[0].method,'PUT');assert.equal(seen[0].headers['idempotency-key'],'same_original_key');
    assert.equal(seen[0].headers['x-request-id'],'req_filter');assert.equal(seen[0].headers.origin,origin);
    assert.equal(seen[0].headers.cookie,'zzsh_admin.session=test-only');assert.equal(seen[0].body,JSON.stringify(body));
  } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
