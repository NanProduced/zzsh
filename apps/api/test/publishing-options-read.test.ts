import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handlePublishingRoute} from '../src/supply/publishing-routes';
import type {SupplyRuntimeOptions} from '../src/supply/supply-routes';
import type {SupplyNodeRequest,SupplyNodeResponse} from '../src/supply/supply-util';
import {compatRule} from './pricing-compat-fixture';

async function options(rule:Record<string,unknown>|null,code='delta',terms=[{code:'daily-10m',name:'TEST_ONLY',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'}],fixed=false,account?:{id:string;owner:string}){
  let body:any;const queries:string[]=[];
  const {compatibility,...base}=compatRule(),fixedRule={...base,schema:'haff-ratio-v3',fixedModes:compatibility!.modes},rates={ordinary:'0.10',custom:'0.12',fast:'0.15'};
  const client={async query(sql:string){queries.push(sql);
    if(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql))return{rows:[]};
    if(sql.includes('game_service_operation'))return{rows:[{id:'service_1',gameId:'game_1',gameCode:code,gameEnabled:true,serviceCode:'ACCOUNT_RENTAL',enabled:true,revision:'1'}]};
    if(sql.includes('u."suspended"'))return{rows:[{suspended:false,accountStatus:'ACTIVE'}]};
    if(sql.includes('SELECT "suspended"'))return{rows:[{suspended:false}]};
    if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[]};
    if(sql.includes('FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
    if(sql.includes('SELECT * FROM zzsh_supply.rental_account'))return{rows:account?[{owner_user_id:account.owner,game_id:'game_1'}]:[]};
    if(sql.includes('FROM zzsh_supply.listing_publication p'))return{rows:[]};
    if(sql.includes('r.id AS "releaseId"'))return{rows:[{releaseId:'release_1',generation:'1',priceVersionId:'price_1',termVersionId:'term_1',catalogRevision:'1',mode:'SPREAD',commissionRate:null,roundingPolicy:'HALF_UP_CENT_V1',priceStatus:'SEALED',haffRule:rule,agreement_id:'agreement_1',title:'TEST_ONLY',body:'Existing test agreement, not an operating policy',digest:'d'}]};
    if(sql.includes('AS at'))return{rows:[{at:'2026-10-25T00:00:00.000000Z'}]};
    if(sql.includes('to_regclass'))return{rows:[{modes:fixed,prices:fixed}]};
    if(sql.includes('FROM zzsh_supply.pricing_mode_schedule m'))return{rows:[{id:'mode-1',generation:'1',effectiveAt:'2026-10-01T00:00:00.000000Z',pricingModel:'FIXED_FEE',priceScheduleId:'schedule-1',priceVersionId:'fixed-price',priceMode:'PERCENT',priceStatus:'SEALED',roundingPolicy:'HALF_UP_CENT_V1',rates,haffRule:fixedRule}]};
    if(sql.includes('FROM zzsh_supply.pricing_policy_schedule s'))return{rows:[{id:'schedule-1',generation:'1',effectiveAt:'2026-10-01T00:00:00.000000Z',priceVersionId:'fixed-price',mode:'PERCENT',status:'SEALED',roundingPolicy:'HALF_UP_CENT_V1',haffRule:fixedRule,rates}]};
    if(sql.includes('SELECT fixed_fee_rates AS rates'))return{rows:[{rates}]};
    if(sql.includes('term_option'))return{rows:terms};
    throw Error('Unexpected options query');
  },release(){}};
  const pool={query:client.query,async connect(){return client;}};
  const response={status(){return this;},setHeader(){return this;},json(value:unknown){body=value;}} as unknown as SupplyNodeResponse;
  const userAuth={api:{async getSession(){return{user:{id:'owner-1'},session:{id:'session-1'}};}}};
  await handlePublishingRoute({method:'GET',headers:{cookie:'fixture-cookie'}} as SupplyNodeRequest,response,{pool,userAuth} as unknown as SupplyRuntimeOptions,'request_options','/games/game_1/publishing-options',new URLSearchParams(account?{accountId:account.id}:{}),false);
  return{body,queries};
}
test('draft attribute dictionary does not inherit TEST_ONLY pricing keys or omit real levels',async()=>{
  const r=await options({schema:'haff-ratio-v1',baseBySafeBox:{'box-a':'50','box-b':'60'},vitalityDeltaByLevel:{'6':'0','7':'-5'},bearDeltaByLevel:{'6':'0','7':'-5'}});
  assert.deepEqual(r.body.safeBoxCodes,['safe_box_1x2','safe_box_2x2','safe_box_2x3','safe_box_3x3']);
  assert(r.body.safeBoxOptions.every((o:any)=>o.mappingStatus==='CONFIRMED'&&o.displayName));
  assert.deepEqual(r.body.vitalityLevels,[4,5,6,7]);assert.deepEqual(r.body.bearLevels,[4,5,6,7]);
  assert.deepEqual(r.body.gradingOptions.find((o:any)=>o.code==='4').divisions,[4,3,2,1]);
  assert.deepEqual(r.body.gradingOptions.find((o:any)=>o.code==='8').divisions,[]);
  assert.equal(r.body.loginMethodOptions.find((o:any)=>o.code==='login_qq_qr').displayName,'QQ扫码');
  assert.equal(r.body.loginMethodOptions.find((o:any)=>o.code==='legacy_login_qq').displayName,'QQ账密');
  assert.deepEqual(r.body.pricingInputOptions,{safeBoxCodes:[],vitalityLevels:[6,7],bearLevels:[6,7]});
  assert(!JSON.stringify(r.body).includes('"50"'));assert(r.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});

test('fixed-fee publishing options use the effective fixed rule rather than the old release price',async()=>{
  const result=await options(compatRule(),'delta',undefined,true);
  assert.equal(result.body.pricingSchema,'haff-ratio-v3');
  assert.equal(result.body.rentalModes.ordinary.enabled,true);assert.equal(result.body.rentalModes.custom.enabled,true);assert.equal(result.body.rentalModes.fast.enabled,true);
  assert.equal(result.body.pricingPolicy.priceVersionId,'fixed-price');assert.deepEqual(result.body.fixedFeeRates,{ordinary:'0.1',custom:'0.12',fast:'0.15'});
  assert.equal(result.body.releaseId,'release_1');assert.equal(result.body.rentalTermOptions.custom.requiredDailyConsumption,'10000000');
  assert(result.queries.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
  assert(result.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});
test('account-specific publishing options require the owner of that account',async()=>{
  const owned=await options(compatRule(),'delta',undefined,true,{id:'account-1',owner:'owner-1'});
  assert.equal(owned.body.pricingPolicy.pricingModel,'FIXED_FEE');
  await assert.rejects(options(compatRule(),'delta',undefined,true,{id:'account-1',owner:'other-user'}),(error:{status?:number})=>error.status===404);
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

test('supplements: publishing options expose required declarations and custom-specific bound terms',async()=>{
  const rule=compatRule();rule.dailyDeltaByTermOption['misleading-10m']='2';
  const terms=[{code:'daily-10m',name:'TEST_ONLY',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},{code:'misleading-10m',name:'TEST_ONLY',dailyConsumption:'20000000',durationRounding:'CEIL_DAY'}];
  const r=await options(rule,'delta',terms);
  assert.deepEqual(r.body.rentalTermOptions.custom.termOptionCodes,['daily-10m']);
  assert.equal(r.body.rentalTermOptions.custom.requiredDailyConsumption,'10000000');
  assert.equal(r.body.rentalModes.custom.enabled,true);
  assert.equal(r.body.declarationOptions.next_season_pass.required,true);
  assert.equal(r.body.declarationOptions.demulan_unlocked.required,true);
  assert.equal(r.body.declarationOptions.info_source.required,false);
  assert.equal(r.body.declarationOptions.info_source.public,false);
  assert.equal(r.body.declarationOptions.info_source.optionsState,'CONFIGURED');
  assert.equal(r.body.declarationOptions.info_source.options.length,4);
  assert.equal(r.body.termOptions.find((x:any)=>x.code==='misleading-10m').ownerRatioAdjustmentWanPerYuan,'2');
  assert(!JSON.stringify(r.body).includes('spreadDelta'));assert(!JSON.stringify(r.body).includes('discounts'));
  const noTen=await options(rule,'delta',[terms[1]!]);
  assert.equal(noTen.body.rentalModes.custom.enabled,false);
  assert.deepEqual(noTen.body.rentalTermOptions.custom.termOptionCodes,[]);
  assert.deepEqual(noTen.body.rentalTermOptions.custom.reasonCodes,['CUSTOM_10M_TERM_UNAVAILABLE']);
});

test('info-source: exact accepted dictionary order and text come from the API snapshot',async()=>{
  const r=await options(compatRule());
  const source=r.body.declarationOptions.info_source;
  assert.equal(source.optionsState,'CONFIGURED');
  assert.deepEqual(source.options,[{name:'抖音',value:'抖音'},{name:'朋友介绍',value:'朋友介绍'},{name:'马叉虫',value:'马叉虫'},{name:'苏醒',value:'苏醒'}]);
  assert.deepEqual(source.sourceSnapshot,{observedAtUtc:'2026-10-26T05:25:18.391Z',sha256:'ce39fba7869c90ab72541691fe92f5d1d32861278a834b58503cb03e5578786a',revision:null});
  assert.equal(source.required,false);assert.equal(source.public,false);assert.equal(source.acceptsLegacyText,true);
  assert(r.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});

test('info-source: dictionary availability never erases legacy strings or publishes private attribution',async()=>{
  const {normalizeDeltaAttributes}=await import('../src/supply/delta-rental');
  const {publicListingAttributes}=await import('../src/supply/publishing');
  const {parseOwnerIncomePreviewInput}=await import('../src/supply/owner-income-preview');
  for(const value of ['旧文本不在选项中','抖音','',null]){
    const normalized=normalizeDeltaAttributes({info_source:value});assert.equal(normalized.info_source,value);
    assert.equal(Object.hasOwn(publicListingAttributes(normalized),'info_source'),false);
  }
  const r=await options(compatRule());
  const payload={releaseId:r.body.releaseId,catalogRevision:'1',attributes:{info_source:'抖音'},termOptionCode:null,inventory:[],entitlements:[]};
  assert.throws(()=>parseOwnerIncomePreviewInput(payload),(e:any)=>e.status===400,'attribution remains outside the preview whitelist');
});
