import assert from "node:assert/strict";
import test from "node:test";
import { assertCurrentRelease, readPresentation, readResourceIncomePreview } from "../src/supply/publishing";
import { createCatalogEntry, updateCatalogEntry } from "../src/supply/catalog";
import { updatePriceDraft } from "../src/supply/rules";

test("resource income preview uses authoritative fixed prices, exact group quantity and unknown semantics without writes",async()=>{
  const queries:string[]=[];
  const rows=[{itemId:"barrett",code:"df_billable_barrett_bullet",name:"巴雷特",unit:"ROUND",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"1",buyerUnitAmount:"0.5",ownerUnitAmount:"0.2"},{itemId:"card",code:"top_insure_card_piece",name:"保险卡",unit:"PIECE",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"1",buyerUnitAmount:"5",ownerUnitAmount:"3"},{itemId:"six",code:"level6_round",name:"六级",unit:"ROUND",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:"8",ownerUnitAmount:"4"},{itemId:"day",code:"legacy_day",name:"旧天",unit:"DAY",enabled:false,pricingKind:null}];
  const client={query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('commission_rate')?[{releaseId:"release",generation:"2",priceVersionId:"price",catalogRevision:"92",mode:"SPREAD",commissionRate:null,roundingPolicy:"HALF_UP_CENT_V1"}]:rows};}};
  const binding={releaseId:"release",catalogRevision:"92"};
  const empty=await readResourceIncomePreview(client as never,"game",[],binding);assert.equal(empty.available,true);assert.equal(empty.ownerTotal,null);
  const priced=await readResourceIncomePreview(client as never,"game",[{itemId:"barrett",quantity:"2"},{itemId:"card",quantity:"3"},{itemId:"six",quantity:"120"}],binding);
  assert.equal(priced.ownerTotal?.amount,"17.40");assert.equal(priced.lines?.find(row=>row.itemId==="six")?.ownerAmount?.amount,"8.00");
  const zero=await readResourceIncomePreview(client as never,"game",[{itemId:"barrett",quantity:"0"}],binding);assert.equal(zero.ownerTotal?.amount,"0.00");
  const unpriced=await readResourceIncomePreview(client as never,"game",[{itemId:"day",quantity:"3"}],binding);assert.equal(unpriced.ownerTotal,null);assert.deepEqual(unpriced.unpricedItemIds,["day"]);
  await assert.rejects(()=>readResourceIncomePreview(client as never,"game",[{itemId:"foreign",quantity:"2"}],binding));
  await assert.rejects(()=>readResourceIncomePreview(client as never,"game",[{itemId:"six",quantity:"1.5"}],binding));
  await assert.rejects(()=>readResourceIncomePreview(client as never,"game",[],{...binding,catalogRevision:"91"}));
  assert.equal(queries.some(sql=>/^(INSERT|UPDATE|DELETE|ALTER)/.test(sql)),false);
});

test("Barrett and insurance catalog identities reject incorrect units and fractional quantities",async()=>{
  const client={query:async()=>({rows:[{id:'g'}],rowCount:1})};
  for(const body of [{code:'df_billable_barrett_bullet',unit:'PIECE'}, {code:'top_insure_card_piece',unit:'DAY'}, {code:'df_billable_top_insure_card',unit:'PIECE'}, {code:'top_insure_card_piece',unit:'PIECE',quantityScale:1}]) await assert.rejects(()=>createCatalogEntry(client as never,'admin',true,'items','g',{name:'resource',...body}),/基础单位/);
});

test("resource price configuration refuses a grouped price for per-round Barrett and per-card insurance",async()=>{
  for(const code of ['df_billable_barrett_bullet','top_insure_card_piece']){
    const client={query:async(sql:string)=>sql.startsWith('SELECT * FROM')?{rows:[{id:'p',game_id:'g',status:'DRAFT',revision:'1',mode:'SPREAD',haff_rule:null}]}:sql.includes('FROM "zzsh_supply"."billable_item"')?{rows:[{id:'i',code,unit:code==='top_insure_card_piece'?'PIECE':'ROUND',gameId:'g'}]}:{rows:[],rowCount:0}};
    await assert.rejects(()=>updatePriceDraft(client as never,'admin',true,'p',{expectedRevision:'1',lines:[{itemId:'i',pricingKind:'FIXED_UNIT',unitQuantity:'60',buyerUnitAmount:'5',ownerUnitAmount:'3'}]}),/份量必须为1/);
  }
});

test("referenced inventory units cannot be changed in place even when renaming remains legal", async()=>{
  const queries:string[]=[];
  const client={query:async(sql:string)=>{
    queries.push(sql);
    if(sql.startsWith('SELECT * FROM')) return {rows:[{id:'legacy-day',game_id:'g',unit:'DAY',quantity_scale:0}]};
    if(sql.startsWith('SELECT 1 FROM zzsh_supply.inventory_line')) return {rows:[{}],rowCount:1};
    return {rows:[],rowCount:0};
  }};
  await assert.rejects(()=>updateCatalogEntry(client as never,'admin',true,'items','legacy-day',{unit:'PIECE'}),/独立目录身份/);
  assert.ok(queries[0]?.endsWith(' FOR UPDATE'));
  assert.equal(queries.some(sql=>/^(UPDATE|INSERT)/.test(sql)),false);
});

test("quote confirmation locks the game and refuses stale catalog/release without rewriting frozen published snapshots",async()=>{
  const queries:string[]=[];
  const client={query:async(sql:string)=>{queries.push(sql);return {rows:[{current_release_id:'r1',catalog_revision:'89'}]};}};
  const account={game_id:'g'};
  const version={rule_release_id:'r1',origin:'NATIVE',review_state:'DRAFT',payload:{ruleRefs:{catalogRevision:'89'}}};
  await assertCurrentRelease(client as never,account as never,version as never);
  assert.ok(queries[0]?.endsWith(' FOR SHARE'));
  for(const changes of [{rule_release_id:'r0'},{payload:{ruleRefs:{catalogRevision:'88'}}},{payload:{ruleRefs:{}}}])await assert.rejects(()=>assertCurrentRelease(client as never,account as never,{...version,...changes} as never));
  await assertCurrentRelease(client as never,account as never,{...version,review_state:'PUBLISHED',payload:{ruleRefs:{}}} as never);
  assert.deepEqual(version.payload.ruleRefs,{catalogRevision:'89'});
});

test("readPresentation only fills missing snapshot presentation fields", async () => {
  const result = await readPresentation(
    {
      query: async () => ({
        rows: [
          { id: "item-a", code: "current-code", name: "当前目录新名", unit: "DAY" },
          { id: "item-b", code: "current-code-b", name: "当前目录新名B", unit: "PIECE" },
        ],
      }),
    } as never,
    {
      presentation: {
        items: [
          { id: "item-a", name: "审核时旧名", unit: "ROUND" },
          { id: "item-b", code: "snapshot-code-b", name: "审核时旧名B", unit: "HAFF_BASE" },
        ],
        skins: [
          { id: "skin-a", name: "旧皮肤", categoryName: "旧分类" },
          { id: "skin-b", name: "完整旧皮肤", categoryCode: "snapshot-category", categoryName: "完整旧分类" },
        ],
      },
    } as never,
  );

  assert.deepEqual(result.items, [
    { id: "item-a", code: "current-code", name: "审核时旧名", unit: "ROUND" },
    { id: "item-b", code: "snapshot-code-b", name: "审核时旧名B", unit: "HAFF_BASE" },
  ]);
  assert.deepEqual(result.skins, [
    { id: "skin-a", name: "旧皮肤", categoryName: "旧分类" },
    { id: "skin-b", name: "完整旧皮肤", categoryCode: "snapshot-category", categoryName: "完整旧分类" },
  ]);
});

test("empty presentation is not filled from the current catalog", async () => {
  let queried = false;
  const result = await readPresentation(
    { query: async () => { queried = true; return { rows: [] }; } } as never,
    { presentation: {} } as never,
  );
  assert.equal(queried, false);
  assert.deepEqual(result, {});
});

test("readPresentation fills both missing skin category fields without changing existing labels", async () => {
  const result = await readPresentation(
    {
      query: async () => ({ rows: [{ id: "skin-a", categoryCode: "current-category", categoryName: "当前分类" }] }),
    } as never,
    {
      presentation: {
        items: [],
        skins: [{ id: "skin-a", name: "皮肤", categoryName: "审核分类" }],
      },
    } as never,
  );

  assert.deepEqual(result.skins, [{ id: "skin-a", name: "皮肤", categoryName: "审核分类", categoryCode: "current-category" }]);
});
