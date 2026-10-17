import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {readPublicCatalog} from '../src/supply/catalog';

function fixture(requiredUnpriced=false, hasRelease=true) {
  const items=Array.from({length:8},(_,n)=>({id:`item_${n}`,code:`item_code_${n}`,name:`物资${n}`,unit:n===0?'HAFF_BASE':'PIECE',quantityScale:0,required:requiredUnpriced&&n===1,priced:n===0&&hasRelease,sortOrder:n}));
  const queries:string[]=[];
  const client={async query(sql:string,args:unknown[]=[]) {
    queries.push(sql);
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:[{id:'game_delta',code:'delta',name:'三角洲行动',catalogRevision:'129',currentReleaseId:hasRelease?'release_current':null,coverMediaId:null}]};
    if(sql.includes('FROM "zzsh_supply"."billable_item"'))return{rows:sql.includes('AND EXISTS')?items.filter(i=>i.priced):items};
    if(sql.startsWith('SELECT id,name FROM zzsh_supply.billable_item'))return{rows:items.filter(i=>i.required&&(sql.includes('NOT EXISTS')?!i.priced:!(args[1] as string[]).includes(i.id)))};
    if(sql.includes('skin_category')||sql.includes('skin_rarity')||sql.includes('entitlement')||sql.includes('FROM "zzsh_supply"."skin"'))return{rows:[]};
    throw Error('Unexpected catalog read SQL');
  }} as unknown as PoolClient;
  return{client,items,queries};
}
test('publishing catalog returns all enabled items and separates current price availability',async()=>{
  const f=fixture(),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);
  assert.deepEqual(body.items.map((i:any)=>i.priced),[true,false,false,false,false,false,false,false]);
  assert.equal(body.ready,true);assert.deepEqual(body.blockers,[]);
  assert(f.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});
test('returning unpriced items does not clear the required price blocker',async()=>{
  const f=fixture(true),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);assert.equal(body.ready,false);
  assert.deepEqual(body.blockers,[{code:'REQUIRED_ITEM_UNPRICED',path:'inventory',itemId:'item_1',name:'物资1'}]);
});
test('a game without an active release still exposes its draft inventory and stays unready',async()=>{
  const f=fixture(false,false),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);assert(body.items.every((i:any)=>i.priced===false));
  assert.equal(body.ready,false);assert.deepEqual(body.blockers,[{code:'RULE_UNCONFIGURED',path:'rules'}]);
});
