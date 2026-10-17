import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handlePublishingRoute} from '../src/supply/publishing-routes';
import type {SupplyRuntimeOptions} from '../src/supply/supply-routes';
import type {SupplyNodeRequest,SupplyNodeResponse} from '../src/supply/supply-util';

async function options(rule:Record<string,unknown>|null,code='delta'){
  let body:any;const queries:string[]=[];
  const pool={async query(sql:string){queries.push(sql);
    if(sql.includes('game_service_operation'))return{rows:[{id:'service_1',gameId:'game_1',gameCode:code,gameEnabled:true,serviceCode:'ACCOUNT_RENTAL',enabled:true,revision:'1'}]};
    if(sql.includes('SELECT r.id,r.generation'))return{rows:[{id:'release_1',generation:'1',term_version_id:'term_1',haff_rule:rule,agreement_id:'agreement_1',title:'TEST_ONLY',body:'Existing test agreement, not an operating policy',digest:'d'}]};
    if(sql.includes('term_option'))return{rows:[{code:'daily-10m',name:'TEST_ONLY',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'}]};
    throw Error('Unexpected options query');
  }};
  const response={status(){return this;},setHeader(){return this;},json(value:unknown){body=value;}} as unknown as SupplyNodeResponse;
  await handlePublishingRoute({method:'GET',headers:{}} as SupplyNodeRequest,response,{pool} as unknown as SupplyRuntimeOptions,'request_options','/games/game_1/publishing-options',new URLSearchParams(),false);
  return{body,queries};
}
test('draft attribute dictionary does not inherit TEST_ONLY pricing keys or omit real levels',async()=>{
  const r=await options({schema:'haff-ratio-v1',baseBySafeBox:{'box-a':'50','box-b':'60'},vitalityDeltaByLevel:{'6':'0','7':'-5'},bearDeltaByLevel:{'6':'0','7':'-5'}});
  assert.deepEqual(r.body.safeBoxCodes,['safe_box_1x2','safe_box_2x2','safe_box_2x3','safe_box_3x3']);
  assert(r.body.safeBoxOptions.every((o:any)=>o.mappingStatus==='CONFIRMED'&&o.displayName));
  assert.deepEqual(r.body.vitalityLevels,[4,5,6,7]);assert.deepEqual(r.body.bearLevels,[4,5,6,7]);
  assert.deepEqual(r.body.pricingInputOptions,{safeBoxCodes:[],vitalityLevels:[6,7],bearLevels:[6,7]});
  assert(!JSON.stringify(r.body).includes('"50"'));assert(r.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});
test('a partial or missing pricing map does not erase the independent declaration dictionary',async()=>{
  const r=await options({baseBySafeBox:{safe_box_1x2:'50'},vitalityDeltaByLevel:{'4':'0'},bearDeltaByLevel:{'5':'0'}});
  assert.equal(r.body.safeBoxCodes.length,4);
  assert.deepEqual(r.body.pricingInputOptions,{safeBoxCodes:['safe_box_1x2'],vitalityLevels:[4],bearLevels:[5]});
  const empty=await options(null);assert.equal(empty.body.safeBoxCodes.length,4);assert.deepEqual(empty.body.pricingInputOptions,{safeBoxCodes:[],vitalityLevels:[],bearLevels:[]});
});
test('declaration options remain closed for an unsupported game service',async()=>{
  await assert.rejects(()=>options(null,'unsupported_game'),(e:any)=>e.status===404);
});
