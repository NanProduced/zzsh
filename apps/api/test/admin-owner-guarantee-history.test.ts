import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readAdminOwnerGuaranteeHistory,prepareOwnerGuaranteeHistory,readOwnerGuaranteeHistory} from '../src/finance/owner-guarantee-history';
import {SecurityApiError} from '../src/auth/security-core';
const actor={userId:'admin',sessionId:'admin-session'},target='owner',key={keyId:'fixture',secret:'x'.repeat(40)},at='2026-10-15T00:00:00.000000Z',cutoff='2026-09-13T13:31:22.000Z';
function fixture(){
 const all=[101,102].map(n=>prepareOwnerGuaranteeHistory({userId:target,legacyUserId:'11',accountId:'account-'+n,source:{id:String(n),user_id:'11',no:n===101?'VISIBLE':'HIDDEN',status:'1',is_delete:'0',pay_money:'0.00',pay_is:'0',pay_time:'1779469800',return_is:'1'},payOrders:[]}));
 const setDigest=createHash('sha256').update(all.map(p=>p.sourceId+':'+p.sourceDigest).join('\n')).digest('hex');
 const state={permissions:['credit.guarantee.read'],games:['visible-game'],locked:false,objectAllowed:true,unmapped:'0',revokeAfterPage:false,scopeAfterPage:false,calls:[] as {sql:string;args:any[]}[],targetCalls:0};
 const query=async(sql:string,args:any[]=[])=>{state.calls.push({sql,args});
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:[{locked:state.locked,twoFactorEnabled:true}],rowCount:1};
  if(sql.includes('AS "mode"')&&sql.includes('array_agg'))return{rows:[{mode:'SELECTED_GAMES',gameIds:state.games}],rowCount:1};
  if(sql.includes('WITH role_permissions'))return{rows:state.permissions.map(permissionCode=>({permissionCode})),rowCount:state.permissions.length};
  if(sql.startsWith('SELECT "status", "is_boss"'))return{rows:[{status:'ACTIVE',isBoss:false,passwordChangeRequired:false}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM zzsh_auth_user'))return{rows:[{}],rowCount:1};
  if(sql.includes('owner guarantee history schema'))return{rows:[{ready:true,native_ready:true}]};
  if(sql.includes('owner guarantee posted held')){assert(sql.includes('sgame."game_id" = a.game_id'));assert.deepEqual(args,[target,actor.userId,false]);return{rows:[{held:'500'}]};}
  if(sql.includes('owner guarantee history coverage'))return{rows:[{id:'coverage-fixture',source_count:2,imported_count:2,isolated_count:0,body_digest:'a'.repeat(64),cutoff,actual_count:'2',actual_digest:setDigest,imported_set_digest:setDigest}]};
  if(sql.includes('owner guarantee admin scoped counts')){assert(sql.includes('sgame."game_id" = a.game_id'));return{rows:[{visible_count:'1',unmapped_count:state.unmapped}]};}
  if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};
  if(sql.includes('owner guarantee history page')){assert(sql.includes('sgame."game_id" = a.game_id'));assert.deepEqual(args.slice(-2),[actor.userId,false]);if(state.revokeAfterPage)state.permissions=[];if(state.scopeAfterPage)state.games=['other-game'];const p=all[0]!;return{rows:[{id:'history-visible',account_id:p.accountId,legacy_account_id:p.sourceId,source_canonical:p.sourceCanonical,source_digest:p.sourceDigest,at}]};}
  throw Error('Unexpected admin history query');};
 const objectScope=async(_c:any,a:{userId:string;isBoss:boolean},subject:string)=>{state.targetCalls++;assert.equal(a.userId,actor.userId);assert.equal(a.isBoss,false);assert.equal(subject,target);if(!state.objectAllowed)throw new SecurityApiError(404,'NOT_FOUND','Subject outside current scope');};return{state,c:{query} as any,objectScope};
}
test('admin guarantee projection uses current realm/object/game scopes and exposes only visible count/held/history',async()=>{
 const f=fixture(),r=await readAdminOwnerGuaranteeHistory(f.c,actor,target,null,key,f.objectScope);assert.equal(r.contractVersion,'admin-owner-guarantee-history.read.v1');assert.equal(r.adminActorId,'admin');assert.equal(r.items.length,1);assert.equal(r.coverage.count,'1');assert.equal(r.postedHeld.amountCents,'500');assert(!JSON.stringify(r).includes('HIDDEN'));assert(f.state.targetCalls>=2);assert(!f.state.calls.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 f.state.unmapped='1';const partial=await readAdminOwnerGuaranteeHistory(f.c,actor,target,null,key,f.objectScope);assert.equal(partial.coverage.count,null);assert.equal(partial.coverage.mappedRecordCount,'1');assert.equal(partial.items.length,1);
});
test('missing permission, empty games, foreign target and locked current admin never return private historical rows',async()=>{
 for(const mode of ['permission','games','target','locked'] as const){const f=fixture();if(mode==='permission')f.state.permissions=[];if(mode==='games')f.state.games=[];if(mode==='target')f.state.objectAllowed=false;if(mode==='locked')f.state.locked=true;await assert.rejects(readAdminOwnerGuaranteeHistory(f.c,actor,target,null,key,f.objectScope),(e:any)=>e.status===({permission:403,games:403,target:404,locked:423})[mode]);assert(!f.state.calls.some(q=>q.sql.includes('history page')));}
});
test('revocation or game-scope change during read rejects the result before caller can send it',async()=>{
 const f=fixture();f.state.revokeAfterPage=true;await assert.rejects(readAdminOwnerGuaranteeHistory(f.c,actor,target,null,key,f.objectScope),(e:any)=>e.status===403);
 const g=fixture();g.state.scopeAfterPage=true;await assert.rejects(readAdminOwnerGuaranteeHistory(g.c,actor,target,null,key,g.objectScope),(e:any)=>e.status===409);
});
