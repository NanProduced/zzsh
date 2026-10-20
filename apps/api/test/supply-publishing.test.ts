import assert from "node:assert/strict";
import test from "node:test";
import { assertCurrentRelease, freezePresentationSkin, quoteListing, readDraftSkinSummary, readPresentation, readResourceIncomePreview } from "../src/supply/publishing";
import { createCatalogEntry, updateCatalogEntry } from "../src/supply/catalog";
import { updatePriceDraft } from "../src/supply/rules";
import { assertDeltaResourceUnit, DELTA_RESOURCE_UNITS } from "../src/supply/delta-rental";

test("unquoted draft skins use current visible identities with explicit withheld and empty states, without snapshot writes", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let rows: Record<string, unknown>[] = [{ id: "skin_a", name: "干员-外观", base_name: "外观", owner_name: "干员", owner_kind: "AGENT", rarity_code: "epic", rarity_name: "史诗", rarityBasis: "PLATFORM_REFERENCE", isCollectible: false, defaultState: "NON_DEFAULT", mediaKind: "PROMO_POSTER", media_id: "media_a", category_code: "agent", category_name: "干员外观" }];
  const client = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ revision: "22", items: rows }] }; } };
  const result = await readDraftSkinSummary(client as never, "game", ["skin_a", "hidden_b"]);
  assert.equal(result.source, "CURRENT_DRAFT_SELECTION"); assert.equal(result.catalogRevision, "22"); assert.equal(result.withheld, 1);
  assert.deepEqual((result.items as Record<string, unknown>[])[0], freezePresentationSkin(rows[0]!));
  assert.equal((result.items as Record<string, unknown>[])[0]!.isCollectible, false);
  assert.equal((result.items as Record<string, unknown>[])[0]!.mediaKind, "PROMO_POSTER");
  assert.match(calls[0]!.sql, /s\.media_source->>'kind' AS "mediaKind"/);
  assert.deepEqual(calls[0]!.values, ["game", ["skin_a", "hidden_b"]]);
  for (const required of ["WITH RECURSIVE", "s.naming_state='VERIFIED'", "s.enabled=true", "s.form_visible=true", "s.category_id IN (SELECT id FROM visible)", "PUBLIC_DISPLAY", "APPROVED"]) assert(calls[0]!.sql.includes(required), required);
  assert.doesNotMatch(calls[0]!.sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  rows = [];
  assert.deepEqual(await readDraftSkinSummary(client as never, "game", []), { source: "CURRENT_DRAFT_SELECTION", catalogRevision: "22", items: [], withheld: 0 });
  assert.equal((await readDraftSkinSummary(client as never, "game", ["disabled"])).withheld, 1);
  await assert.rejects(readDraftSkinSummary({ query: async () => ({ rows: [] }) } as never, "missing", []), { status: 404 });
});

test("resource income preview uses authoritative fixed prices, exact group quantity and unknown semantics without writes",async()=>{
  const queries:string[]=[];
  const rows=[{itemId:"barrett",code:"df_billable_barrett_bullet",name:"巴雷特",unit:"ROUND",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"1",buyerUnitAmount:"0.5",ownerUnitAmount:"0.2"},{itemId:"card",code:"df_billable_top_insure_card",name:"保险卡",unit:"DAY",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"1",buyerUnitAmount:"5",ownerUnitAmount:"3"},{itemId:"six",code:"level6_round",name:"六级",unit:"ROUND",enabled:true,pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:"8",ownerUnitAmount:"4"},{itemId:"day",code:"legacy_day",name:"旧天",unit:"DAY",enabled:false,pricingKind:null}];
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

test("resource price configuration refuses a grouped price for per-round Barrett and per-day insurance",async()=>{
  for(const code of ['df_billable_barrett_bullet','df_billable_top_insure_card']){
    const client={query:async(sql:string)=>sql.startsWith('SELECT * FROM')?{rows:[{id:'p',game_id:'g',status:'DRAFT',revision:'1',mode:'SPREAD',haff_rule:null}]}:sql.includes('FROM "zzsh_supply"."billable_item"')?{rows:[{id:'i',code,unit:code==='df_billable_top_insure_card'?'DAY':'ROUND',gameId:'g'}]}:{rows:[],rowCount:0}};
    await assert.rejects(()=>updatePriceDraft(client as never,'admin',true,'p',{expectedRevision:'1',lines:[{itemId:'i',pricingKind:'FIXED_UNIT',unitQuantity:'60',buyerUnitAmount:'5',ownerUnitAmount:'3'}]}),/份量必须为1/);
  }
});

test("only original DAY insurance is a current resource; generic PIECE items and historical projections remain intact",()=>{
 assert.equal(DELTA_RESOURCE_UNITS.df_billable_top_insure_card,'DAY');assert.equal(DELTA_RESOURCE_UNITS.top_insure_card_piece,undefined);
 assert.doesNotThrow(()=>assertDeltaResourceUnit('df_billable_top_insure_card','DAY',0));
 for(const code of ['top_insure_card_piece','df_billable_top_insure_card_piece'])for(const unit of ['PIECE','DAY'])assert.throws(()=>assertDeltaResourceUnit(code,unit),/基础单位为天/);
 assert.throws(()=>assertDeltaResourceUnit('df_billable_top_insure_card','PIECE'),/基础单位/);assert.throws(()=>assertDeltaResourceUnit('df_billable_top_insure_card','DAY',1),/基础单位/);
 assert.doesNotThrow(()=>assertDeltaResourceUnit('coffee','PIECE'));assert.doesNotThrow(()=>assertDeltaResourceUnit('level6_armor','PIECE'));
});

test("retired insurance cannot acquire a new price or income projection even with an enabled stale catalog row",async()=>{
 for(const code of ['top_insure_card_piece','df_billable_top_insure_card_piece']){
  const row={itemId:'wrong',code,name:'保险卡',unit:'PIECE',enabled:true,pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'5',ownerUnitAmount:'3'};
  const client={query:async(sql:string)=>({rows:sql.includes('commission_rate')?[{releaseId:'r',generation:'1',priceVersionId:'p',catalogRevision:'1',mode:'SPREAD',commissionRate:null,roundingPolicy:'HALF_UP_CENT_V1'}]:[row]})};
  const empty=await readResourceIncomePreview(client as never,'g',[],{releaseId:'r',catalogRevision:'1'});assert.deepEqual(empty.lines,[]);assert.equal(empty.ownerTotal,null);
  await assert.rejects(()=>readResourceIncomePreview(client as never,'g',[{itemId:'wrong',quantity:'3'}],{releaseId:'r',catalogRevision:'1'}),/基础单位为天/);
  const queries:string[]=[],priceClient={query:async(sql:string)=>{queries.push(sql);return sql.startsWith('SELECT * FROM')?{rows:[{id:'p',game_id:'g',status:'DRAFT',revision:'1',mode:'SPREAD',haff_rule:null}]}:sql.includes('FROM "zzsh_supply"."billable_item"')?{rows:[{id:'wrong',code,unit:'PIECE',gameId:'g'}]}:{rows:[],rowCount:0};}};
  await assert.rejects(()=>updatePriceDraft(priceClient as never,'admin',true,'p',{expectedRevision:'1',lines:[{itemId:'wrong',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'5',ownerUnitAmount:'3'}]}),/基础单位为天/);
  assert.equal(queries.some(sql=>/^(INSERT INTO|DELETE FROM) "zzsh_supply"."price_line"/.test(sql)),false);
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

// SKIN-MODEL-7 A: a new quote/presentation snapshot freezes owner type and quality facts
// (null = not known when frozen). Snapshots written before these keys existed keep them
// absent: readPresentation may still fill category labels, never type or quality.
test("SK7 new snapshots freeze owner type and quality; unknown is an explicit null", () => {
  const row = { id: "skin-a", name: "露娜-黑·天际线", base_name: "黑·天际线", owner_name: "露娜", owner_kind: "AGENT", rarity_code: "q_fixture", rarity_name: "测试品质", media_id: null, category_code: "df_skin_category_agent", category_name: "干员外观" };
  assert.deepEqual(freezePresentationSkin(row), { id: "skin-a", name: "露娜-黑·天际线", baseName: "黑·天际线", ownerName: "露娜", ownerKind: "AGENT", rarityCode: "q_fixture", rarityName: "测试品质", rarityBasis: null, isCollectible: null, defaultState: "UNKNOWN", mediaKind: null, mediaId: null, categoryCode: "df_skin_category_agent", categoryName: "干员外观" });
  const unknown = freezePresentationSkin({ ...row, owner_kind: null, rarity_code: null, rarity_name: undefined });
  assert.equal(unknown.ownerKind, null); assert.equal(unknown.rarityCode, null); assert.equal(unknown.rarityName, null);
  assert.equal(unknown.rarityBasis, null); assert.equal(unknown.isCollectible, null); assert.equal(unknown.defaultState, "UNKNOWN"); assert.equal(unknown.mediaKind, null);
  const source = quoteListing.toString();
  assert.ok(source.includes("s.owner_kind,s.rarity_code,"), "quote reads owner kind and quality code");
  assert.ok(source.includes("AS rarity_name"), "quote reads the quality name through the shared helper");
  assert.ok(source.includes("skins.map(freezePresentationSkin)"), "the snapshot uses the single freeze function");
  assert.ok(source.includes("publicSkinMetadataSql"), "quote reads quality basis, collectible and default facts through the shared helper");
});

test("SK7 an old snapshot without type or quality stays without them; category labels may still be filled", async () => {
  const result = await readPresentation(
    { query: async (sql: string) => { assert.doesNotMatch(sql, /media_source|mediaKind/); return { rows: [{ id: "skin-old", categoryCode: "df_skin_category_agent", categoryName: "干员外观", ownerKind: "AGENT", rarityCode: "q_now", rarityName: "当前品质", rarityBasis: "OFFICIAL", isCollectible: true, defaultState: "NON_DEFAULT", mediaKind: "PROMO_POSTER" }] }; } } as never,
    { presentation: { items: [], skins: [{ id: "skin-old", name: "旧快照皮肤" }] } } as never,
  );
  assert.deepEqual(result.skins, [{ id: "skin-old", name: "旧快照皮肤", categoryCode: "df_skin_category_agent", categoryName: "干员外观" }]);
  for (const key of ["ownerKind", "rarityCode", "rarityName", "rarityBasis", "isCollectible", "defaultState", "mediaKind"]) assert.equal(Object.hasOwn((result.skins as object[])[0]!, key), false, `${key} is not back-filled from today's catalog`);
  const frozen = await readPresentation(
    { query: async () => ({ rows: [{ id: "skin-new", categoryCode: "c", categoryName: "C", rarityName: "当前品质" }] }) } as never,
    { presentation: { items: [], skins: [{ id: "skin-new", name: "新快照皮肤", ownerKind: "AGENT", rarityCode: null, rarityName: null, categoryCode: "c", categoryName: "C" }] } } as never,
  );
  assert.equal((frozen.skins as Array<{ rarityName: unknown }>)[0]!.rarityName, null, "a frozen unknown quality is not upgraded by a later catalog change");
});

test("new skin metadata freezes known, false and unknown states without later catalog replacement", async () => {
  const row = { id: "skin-facts", name: "合成皮肤", base_name: "合成外观", owner_name: "合成干员", owner_kind: "AGENT", rarity_code: "q_fixture", rarity_name: "合成品质", media_id: null };
  for (const metadata of [
    { rarityBasis: "PLATFORM_REFERENCE", isCollectible: true, defaultState: "NON_DEFAULT" },
    { rarityBasis: "OFFICIAL", isCollectible: false, defaultState: "DEFAULT" },
    { rarityBasis: null, isCollectible: null, defaultState: "UNKNOWN" },
  ]) {
    const snapshot = freezePresentationSkin({ ...row, ...metadata });
    assert.deepEqual([snapshot.rarityBasis, snapshot.isCollectible, snapshot.defaultState], [metadata.rarityBasis, metadata.isCollectible, metadata.defaultState]);
    let reads = 0;
    const later = await readPresentation({ query: async () => {
      reads++;
      return { rows: [{ id: "skin-facts", categoryCode: "current-category", categoryName: "当前分类", rarityBasis: metadata.rarityBasis === "OFFICIAL" ? "PLATFORM_REFERENCE" : "OFFICIAL", isCollectible: metadata.isCollectible !== true, defaultState: metadata.defaultState === "DEFAULT" ? "NON_DEFAULT" : "DEFAULT" }] };
    } } as never, { presentation: { items: [], skins: [snapshot] } } as never);
    assert.equal(reads, 1, "exercise the category compatibility lookup rather than only the no-read path");
    assert.deepEqual(later.skins, [{ ...snapshot, categoryCode: "current-category", categoryName: "当前分类" }]);
    assert.deepEqual([snapshot.rarityBasis, snapshot.isCollectible, snapshot.defaultState], [metadata.rarityBasis, metadata.isCollectible, metadata.defaultState], "reading does not mutate the frozen snapshot");
  }
});

test("new presentation freezes media kind alone, including unknown, without exposing or re-reading source details", async () => {
  for (const mediaKind of ["PORTRAIT_CARD", "MODEL_IMAGE", "PROMO_POSTER", null]) {
    const frozen = freezePresentationSkin({ id: "skin-media", name: "合成外观", mediaKind, category_code: "c", category_name: "C", mediaSource: { kind: mediaKind, url: "https://private.example/source", sourceName: "素材来源" } });
    assert.equal(frozen.mediaKind, mediaKind);
    assert.equal(Object.hasOwn(frozen, "mediaSource"), false);
    assert.equal(JSON.stringify(frozen).includes("private.example"), false);
    const result = await readPresentation({ query: async () => { throw new Error("Frozen media kind must not query today's catalog"); } } as never, { presentation: { items: [], skins: [frozen] } } as never);
    assert.equal((result.skins as Record<string, unknown>[])[0]!.mediaKind, mediaKind);
  }
});
