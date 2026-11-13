import assert from "node:assert/strict";
import { test } from "node:test";
import { modeLabelText } from "../src/lib/gunsmith-mode.ts";
import { DELTA_GAME_CODE, selectDeltaGame } from "../src/lib/supply-games.ts";
import { appendUniqueListings } from "../src/lib/listing-feed-utils.ts";
import { accountSearchHref, exactAccountLookupQuery } from "../src/lib/account-search.ts";
import { publishMode, serviceLinks, publicContacts } from "../src/lib/service-navigation.ts";

test("gunsmith mode labels do not infer GENERAL from an absent mode", () => {
  assert.equal(modeLabelText("HAZARD"), "烽火地带");
  assert.equal(modeLabelText("BATTLEFIELD"), "全面战场");
  assert.equal(modeLabelText("GENERAL"), "通用");
  assert.equal(modeLabelText(null), "未标注");
});

test("the delta shelf matches only the confirmed delta identifier", () => {
  const game = (id, code) => ({ id, code, name: code, description: null });
  assert.equal(DELTA_GAME_CODE, "delta");
  const delta = game("game-delta", "delta");
  assert.deepEqual(selectDeltaGame([game("game-v", "valorant"), delta]), delta);
  assert.equal(selectDeltaGame([]), null);
  assert.equal(selectDeltaGame([game("game-v", "valorant")]), null);
  assert.equal(selectDeltaGame([game("game-l", "league"), game("game-v", "valorant")]), null);
});

test("cursor page append removes existing and same-page duplicate account IDs", () => {
  const listing = (id) => ({ id });
  const result = appendUniqueListings(
    [listing("first"), listing("existing"), listing("existing")],
    [listing("existing"), listing("second"), listing("second"), listing("third")],
  );
  assert.deepEqual(result.map(({ id }) => id), ["first", "existing", "second", "third"]);
});

test("number-shaped searches stay on exact lookup while ordinary text remains a keyword query", () => {
  for (const value of [
    "AC0000000001",
    "ＡＣ0000000001",
    "AC123",
    "0000123",
    "account_c6c6a7af",
    "ac0000000001",
    "ZZ20261018000001",
    "zz20261018000001",
    "ＺＺ20261018000001",
    "ZZ20261332000001",
    "ZZ20261018000000",
    "ZZ20261018",
    "ZZ1",
  ]) {
    assert.equal(exactAccountLookupQuery(value), value.normalize("NFKC"));
  }
  for (const value of ["三角洲账号", "60M 哈夫币", "AC 0000000001", "[账号]", "咖啡", "ZZ 20261018000001", "ZZTop账号"]) {
    assert.equal(exactAccountLookupQuery(value), null);
  }
  assert.equal(exactAccountLookupQuery("  "), null);
});

test("all header entries navigate to the same normalized market URL", () => {
  assert.equal(accountSearchHref("  ＡＣ0000000001  "), "/accounts?q=AC0000000001");
  assert.equal(accountSearchHref("  60M   哈夫币  "), `/accounts?q=${encodeURIComponent("60M 哈夫币")}`);
  assert.equal(accountSearchHref("  "), "/accounts");
});

test("rental discovery and two publishing modes have distinct destinations", () => {
  assert.deepEqual(serviceLinks.map((s) => s.href), ["/accounts", "/publish", "/publish?mode=fast"]);
  assert.equal(publishMode("fast"), "fast");
  for (const v of [undefined, null, "other", ["fast"], "FAST"]) assert.equal(publishMode(v), "standard");
});

test("unconfigured contact panels cannot show invented identities or QR assets", () => {
  for (const channel of Object.values(publicContacts)) {
    assert.equal(channel.qrSrc, undefined);
    assert.equal(channel.handle, undefined);
  }
});


/* --- Supply Write Intent State & Storage Rules --- */

import {loadSupplyIntent,prepareSupplyIntent,acceptSupplyIntent,retainUncertainSupplyIntent,clearSupplyIntent,SupplyIntentStorageError} from '../src/lib/supply-write-intent.ts';
function storage(){const map=new Map();globalThis.window={sessionStorage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}};return map;}
const input={userId:'owner-a',gameId:'game',accountId:'account',action:'save-draft',key:'original',body:{expectedRevision:'1',attributes:{secret_kd:'1.50'},description:'public remark'}};
test('supply intent freezes the exact subject/target/action/key/body and survives age',()=>{storage();const first=prepareSupplyIntent(input);assert.deepEqual(prepareSupplyIntent(input),first);assert.equal(loadSupplyIntent('owner-b'),null);assert.throws(()=>prepareSupplyIntent({...input,key:'new'}));assert.throws(()=>prepareSupplyIntent({...input,accountId:'other'}));const old={...first,createdAt:'2000-01-01T00:00:00.000Z'};window.sessionStorage.setItem('zzsh.supply-write.v1:owner-a',JSON.stringify(old));assert.equal(loadSupplyIntent('owner-a').key,'original');clearSupplyIntent(old);assert.equal(loadSupplyIntent('owner-a'),null);});
test('accepted record has a minimal receipt and cannot become a new POST',()=>{storage();const record=prepareSupplyIntent(input),accepted=acceptSupplyIntent(record,{accountId:'account',revision:'2'});assert.equal(loadSupplyIntent('owner-a').phase,'accepted');assert.throws(()=>prepareSupplyIntent(input));clearSupplyIntent(accepted);assert.equal(loadSupplyIntent('owner-a'),null);});
test('pause/resume/withdraw retain their original body and subject across reload',()=>{for(const action of ['pause','resume','withdraw']){storage();const body={expectedRevision:'7',...(action==='withdraw'?{versionId:'version-7'}:{})};const record=prepareSupplyIntent({...input,action,body});retainUncertainSupplyIntent(record);assert.deepEqual(loadSupplyIntent('owner-a').body,body);assert.equal(loadSupplyIntent('owner-a').action,action);assert.equal(loadSupplyIntent('owner-b'),null);assert.throws(()=>prepareSupplyIntent({...input,action,body:{expectedRevision:'8'}}));}});
test('late storage updates match the entire original responsibility and never downgrade accepted',()=>{storage();const first=prepareSupplyIntent(input);assert.equal(clearSupplyIntent(first),true);const next=prepareSupplyIntent({...input,accountId:'another',key:'next',body:{expectedRevision:'2'}}),before=window.sessionStorage.getItem('zzsh.supply-write.v1:owner-a');assert.throws(()=>acceptSupplyIntent(first,{accountId:'account'}),SupplyIntentStorageError);assert.throws(()=>retainUncertainSupplyIntent(first),SupplyIntentStorageError);assert.equal(clearSupplyIntent(first),false);assert.equal(window.sessionStorage.getItem('zzsh.supply-write.v1:owner-a'),before);const accepted=acceptSupplyIntent(next,{accountId:'another',revision:'3'});assert.deepEqual(retainUncertainSupplyIntent(next),accepted);assert.deepEqual(acceptSupplyIntent(next,{accountId:'another',revision:'999'}),accepted);for(const patch of [{gameId:'other'},{accountId:'other'},{action:'quote'},{body:{expectedRevision:'other'}},{createdAt:'2000-01-01T00:00:00.000Z'}]){assert.equal(clearSupplyIntent({...accepted,...patch}),false);assert.deepEqual(loadSupplyIntent('owner-a'),accepted);}});
test('storage/corruption/secret/file/function failures block writes instead of fabricating an empty store',()=>{const map=storage();assert.throws(()=>prepareSupplyIntent({...input,body:{uploadToken:'secret'}}),SupplyIntentStorageError);assert.throws(()=>prepareSupplyIntent({...input,body:{run:()=>{}}}),SupplyIntentStorageError);assert.throws(()=>prepareSupplyIntent({...input,body:{file:new Blob(['x'])}}),SupplyIntentStorageError);for(const body of ['invalid',true,[],null]){map.set('zzsh.supply-write.v1:owner-a',JSON.stringify({...input,version:1,phase:'pending',createdAt:new Date().toISOString(),body}));assert.throws(()=>loadSupplyIntent('owner-a'),SupplyIntentStorageError);}map.set('zzsh.supply-write.v1:owner-a','broken');assert.throws(()=>loadSupplyIntent('owner-a'),SupplyIntentStorageError);Object.defineProperty(window,'sessionStorage',{get(){throw Error('denied')}});assert.throws(()=>prepareSupplyIntent(input),SupplyIntentStorageError);});


/* --- Publish Derivation & Calculation Rules --- */

import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
  centsOfMoney,
  centsText,
  customTermOptions,
  depositDeclarationCents,
  fullPayoutSelected,
  haffMInputFromBase,
  haffMText,
  isoFromBeijingInput,
  minutesToTimeValue,
  matchedOwnerNetEstimate,
  normalizeRatioInput,
  ownerQuoteBreakdown,
  ratioDisplayText,
  ratioRangeText,
  rentalModeLabel,
  rentalPricingOf,
  roundGroupText,
  timeValueToMinutes,
  yuanFromCents,
  yuanToCents,
} from '../src/lib/publish-derive.ts';

const feeMoney = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });

test('ratio choices show server bounds without inventing values', () => {
  assert.equal(ratioDisplayText({ min: '42', max: '42' }), '1 元 = 42 万哈夫币');
  assert.equal(ratioDisplayText({ min: '39', max: '41' }), '1 元 = 39–41 万哈夫币');
  assert.equal(ratioDisplayText({ min: '48', max: null }), '1 元 = 48 万哈夫币起');
  for (const value of [null, {}, { min: '-1', max: '4' }, { min: 'abc', max: null }, { min: '48', max: '99.000000001' }]) assert.equal(ratioDisplayText(value), null);
});
const feePreview = (selected = true) => ({
  state: 'READY', binding: { releaseId: 'r1', catalogRevision: '1' }, totalExpectedIncome: feeMoney('215.67'),
  normalEndEstimate: { schema: 'owner-normal-end-estimate.v1', state: 'READY', scenario: 'ALL_DECLARED_INVENTORY_CONSUMED_NORMAL_END', selected,
    ownerGross: feeMoney('215.67'), serviceFee: { base: feeMoney(selected ? '215.67' : '0.00'), rate: selected ? '0.08' : '0', amount: feeMoney(selected ? '17.25' : '0.00'), payer: selected ? 'OWNER' : 'NONE' },
    ownerNet: feeMoney(selected ? '198.42' : '215.67'), policy: selected ? { fullPayoutPolicyRef: 'policy', fullPayoutPolicyVersion: '1', disclosureVersion: 'd1' } : null,
  },
});

test('normal-end estimate consumes server net and explicit zero without reusing another selection', () => {
  assert.equal(matchedOwnerNetEstimate(feePreview(), true).ownerNet.amount, '198.42');
  assert.equal(matchedOwnerNetEstimate(feePreview(false), false).serviceFee.amount.amount, '0.00');
  assert.equal(matchedOwnerNetEstimate(feePreview(), false), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), null), null);
  assert.equal(matchedOwnerNetEstimate({ ...feePreview(), normalEndEstimate: undefined }, true), null);
  assert.equal(matchedOwnerNetEstimate({ ...feePreview(), state: 'PARTIAL' }, true), null);
});

test('normal-end estimate rejects incomplete, malformed and mismatched quote facts', () => {
  for (const change of [
    p => { p.normalEndEstimate.state = 'INCOMPLETE'; },
    p => { p.normalEndEstimate.ownerNet = null; },
    p => { p.normalEndEstimate.serviceFee.amount = null; },
    p => { p.normalEndEstimate.ownerNet = feeMoney('198.43'); },
    p => { p.normalEndEstimate.ownerNet.currency = 'USD'; },
    p => { p.normalEndEstimate.ownerNet.amount = 198.42; },
    p => { p.normalEndEstimate.policy = null; },
  ]) { const p = feePreview(); change(p); assert.equal(matchedOwnerNetEstimate(p, true), null); }
  const quote = { ruleReleaseId: 'r1', catalogRevision: '1', ownerTotal: feeMoney('215.67') };
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, quote).ownerNet.amount, '198.42');
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, ownerTotal: feeMoney('215.68') }), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, ruleReleaseId: 'r2' }), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, catalogRevision: '2' }), null);
});

test('custom term selection uses actual consumption and the published allowed codes', () => {
  const termOptions = [{ code: 'fake-10m', dailyConsumption: '20000000' }, { code: 'unmapped', dailyConsumption: '10000000' }, { code: 'allowed', dailyConsumption: '10000000' }];
  assert.deepEqual(customTermOptions({ termOptions, rentalTermOptions: { custom: { termOptionCodes: ['allowed'] } } }).map(t => t.code), ['allowed']);
  assert.deepEqual(customTermOptions({ termOptions, rentalTermOptions: { custom: { termOptionCodes: [] } } }), []);
  assert.deepEqual(customTermOptions({ termOptions }).map(t => t.code), ['unmapped', 'allowed']);
});

test('owner quote breakdown sums server line amounts by unit without recomputing prices', () => {
  const breakdown = ownerQuoteBreakdown({
    ownerTotal: { amount: '310.25' },
    lines: [
      { unit: 'HAFF_BASE', ownerAmount: { amount: '300.00' } },
      { unit: 'ROUND', ownerAmount: { amount: '8.15' } },
      { unit: 'PIECE', ownerAmount: { amount: '2.10' } },
    ],
  });
  assert.deepEqual(breakdown, { haffCents: 30000n, itemCents: 1025n, totalCents: 31025n });
  assert.equal(centsText(breakdown.totalCents), '310.25');
  assert.equal(centsOfMoney({ amount: '0.01' }), 1n);
  assert.equal(centsOfMoney({ amount: '1e3' }), null);
  assert.equal(ownerQuoteBreakdown(null), null);
  assert.equal(
    ownerQuoteBreakdown({ ownerTotal: { amount: '999.00' }, lines: [{ unit: 'HAFF_BASE', ownerAmount: { amount: '1.00' } }] }),
    null,
    'a line sum that disagrees with ownerTotal must not be presented as a complete quote',
  );
});

test('haff M input converts to base exactly without floating point or lost remainder', () => {
  assert.equal(haffMInputFromBase('60000000'), '60');
  assert.equal(haffMInputFromBase('60500000'), '60.5');
  assert.equal(haffMInputFromBase('60000001'), '60.000001');
  assert.equal(haffMInputFromBase(''), '');
  assert.equal(baseFromHaffM('60'), '60000000');
  assert.equal(baseFromHaffM('60.5'), '60500000');
  assert.equal(baseFromHaffM('0.000001'), '1');
  assert.equal(baseFromHaffM('0'), '0');
  assert.equal(baseFromHaffM(''), null);
  assert.equal(baseFromHaffM('1.2345678'), null, 'more than 6 decimals is rejected, not rounded');
  assert.equal(baseFromHaffM('abc'), null);
  assert.equal(baseQuantityText('60500001'), '60,500,001');
});

test('beijing datetime input round-trips instants without shifting eight hours', () => {
  assert.equal(beijingInputFromIso('2026-10-01T04:00:00.000Z'), '2026-10-01T12:00');
  assert.equal(isoFromBeijingInput('2026-10-01T12:00'), '2026-10-01T04:00:00.000Z');
  assert.equal(beijingInputFromIso(isoFromBeijingInput('2026-01-01T00:00')), '2026-01-01T00:00');
  assert.equal(isoFromBeijingInput('2026-02-30T10:00'), null, 'impossible calendar days are rejected');
  assert.equal(isoFromBeijingInput('not-a-date'), null);
  assert.equal(beijingInputFromIso(null), '');
});

test('haff and round formatting keep M and group semantics', () => {
  assert.equal(haffMText('300000000'), '300 M');
  assert.equal(haffMText('3500000'), '3 M 500000');
  assert.equal(haffMText('0'), '0 M');
  assert.equal(haffMText('999'), '999');
  assert.equal(haffMText(''), null);
  assert.equal(roundGroupText('1020'), '17 组');
  assert.equal(roundGroupText('970'), '16 组 10 发');
  assert.equal(roundGroupText('0'), '0 发');
});

test('beijing service window minutes round-trip and keep 24:00 visible', () => {
  assert.equal(minutesToTimeValue(540), '09:00');
  assert.equal(minutesToTimeValue(0), '00:00');
  assert.equal(minutesToTimeValue(1440), '24:00');
  assert.equal(minutesToTimeValue(1441), '');
  assert.equal(timeValueToMinutes('23:59'), 1439);
  assert.equal(timeValueToMinutes('24:00'), 1440);
  assert.equal(timeValueToMinutes('9:00'), 540);
  assert.equal(roundGroupText('1020', 60), '17 组');
  assert.equal(roundGroupText('120', 30), '4 组');
});

test('rental pricing selection keeps ordinary B-free and rejects invalid custom values', () => {
  assert.deepEqual(rentalPricingOf({ rentalPricing: { rentalMode: 'fast', ownerRatioB: '48' } }), { rentalMode: 'fast', ownerRatioB: '48' });
  assert.equal(rentalPricingOf({}), null);
  assert.deepEqual(buildRentalPricing('ordinary', '42'), { rentalMode: 'ordinary' });
  assert.equal(buildRentalPricing('custom', ''), null);
  assert.equal(buildRentalPricing('custom', '0'), null);
  assert.equal(buildRentalPricing('fast', 'abc'), null);
  assert.deepEqual(buildRentalPricing('fast', '48.50'), { rentalMode: 'fast', ownerRatioB: '48.5' });
  assert.equal(normalizeRatioInput('0042.500'), '42.5');
});

test('ratio ranges and deposit declarations derive from server payloads only', () => {
  assert.equal(ratioRangeText({ min: { base: 'C', value: '-1' }, max: { base: 'C', value: '2' } }), '普通比例-1 ~ 普通比例+2');
  assert.equal(ratioRangeText({ min: { base: 'ABSOLUTE', value: '39' }, max: { base: 'ABSOLUTE', value: '41' } }), '39 ~ 41');
  assert.equal(ratioRangeText({ min: { base: 'C', value: '6' } }), '最低 普通比例+6');
  assert.equal(ratioRangeText({ min: { base: 'ABSOLUTE', value: '39' } }), '最低 39');
  assert.equal(ratioRangeText({ max: { base: 'C', value: '2' } }), '最高 普通比例+2');
  assert.equal(ratioRangeText({}), null);
  assert.equal(ratioRangeText(undefined), null);
  assert.equal(rentalModeLabel('custom'), '自定义比例');
  assert.equal(yuanToCents('300'), '30000');
  assert.equal(yuanToCents('300.5'), '30050');
  assert.equal(yuanToCents('300.555'), null);
  assert.equal(yuanFromCents('30050'), '300.50');
  assert.equal(depositDeclarationCents({ owner_deposit_declaration: { schema: 'owner-deposit-declaration-v1', amountCents: '30000', declarationVersion: '1' } }), '30000');
  assert.equal(depositDeclarationCents({}), null);
  assert.equal(fullPayoutSelected({ full_payout_declaration: { schema: 'full-payout-declaration-v1', selected: true } }), true);
  assert.equal(fullPayoutSelected({}), null);
});

test('yuanFromCents rejects missing and non-string cents without manufacturing a zero', () => {
  for (const value of [null, undefined, ['0'], {}, '', '-1', '1.5', 'x']) assert.equal(yuanFromCents(value), null);
  assert.equal(yuanFromCents('0'), '0.00');
});


/* --- Supply Client Tests --- */
import {groupForField,supplyRecovery,SupplyRequestError,supplyRequest,supplyApi,supplyBlockerMessages,editableDeclaration,mergeInventory,inventoryEditorRows,inventoryPriceHint,uploadSupplyMedia} from '../src/lib/supply-client.ts';
test('draft inventory keeps exact quantities and shows unpriced lines',()=>{
  const catalog={items:[{id:'priced',name:'哈夫币',unit:'HAFF_BASE',required:true,priced:true}]};
  const inventory=[{itemId:'priced',quantity:'0'},{itemId:'extra',quantity:'0'},{itemId:'unknown',quantity:null}];
  assert.deepEqual(mergeInventory({inventory},catalog),inventory);
  assert.deepEqual(mergeInventory({inventory:[]},catalog),[]);
  const rows=inventoryEditorRows(catalog,inventory,[{id:'extra',name:'六级头盔',unit:'PIECE',priced:false}]);
  assert.deepEqual(rows.map(row=>[row.itemId,row.name,row.quantity,row.priced,row.unit]),[
    ['priced','哈夫币','0',true,'HAFF_BASE'],
    ['extra','六级头盔','0',false,'PIECE'],
    ['unknown','名称待确认',null,false,null],
  ]);
  assert.equal(rows.some(row=>row.quantity==='0'&&row.itemId==='unknown'),false);
});
test('all catalog items remain editable when only one has a current price',()=>{
  const catalog={items:Array.from({length:8},(_,n)=>({id:`item_${n}`,name:`物资${n}`,unit:n===0?'HAFF_BASE':'PIECE',priced:n===0}))};
  const inventory=catalog.items.map((item,n)=>({itemId:item.id,quantity:n===1?'0':String(n+1)}));
  const rows=inventoryEditorRows(catalog,inventory);
  assert.equal(rows.length,8);
  assert.deepEqual(rows.map(r=>r.priced),[true,false,false,false,false,false,false,false]);
  assert.deepEqual(mergeInventory({inventory},catalog),inventory);
  assert.deepEqual(rows.map(r=>r.quantity),inventory.map(i=>i.quantity));
  assert.equal(inventoryPriceHint(rows[1]),'未进入当前可用价目，不可报价');
  assert.equal(rows.every(r=>r.catalogState==='ready'),true);
});
test('current catalog membership overrides an older priced label and keeps unknown separate',()=>{
  const stale=[{id:'retained-stock',name:'先前读取的物品',unit:'PIECE',priced:true},{id:'kept',name:'旧名',unit:'ROUND',priced:false}];
  const excluded=inventoryEditorRows({items:[]},[{itemId:'retained-stock',quantity:'5'}],stale);
  assert.equal(excluded.length,1);
  assert.deepEqual(excluded[0],{itemId:'retained-stock',name:'先前读取的物品',unit:'PIECE',quantity:'5',priced:false,required:false,catalogState:'ready',mediaId:null});
  assert.equal(inventoryPriceHint(excluded[0]),'未进入当前可用价目，不可报价');
  const inventory=[{itemId:'kept',quantity:'4'},{itemId:'zero',quantity:'0'},{itemId:'missing',quantity:null}];
  const labels=[{id:'zero',name:'六级子弹',unit:'ROUND',priced:true},{id:'missing',name:'六级头盔',unit:'PIECE',priced:true}];
  const pending=inventoryEditorRows(null,inventory,labels);
  const failed=inventoryEditorRows(null,inventory,labels,'failed');
  assert.deepEqual(pending.map(row=>[row.itemId,row.quantity,row.priced,row.catalogState,row.name]),[['kept','4',null,'pending','名称待确认'],['zero','0',null,'pending','六级子弹'],['missing',null,null,'pending','六级头盔']]);
  assert.deepEqual(failed.map(row=>[row.priced,row.catalogState]),[[null,'failed'],[null,'failed'],[null,'failed']]);
  assert.equal(inventoryPriceHint(pending[0]),'发布目录尚未加载，暂不能判断可否报价');
  assert.equal(inventoryPriceHint(failed[0]),'发布目录读取失败，暂不能判断可否报价');
  const ready=inventoryEditorRows({items:[{id:'kept',name:'目录内物品',unit:'PIECE',required:true,priced:true}]},inventory,stale.concat(labels));
  assert.deepEqual(ready.map(row=>[row.itemId,row.name,row.unit,row.quantity,row.priced,row.catalogState]),[
    ['kept','目录内物品','PIECE','4',true,'ready'],
    ['zero','六级子弹','ROUND','0',false,'ready'],
    ['missing','六级头盔','PIECE',null,false,'ready'],
  ]);
  assert.equal(inventoryPriceHint(ready[0]),null);
  const unknownPrice=inventoryEditorRows({items:[{id:'kept',name:'目录内物品',unit:'PIECE'}]},[{itemId:'kept',quantity:'4'}]);
  assert.equal(unknownPrice[0].priced,null);
  assert.equal(inventoryPriceHint(unknownPrice[0]),'当前价目状态尚未确认，暂不能报价');
});
test('supply recovery locates groups and never overwrites stale drafts',()=>{
  assert.equal(groupForField('inventory[2].quantity'),'inventory');assert.equal(groupForField('mediaBindings.0.assetId'),'media');assert.equal(groupForField('attributes.vit_level'),'basics');
  const e=new SupplyRequestError(409,{error:{code:'CONFLICT',message:'version changed',requestId:'r'}});
  assert.deepEqual(supplyRecovery(e),{action:'RELOAD_AND_CONFIRM',groups:[],preserveDraft:true});
  assert.equal(supplyRecovery(new SupplyRequestError(401,null)).action,'LOGIN');
  const draft=editableDeclaration({title:'资料',description:null,attributes:{},inventory:[],skins:[],entitlements:[],termOptionCode:'daily',pricingOptionCode:'standard',mediaBindings:[{assetId:'a',position:0,purpose:'ACCOUNT_EVIDENCE',byteHash:'server-only'}]});
  assert.deepEqual(draft.mediaBindings,[{assetId:'a',position:0}]);
  assert.equal(groupForField('rules'),'rules');
  assert.equal(supplyRecovery(new SupplyRequestError(500,{})).action,'RETRY_SAME_REQUEST');
});
test('user calls carry explicit replay keys, no price calculation or automatic retries',async()=>{
  const old=globalThis.fetch;let count=0;globalThis.fetch=async(url,init)=>{count++;assert.equal(url,'/api/supply/favorites/a');assert.equal(init.headers['idempotency-key'],'stable-key');assert.deepEqual(JSON.parse(init.body),{saved:true});return Response.json({accountId:'a',saved:true});};
  try{assert.deepEqual(await supplyApi.setFavorite('a',true,'stable-key'),{accountId:'a',saved:true});assert.equal(count,1);globalThis.fetch=async()=>{count++;throw Error('network');};await assert.rejects(()=>supplyRequest('/favorites/a',{method:'PUT',body:{saved:true},idempotencyKey:'stable-key'}),e=>e.idempotencyKey==='stable-key'&&e.status===0);assert.equal(count,2);}finally{globalThis.fetch=old;}
});

test('account operation recovery is one GET with the exact original request fingerprint and key',async()=>{
  const {createHash}=await import('node:crypto'),old=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({receipt:'UNRESOLVED'});};
  try{for(const action of ['pause','resume','withdraw']){
    const body={expectedRevision:'7',...(action==='withdraw'?{versionId:'version-7'}:{})};
    assert.deepEqual(await supplyApi.operationResult(action,'account-7',body,'original-operation-key'),{receipt:'UNRESOLVED'});
    const call=calls.at(-1),query=new URL(call.url,'http://127.0.0.1').searchParams;
    assert.equal(call.init.method,'GET');assert.equal(call.init.body,undefined);assert.equal(new Headers(call.init.headers).get('idempotency-key'),'original-operation-key');
    assert.equal(query.get('fingerprint'),createHash('sha256').update(JSON.stringify([`supply.publication.${action}`,'account-7',body])).digest('hex'));
    assert.deepEqual([...query.keys()],['operation','resourceId','fingerprint']);
  }assert.equal(calls.length,3);}finally{globalThis.fetch=old;}
});

test('owner acceptance forwards exact full-payout terms with its original replay key',async()=>{
  const old=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,key:init.headers['idempotency-key'],body:JSON.parse(init.body)});return Response.json({account:{id:'a'}});};
  const body={expectedRevision:'5',versionId:'v',releaseId:'r',contentHash:'h',fullPayoutTermsAcceptance:{termsVersionId:'payout-v1',termsDigest:'a'.repeat(64),disclosureVersion:'d1'}};
  try{await supplyApi.confirm('a','accept-rules',body,'original-accept-key');assert.deepEqual(calls,[{url:'/api/supply/accounts/a/accept-rules',key:'original-accept-key',body}]);}finally{globalThis.fetch=old;}
});
test('public browse calls keep contract paths and forward abort signals',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,signal:init?.signal});return Response.json({items:[],games:[],skins:[]});};
  const controller=new AbortController();
  try{
    await supplyApi.browseCatalog('game_1',new URLSearchParams({limit:'100'}),controller.signal);
    await supplyApi.market(new URLSearchParams({gameId:'game_1'}),controller.signal);
    await supplyApi.listing('account_1',controller.signal);
    assert.deepEqual(calls.map(call=>call.url),['/api/supply/games/game_1/catalog?limit=100','/api/supply/listings?gameId=game_1','/api/supply/listings/account_1']);
    assert.ok(calls.every(call=>call.signal===controller.signal));
  }finally{globalThis.fetch=old;}
});
test('publish reads use the current catalog and rule-release endpoints with cancellation',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,signal:init?.signal});return Response.json({});};
  const controller=new AbortController();
  try{
    await supplyApi.publishingOptions('game_1',controller.signal);
    await supplyApi.catalog('game_1',new URLSearchParams({limit:'30',q:'skin'}),controller.signal);
    await supplyApi.mine('account_1',controller.signal);
    await supplyApi.myAccounts(new URLSearchParams({limit:'20'}),controller.signal);
    assert.deepEqual(calls.map(call=>call.url),['/api/supply/games/game_1/publishing-options','/api/supply/games/game_1/publishing-catalog?limit=30&q=skin','/api/supply/accounts/account_1','/api/supply/me/accounts?limit=20']);
    assert.ok(calls.every(call=>call.signal===controller.signal));
  }finally{globalThis.fetch=old;}
});

// ══ t4（2026-10-14）F1-t：/me/accounts 的真实请求 URL 带 after（不是 cursor）；legacy cursor 仅在共同边界归一一次。 ══
import { myAccountsQuery } from "../src/lib/supply-client.ts";

test('my accounts requests keep the signed cursor and legacy after distinct', async () => {
  const old = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({ items: [], nextCursor: null, nextPageCursor: null }); };
  try {
    await supplyApi.myAccounts(new URLSearchParams({ limit: '50' }));
    await supplyApi.myAccounts(new URLSearchParams({ limit: '50', after: 'acc_9' }));
    await supplyApi.myAccounts(new URLSearchParams({ limit: '50', cursor: 'signed_9' }));
  } finally { globalThis.fetch = old; }
  assert.deepEqual(calls, ['/api/supply/me/accounts?limit=50', '/api/supply/me/accounts?limit=50&after=acc_9', '/api/supply/me/accounts?limit=50&cursor=signed_9']);
});

test('myAccountsQuery preserves the signed cursor and the legacy after cursor', () => {
  assert.equal(String(myAccountsQuery(new URLSearchParams({ limit: '50' }))), 'limit=50');
  assert.equal(String(myAccountsQuery(new URLSearchParams({ cursor: 'signed-1' }))), 'cursor=signed-1');
  assert.equal(String(myAccountsQuery(new URLSearchParams({ after: 'a2' }))), 'after=a2');
  assert.equal(String(myAccountsQuery(new URLSearchParams({ cursor: 'signed-1', rentalState: 'RENTED' }))), 'cursor=signed-1&rentalState=RENTED');
});

test('all current owner and publication blockers have specific recovery copy', () => {
  for (const code of ['RENTED','PENDING_PAYMENT','UNDER_REVIEW','NOT_PUBLISHED','STATE_UNKNOWN','QUOTE_REQUIRED','ACCEPTANCE_REQUIRED','MEDIA_REQUIRED','TITLE_REVIEW_REQUIRED']) {
    assert.equal(typeof supplyBlockerMessages[code], 'string', code);
    assert.doesNotMatch(supplyBlockerMessages[code], /暂不能继续|稍后重试/, code);
  }
  assert.match(supplyBlockerMessages.PENDING_PAYMENT, /关联订单/);
  assert.match(supplyBlockerMessages.ACCEPTANCE_REQUIRED, /规则与协议/);
});


/* --- Media Upload Tests --- */
import { createHash } from 'node:crypto';
import { MAX_MEDIA_BYTES, mediaUploadFailureHint } from '../src/lib/media-upload.ts';

test('normal business images pass the client mirror check', () => {
  assert.equal(mediaUploadFailureHint({ type: 'image/png', size: 2_885_976 }), null);
  assert.equal(mediaUploadFailureHint({ type: 'image/jpeg', size: MAX_MEDIA_BYTES }), null);
});

test('oversize images get an explicit size hint and stay removable', () => {
  const hint = mediaUploadFailureHint({ type: 'image/png', size: 14_547_995 });
  assert.match(hint, /13\.9 MiB/);
  assert.match(hint, /10 MiB/);
});

test('unsupported formats and empty files are rejected before upload', () => {
  assert.match(mediaUploadFailureHint({ type: 'image/gif', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: '', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: 'image/png', size: 0 }), /为空或无法读取/);
});

test('account direct upload posts actual file bytes to OSS and completes with only SHA-256 and its intent token', async t => {
  const before = globalThis.fetch;
  t.after(() => { globalThis.fetch = before; });
  const file = new File(['sample original screenshot bytes'], 'screenshot.png', { type: 'image/png' });
  const target = 'https://images.example.com/';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    if (calls.length === 1) return Response.json({ intentId: 'upload_sample', uploadToken: 'fixture-intent-token', transport: 'OSS_POST', ossUpload: { method: 'POST', url: target, fields: { key: 'private/account-upload/upload_sample', policy: 'fixture' } } });
    if (calls.length === 2) throw new TypeError('connection failed after upload');
    return Response.json({ assetId: 'asset_sample' });
  };
  let identityChecks = 0;
  const asset = await uploadSupplyMedia({ gameId: 'delta', accountId: 'account_1', purpose: 'ACCOUNT_DISPLAY', file,
    intentKey: 'intent_key', uploadKey: 'upload_key', transport: 'OSS_POST', beforeBytesUpload: async () => { identityChecks++; return true; } });
  assert.deepEqual(calls.map(([url]) => url), ['/api/supply/media/upload-intents', target, '/api/supply/media/uploads/upload_sample/complete']);
  assert.deepEqual(JSON.parse(calls[0][1].body), { gameId: 'delta', accountId: 'account_1', purpose: 'ACCOUNT_DISPLAY', mime: 'image/png', size: file.size, transport: 'OSS_POST' });
  assert.equal(calls[1][1].credentials, 'omit');
  assert.equal(calls[1][1].redirect, 'error');
  assert.equal(calls[1][1].headers, undefined);
  assert.deepEqual([...calls[1][1].body.keys()], ['key', 'policy', 'file']);
  assert.equal(await calls[1][1].body.get('file').text(), await file.text());
  assert.deepEqual(JSON.parse(calls[2][1].body), { uploadToken: 'fixture-intent-token', contentHash: createHash('sha256').update(await file.text()).digest('hex') });
  assert.equal(identityChecks, 2);
  assert.equal(asset.assetId, 'asset_sample');
});


/* --- Supply Workspace Guards Tests --- */
import { freezeRequest, IdentityPauseGate, isCurrentQuery, mergePageById } from '../src/lib/supply-workspace-guards.ts';

const tickGuards = () => new Promise((resolve) => setImmediate(resolve));

test('temporary identity failure pauses a same-user queue without losing its context', async () => {
  let identity = 'user-a';
  let epoch = 7;
  let sends = 0;
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.startCheck();

  const queued = (async () => {
    if (await gate.wait(() => identity === 'user-a' && epoch === 7)) sends += 1;
  })();
  await tickGuards();
  assert.equal(sends, 0);
  gate.markFailed();
  await tickGuards();
  assert.equal(sends, 0);

  gate.markConfirmed();
  assert.equal(await queued, undefined);
  assert.equal(sends, 1);
});

test('an identity/object change cancels the old queued operation', async () => {
  let identity = 'user-a';
  let epoch = 3;
  let sends = 0;
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.startCheck();
  const queued = (async () => {
    if (await gate.wait(() => identity === 'user-a' && epoch === 3)) sends += 1;
  })();

  identity = 'user-b';
  epoch += 1;
  gate.cancel();
  await queued;
  assert.equal(sends, 0);
});

test('canceling an object transition leaves a confirmed gate open without focus confirmation', async () => {
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.cancelWaiters();
  assert.equal(await gate.wait(() => true), true);
});

test('replay uses the frozen request body and idempotency key', async () => {
  const source = { expectedRevision: '4', inventory: [{ itemId: 'haff', quantity: '10000000' }] };
  const request = freezeRequest(source, 'save-key-a');
  source.inventory[0].quantity = '9';
  assert.equal(request.body.inventory[0].quantity, '10000000');
  assert.equal(request.key, 'save-key-a');
  assert.throws(() => { request.body.inventory[0].quantity = '8'; }, TypeError);
});

test('a retried save request sends the same body and key exactly once per attempt', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const body = { title: 'retry', expectedRevision: '4', inventory: [{ itemId: 'haff', quantity: '10000000' }] };
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) throw new Error('connection closed after request');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(() => supplyApi.saveDraft('account-a', body, 'save-key-a'), (error) => error.status === 0);
    await supplyApi.saveDraft('account-a', body, 'save-key-a');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'), 'save-key-a');
    assert.equal(new Headers(calls[1].init.headers).get('idempotency-key'), 'save-key-a');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media bytes wait for identity recovery after an upload intent', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const gate = new IdentityPauseGate();
  let identity = 'user-a';
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).endsWith('/media/upload-intents')) {
        gate.startCheck();
        return new Response(JSON.stringify({ intentId: 'intent-a', uploadToken: 'token-a' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ assetId: 'asset-a', purpose: 'ACCOUNT_DISPLAY', reviewState: 'PENDING' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const upload = uploadSupplyMedia({ gameId: 'game-a', accountId: 'account-a', purpose: 'ACCOUNT_DISPLAY', file: new Blob(['pixels'], { type: 'image/png' }), intentKey: 'intent-key-a', uploadKey: 'upload-key-a', beforeBytesUpload: () => gate.wait(() => identity === 'user-a') });
    await tickGuards();
    assert.equal(calls.length, 1);
    gate.markConfirmed();
    assert.equal((await upload)?.assetId, 'asset-a');
    assert.equal(calls.length, 2);
    assert.match(calls[1].input, /\/media\/uploads\/intent-a$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media bytes are not sent after the identity/object context is canceled', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const gate = new IdentityPauseGate();
  let current = true;
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      gate.startCheck();
      current = false;
      gate.cancelWaiters();
      return new Response(JSON.stringify({ intentId: 'intent-canceled', uploadToken: 'token-canceled' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await uploadSupplyMedia({ gameId: 'game-a', accountId: 'account-a', purpose: 'ACCOUNT_DISPLAY', file: new Blob(['pixels'], { type: 'image/png' }), intentKey: 'intent-key-canceled', uploadKey: 'upload-key-canceled', beforeBytesUpload: () => gate.wait(() => current) });
    assert.equal(result, null);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reverse query results are rejected and cursor pages merge without duplicates', () => {
  const first = { id: 1, key: 'game-a:category-a' };
  const second = { id: 2, key: 'game-a:category-b' };
  assert.equal(isCurrentQuery(first, second.id, second.key), false);
  assert.equal(isCurrentQuery(second, second.id, second.key), true);

  const firstPage = Array.from({ length: 50 }, (_, id) => ({ id: String(id), title: `row-${id}` }));
  const merged = mergePageById(firstPage, [{ id: '49', title: 'updated-row-49' }, { id: '50', title: 'row-50' }]);
  assert.equal(merged.length, 51);
  assert.equal(merged.find((row) => row.id === '49')?.title, 'updated-row-49');
});
