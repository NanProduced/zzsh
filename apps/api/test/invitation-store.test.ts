import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {Pool,PoolClient} from 'pg';import {readMyInvitations,bindMyDistributionLeader,readDistributionParentInTransaction,readMyInvitees,parseInviteesQuery,encodeInviteesCursor,decodeInviteesCursor,readMyLeaderBindingReceipt} from '../src/finance/invitation-store';
import {createHash} from 'node:crypto';import {canonicalize} from '../src/supply/content-hash';import {readActiveDistributionPolicyInTransaction,type LocalDistributionScope} from '../src/finance/distribution-policy-store';
const actor={userId:'self',sessionId:'real-sdk-session',requestId:'req_invitation_test'};
test('leader binding locks deduplicated subjects in database order and rejects incomplete locks before auth or writes',async()=>{
 for(const missing of [false,true]){const seen:{sql:string;args:any[]}[]=[],pool={connect:async()=>({release(){},query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});if(['BEGIN','ROLLBACK'].includes(sql)||sql.startsWith('SELECT pg_advisory'))return{rows:[]};if(sql.startsWith('SELECT to_regclass'))return{rows:[{complete:true}]};if(sql.startsWith('SELECT * FROM zzsh_order.distribution_invite_code'))return{rows:[{user_id:'self'}]};if(sql.startsWith('SELECT id FROM zzsh_auth_user."user" WHERE id=ANY'))return{rows:missing?[]:[{id:'self'}]};if(sql.startsWith('SELECT "suspended"'))throw Error('AUTH_BOUNDARY');throw Error('Unexpected query');}})} as unknown as Pool;
  await assert.rejects(bindMyDistributionLeader(pool,actor,{code:'FX1',policyVersion:'p',expectedParticipantRevision:'1'},'key'),e=>missing?(e as {status?:number}).status===404:(e as Error).message==='AUTH_BOUNDARY');const locked=seen.find(q=>q.sql.includes('WHERE id=ANY'));assert(locked);assert(locked.sql.includes('ORDER BY id FOR UPDATE'));assert.deepEqual(locked.args,[['self']]);assert.equal(seen.filter(q=>q.sql.startsWith('SELECT "suspended"')).length,missing?0:1);assert(!seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 }
});
function inviteeProbe(participant:any,relations:any[]=[]){
 const base=probe(),argsSeen:unknown[][]=[],pool={connect:async()=>{const c=await base.pool.connect();return{release(){},query:async(sql:string,args:any[]=[])=>{
  if(sql.startsWith('SELECT pg_advisory'))return{rows:[]};
  if(sql.startsWith('SELECT invitees_knowledge'))return{rows:participant?[participant]:[]};
  if(sql.startsWith('SELECT count(*)::text')||sql.startsWith('SELECT r.id')){argsSeen.push(args);const scoped=relations.filter(r=>r.parent_user_id===args[0]&&(args[1]==='ALL'||r.type===args[1])).sort((a,b)=>b.id.localeCompare(a.id));if(sql.startsWith('SELECT count'))return{rows:[{count:String(scoped.length),digest:scoped.map(r=>r.id).join(':')}]};return{rows:scoped.filter(r=>!args[2]||r.id<args[2]).slice(0,args[3])};}
  return c.query(sql,args);
 }};}} as unknown as Pool;return{pool,argsSeen};
}
function probe(complete=true,participant:any=null,relations:any[]=[],codes:any[]=[],options:{resource?:Record<string,unknown>;policy?:Record<string,unknown>;policyComplete?:boolean}={}){const queries:string[]=[],pool={connect:async()=>({release(){},query:async(sql:string)=>{queries.push(sql);if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}]};if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE',identityStatus:'UNVERIFIED',ageStatus:'UNKNOWN'}]};if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};if(sql.startsWith('SELECT to_regclass'))return{rows:[{complete:sql.includes('distribution_policy_version')?options.policyComplete??complete:complete}]};if(sql.startsWith('SELECT d.oid'))return{rows:[{oid:820148,name:'zzsh_test_m2_auth_auth_compat',role:'zzsh_m2_auth_compat_r',marker:'zzsh:m2-auth-test:v1',complete:true,...options.resource}]};if(sql.startsWith('SELECT v.'))return{rows:options.policy?[options.policy]:[]};if(sql.startsWith('SELECT * FROM zzsh_order.distribution_participant'))return{rows:participant?[participant]:[]};if(sql.startsWith('SELECT display_code'))return{rows:codes};if(sql.startsWith('SELECT * FROM zzsh_order.invitation_relation'))return{rows:relations};if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};throw Error('Unexpected invitation read unit SQL');}})} as unknown as Pool;return{queries,pool};}
const participant={eligibility:'INELIGIBLE',level_code:null,revision:'4',inviter_knowledge:'KNOWN_NONE',leader_knowledge:'KNOWN_NONE'};
function policyRow(enabled=true){const config={schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:7,levels:[{code:'LEGACY_L1',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null}]},canonical=canonicalize(config);return{id:'policy_read',revision:'1',canonical_config:canonical,config_digest:createHash('sha256').update(canonical).digest('hex'),created_at:'2026-10-16T00:00:00Z'};}
test('overview reads existing policy and sources outside write admission without opening the writer gate',async()=>{
 const p=probe(true,participant,[],[{display_code:'legacy_code',source_type:'LEGACY_MYSQL'}],{policy:policyRow(),resource:{oid:999999,name:'zzsh_test_unadmitted_read',role:'unadmitted_read_r'}}),r=await readMyInvitations(p.pool,actor);
 assert.equal(r.policyKnowledge,'KNOWN');assert.equal(r.policyEnabled,true);assert.equal(r.canBindLeader,false);assert.equal(r.ownCode.code,'legacy_code');assert.equal(r.leader.knowledge,'KNOWN_NONE');assert.equal(r.participant.eligibility,'INELIGIBLE');
 await assert.rejects(readActiveDistributionPolicyInTransaction(await p.pool.connect()),e=>(e as {status?:number}).status===503);
 assert(p.queries.some(q=>q.startsWith('SELECT v.')));assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));
});
test('binding capability requires the original admitted resource, enabled policy and confirmed no-parent source',async()=>{
 for(const [p,expected] of [[probe(true,participant,[],[],{policy:policyRow()}),true],[probe(true,participant,[],[],{policy:policyRow(false)}),false],[probe(true,{...participant,leader_knowledge:'UNKNOWN'},[],[],{policy:policyRow()}),false],[probe(true,null,[],[],{policy:policyRow()}),false]] as const)assert.equal((await readMyInvitations(p.pool,actor)).canBindLeader,expected);
});
test('unconfigured policy stays unknown while missing schema, invalid binding and corrupt policy stay failures',async()=>{
 const absent=await readMyInvitations(probe().pool,actor);assert.equal(absent.policyKnowledge,'UNKNOWN');assert.equal(absent.policyEnabled,null);assert.equal(absent.canBindLeader,false);
 await assert.rejects(readMyInvitations(probe(true,null,[],[],{policyComplete:false}).pool,actor),e=>(e as {status?:number}).status===503);
 await assert.rejects(readMyInvitations(probe(true,participant,[],[],{policy:policyRow()}).pool,actor,{kind:'LOCAL_CONTROLLED_DISTRIBUTION'} as LocalDistributionScope),e=>(e as {status?:number}).status===503);
 await assert.rejects(readMyInvitations(probe(true,participant,[],[],{policy:{...policyRow(),config_digest:'invalid'}}).pool,actor),e=>(e as {status?:number}).status===503);
 for(const resource of [{role:'wrong_role'},{marker:'wrong_marker'},{complete:false}])await assert.rejects(readMyInvitations(probe(true,participant,[],[],{policy:policyRow(),resource}).pool,actor),e=>(e as {status?:number}).status===503);
});
test('invitation overview never turns resource database failure into unavailable binding or empty facts',async()=>{
 const p=probe(),c=await p.pool.connect(),failure=Object.assign(new Error('fixture resource denied'),{code:'42501'}),pool={connect:async()=>({release(){},query:async(sql:string,args?:unknown[])=>{if(sql.startsWith('SELECT d.oid'))throw failure;return c.query(sql,args);}})} as unknown as Pool;
 await assert.rejects(readMyInvitations(pool,actor),e=>e===failure);assert(p.queries.includes('ROLLBACK'));
});
test('missing source rows remain UNKNOWN and never synthesize no-parent, code or eligibility',async()=>{const p=probe(),r=await readMyInvitations(p.pool,actor);assert.equal(r.subjectId,'self');assert.equal(r.policyKnowledge,'UNKNOWN');assert.equal(r.participant.eligibility,'UNKNOWN');assert.equal(r.inviter.knowledge,'UNKNOWN');assert.equal(r.leader.knowledge,'UNKNOWN');assert.equal(r.ownCode.knowledge,'UNKNOWN');assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));});
test('known no-parent and source-owned code are distinct from inconsistent known-parent projection',async()=>{const p=probe(true,{eligibility:'INELIGIBLE',level_code:null,revision:'4',inviter_knowledge:'KNOWN_NONE',leader_knowledge:'KNOWN_PARENT'},[],[{display_code:'fx0001',source_type:'LEGACY_MYSQL'}]),r=await readMyInvitations(p.pool,actor);assert.equal(r.inviter.knowledge,'KNOWN_NONE');assert.equal(r.leader.knowledge,'UNKNOWN');assert.deepEqual(r.ownCode,{knowledge:'KNOWN',code:'fx0001',sourceType:'LEGACY_MYSQL'});assert.equal(r.participant.eligibility,'INELIGIBLE');});
test('legacy parent relationship never presents migration bound_at as original binding time',async()=>{const p=probe(true,{eligibility:'ELIGIBLE',level_code:'L1',revision:'1',inviter_knowledge:'KNOWN_PARENT',leader_knowledge:'KNOWN_NONE'},[{id:'legacy',type:'INVITER',parent_user_id:'parent',source_type:'LEGACY_MYSQL',bound_at:'2026-10-04T00:00:00Z'}]);const r=await readMyInvitations(p.pool,actor);assert.equal(r.inviter.relation?.boundAt,null);assert.equal(r.inviter.relation?.boundAtKnowledge,'UNKNOWN');});
test('public leader binding rejects caller identity/type overrides and missing schema before any write',async()=>{const p=probe(false);await assert.rejects(bindMyDistributionLeader(p.pool,actor,{code:'FX1',policyVersion:'p',expectedParticipantRevision:'1',type:'INVITER'},'key'));await assert.rejects(bindMyDistributionLeader(p.pool,actor,{code:'FX1',policyVersion:'p',expectedParticipantRevision:'1',userId:'other'},'key'));await assert.rejects(readMyInvitations(p.pool,actor),e=>(e as {status?:number}).status===503);assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));});
test('parent source requires active identity and complete acyclic knowledge all the way to the root',async()=>{
 const read=async(state:string|null,chain:any[])=>readDistributionParentInTransaction({query:async(sql:string)=>({rows:sql.startsWith('SELECT p.')?[{user_id:'parent',suspended:false,account_status:state,eligibility:'ELIGIBLE'}]:chain})} as PoolClient,'parent');
 const root=[{user_id:'parent',cyclic:false,leader_knowledge:'KNOWN_NONE',parent_user_id:null}];assert.equal((await read('ACTIVE',root)).ownerActive,true);assert.equal((await read('DEACTIVATED',root)).ownerActive,false);assert.equal((await read(null,root)).ownerActive,null);
 for(const chain of [[],[{...root[0],leader_knowledge:'UNKNOWN'}],[{...root[0],leader_knowledge:'KNOWN_PARENT'}],[{...root[0],parent_user_id:'hidden'}],[{...root[0],cyclic:true}],[{...root[0],leader_knowledge:'KNOWN_PARENT',parent_user_id:'ancestor'},{user_id:'ancestor',cyclic:false,leader_knowledge:'UNKNOWN',parent_user_id:null}]])assert.equal((await read('ACTIVE',chain)).graphComplete,false);
 assert.equal((await read('ACTIVE',root)).graphComplete,true);
});
test('invitation cursor binds original subject, session, relation type and immutable relation snapshot',()=>{
 const key={keyId:'test',secret:'x'.repeat(40)},binding={userId:'self',sessionHash:'h',snapshotVersion:'v',type:'ALL' as const},token=encodeInviteesCursor('relation_1',binding,key);assert.equal(decodeInviteesCursor(token,binding,key),'relation_1');
 for(const change of [{userId:'other'},{sessionHash:'other'},{snapshotVersion:'new'},{type:'INVITER' as const}])assert.throws(()=>decodeInviteesCursor(token,{...binding,...change},key),e=>(e as {status?:number}).status===409);
 assert.throws(()=>decodeInviteesCursor(token.slice(0,-1)+'!',binding,key));assert.throws(()=>decodeInviteesCursor(token,binding,{...key,secret:'z'.repeat(40)}));
 for(const q of ['limit=0','limit=51','type=UNKNOWN','userId=other','type=ALL&type=INVITER'])assert.throws(()=>parseInviteesQuery(new URLSearchParams(q)));
});
test('partial invitees keep UNKNOWN totals while paging scoped proven relations and unknown legacy binding time',async()=>{
 const rows=[{id:'r3',type:'INVITER'},{id:'r2',type:'DISTRIBUTION_LEADER'},{id:'r1',type:'INVITER'}].map(r=>({...r,parent_user_id:'self',nickname:r.id,bound_at:'2026-10-04T02:00:00Z',source_type:'LEGACY_MYSQL'}));rows.push({...rows[0]!,id:'private',parent_user_id:'other'});
 const p=inviteeProbe({invitees_knowledge:'UNKNOWN',revision:'1'},rows),key={keyId:'test',secret:'x'.repeat(40)},query={limit:1,cursor:null,type:'ALL' as const};
 const first=await readMyInvitees(p.pool,actor,query,key);assert.equal(first.knowledge,'UNKNOWN');assert.equal(first.count,null);assert.equal(first.mappedRelationCount,'3');assert.equal(first.items[0]?.id,'r3');assert.equal(first.items[0]?.boundAt,null);assert(first.nextCursor);
 const second=await readMyInvitees(p.pool,actor,{...query,cursor:first.nextCursor},key);assert.equal(second.items[0]?.id,'r2');assert.equal(second.snapshotVersion,first.snapshotVersion);
 const filtered=await readMyInvitees(p.pool,actor,{...query,limit:20,type:'INVITER'},key);assert.equal(filtered.mappedRelationCount,'2');assert.deepEqual(filtered.items.map(r=>r.id),['r3','r1']);assert(p.argsSeen.every(a=>a[0]==='self'));
 await assert.rejects(readMyInvitees(p.pool,{...actor,userId:'other'},{...query,cursor:first.nextCursor},key),e=>(e as {status?:number}).status===409);
});
test('partial zero mapping, known empty and absent participant preserve three distinct facts',async()=>{
 const key={keyId:'test',secret:'x'.repeat(40)},q={limit:20,cursor:null,type:'ALL' as const};
 for(const knowledge of ['UNKNOWN','KNOWN']){const r=await readMyInvitees(inviteeProbe({invitees_knowledge:knowledge,revision:'1'}).pool,actor,q,key);assert.equal(r.mappedRelationCount,'0');assert.equal(r.count,knowledge==='KNOWN'?'0':null);}
 const missing=await readMyInvitees(inviteeProbe(null).pool,actor,q,key);assert.equal(missing.count,null);assert.equal(missing.mappedRelationCount,null);
 await assert.rejects(readMyInvitees(inviteeProbe(null).pool,actor,{...q,cursor:'previous'},key),e=>(e as {status?:number}).status===409);
});
test('partial pagination rejects coverage knowledge drift even with the same participant revision',async()=>{
 const participant={invitees_knowledge:'UNKNOWN',revision:'1'},rows=['b','a'].map(id=>({id,parent_user_id:'self',type:'INVITER',nickname:id,bound_at:'2026-10-04T00:00:00Z',source_type:'NATIVE_REGISTRATION'})),p=inviteeProbe(participant,rows),key={keyId:'test',secret:'x'.repeat(40)},q={limit:1,cursor:null,type:'ALL' as const};
 const first=await readMyInvitees(p.pool,actor,q,key);participant.invitees_knowledge='KNOWN';await assert.rejects(readMyInvitees(p.pool,actor,{...q,cursor:first.nextCursor},key),e=>(e as {status?:number}).status===409);
});
test('unknown invitation-list coverage has null count; known empty coverage has explicit zero',async()=>{
 for(const knowledge of ['UNKNOWN','KNOWN']){
  const p=probe(),original=p.pool.connect.bind(p.pool),pool={connect:async()=>{const c=await original();return{release(){},query:async(sql:string,args?:unknown[])=>{if(sql.startsWith('SELECT pg_advisory'))return{rows:[]};if(sql.startsWith('SELECT invitees_knowledge'))return{rows:[{invitees_knowledge:knowledge,revision:'1'}]};if(sql.startsWith('SELECT count(*)::text'))return{rows:[{count:'0',digest:'d'}]};if(sql.startsWith('SELECT r.id'))return{rows:[]};return c.query(sql,args);}};}} as unknown as Pool;
  const result=await readMyInvitees(pool,actor,{limit:20,cursor:null,type:'ALL'},{keyId:'test',secret:'x'.repeat(40)});assert.equal(result.knowledge,knowledge);assert.equal(result.count,knowledge==='KNOWN'?'0':null);assert.deepEqual(result.items,[]);
 }
});
test('binding recovery queries only the original principal receipt and rejects mismatched relation ownership',async()=>{
 const p=probe(),original=p.pool.connect.bind(p.pool);let scope='';const pool={connect:async()=>{const c=await original();return{release(){},query:async(sql:string,args?:any[])=>{if(sql.startsWith('SELECT response_body')){scope=args?.[0];return{rows:[{body:{relation:{id:'other_relation',childUserId:'other',type:'DISTRIBUTION_LEADER',parentUserId:'parent'}}}]};}return c.query(sql,args);}};}} as unknown as Pool;
 await assert.rejects(readMyLeaderBindingReceipt(pool,actor,'original-key'),e=>(e as {status?:number}).status===503);assert.equal(scope,JSON.stringify(['user','self','distribution.leader.bind',null]));assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));
});

test("GAP-014 self terms: only own level/version, unknown stays unknown, no full table or money", async () => {
  const { projectMyDistributionTerms } = await import("../src/finance/invitation-store");
  const config = { schema: "distribution-policy.v1", scope: "LOCAL_CONTROLLED", enabled: true, participation: "AUTO_AT_REGISTRATION", depth: 1, selfRebate: false, accountModes: ["ordinary"], minimumAccrualCents: "1", settlementDelayDays: 7, levels: [{ code: "L1", rank: 1, default: true, renterPercent: "1", ownerPercent: "1", upgrade: null }, { code: "L2", rank: 2, default: false, renterPercent: "3", ownerPercent: "2", upgrade: { match: "ANY", conditions: [{ metric: "PAID_COUNT", value: "5" }] } }] } as any;
  const policy = { knowledge: "KNOWN" as const, policy: { versionId: "pv-2", config } };
  const known = projectMyDistributionTerms("u1", policy, { eligibility: "ELIGIBLE", level_code: "L2", commission_frozen: false, policy_version_id: "pv-1" });
  assert.deepEqual([known.knowledge, known.applicable, known.level, known.policyVersion, known.participantPolicyVersion], ["KNOWN", true, { code: "L2", rank: 2, renterPercent: "3", ownerPercent: "2" }, "pv-2", "pv-1"]);
  const text = JSON.stringify(known);
  assert.doesNotMatch(text, /"L1"|upgrade|levels|Cents":"\d+","amount/, "no other level, upgrade table or computed amount");
  assert.equal(projectMyDistributionTerms("u1", { knowledge: "UNKNOWN", policy: null, reason: "POLICY_NOT_CONFIGURED" }, { eligibility: "ELIGIBLE", level_code: "L2" }).knowledge, "UNKNOWN");
  assert.equal(projectMyDistributionTerms("u1", policy, undefined).reason, "PARTICIPANT_UNKNOWN");
  assert.equal(projectMyDistributionTerms("u1", policy, { eligibility: "UNKNOWN", level_code: "L2" }).reason, "ELIGIBILITY_UNKNOWN");
  assert.equal(projectMyDistributionTerms("u1", policy, { eligibility: "ELIGIBLE", level_code: null }).reason, "LEVEL_UNKNOWN");
  const gone = projectMyDistributionTerms("u1", policy, { eligibility: "ELIGIBLE", level_code: "L9" });
  assert.deepEqual([gone.knowledge, gone.reason, gone.level], ["UNKNOWN", "LEVEL_NOT_IN_CURRENT_POLICY", null], "never falls back to the default level");
  assert.deepEqual(["INELIGIBLE", "COMMISSION_FROZEN"].map((r) => projectMyDistributionTerms("u1", policy, r === "INELIGIBLE" ? { eligibility: "INELIGIBLE", level_code: "L2" } : { eligibility: "ELIGIBLE", level_code: "L2", commission_frozen: true }).reason), ["INELIGIBLE", "COMMISSION_FROZEN"]);
  const disabled = projectMyDistributionTerms("u1", { knowledge: "KNOWN", policy: { versionId: "pv-2", config: { ...config, enabled: false } } }, { eligibility: "ELIGIBLE", level_code: "L1" });
  assert.deepEqual([disabled.applicable, disabled.reason], [false, "POLICY_DISABLED"]);
});
