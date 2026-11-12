import assert from "node:assert/strict";
import test from "node:test";
import { acceptListingRules, assertCurrentRelease, createListingDraft, delistListing, evaluatePublication, freezePresentationSkin, listingDetail, listingPageShared, orderAccountTitleFact, publicListingAttributes, publicListingBasis, publicationBlockers, publicationWaiverRevision, quoteListing, readDraftSkinSummary, readPresentation, readResourceIncomePreview, reviewListing, saveListingDraft, submitListing } from "../src/supply/publishing";
import { createCatalogEntry, updateCatalogEntry } from "../src/supply/catalog";
import { updatePriceDraft } from "../src/supply/rules";
import { assertDeltaResourceUnit, DELTA_RESOURCE_UNITS, validateDeltaPublicationAttributes } from "../src/supply/delta-rental";
import { readLegacyPublishedReference } from "../src/supply/legacy-published-reference";
import { assertActiveInTransaction, assertUserContextInTransaction } from "../src/auth/user-identity";
import { syntheticPublicationCreditGate } from "./funding-authority-fixtures";

test("synthetic publication gate binds the current draft without changing published or unknown gates", async () => {
  const row = { owner: "owner", game: "game", version: "version", state: "DRAFT", release: "release", price: "price" };
  const client = { query: async (_sql: string, values: string[]) => ({ rows: values[0] === "account" ? [row] : [] }) };
  const gate = { publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "fixture" } as const;
  const bound = await syntheticPublicationCreditGate(client as never, "account", gate);
  assert.deepEqual(bound.creditGuarantee, { status: "NOT_REQUIRED", accountId: "account", ownerUserId: "owner", gameId: "game",
    listingVersionId: "version", priceVersionId: "price", releaseId: "release", creditRevision: "1", coverageRevision: null, requiredCents: "0", reference: "fixture" });
  assert.equal(await syntheticPublicationCreditGate(client as never, "other", gate), gate);
  row.state = "PUBLISHED";
  assert.equal(await syntheticPublicationCreditGate(client as never, "account", gate), gate);
  const unknown = { publisherBail: "UNKNOWN", occupancy: "FREE", reference: null } as const;
  assert.equal(await syntheticPublicationCreditGate(client as never, "account", unknown), unknown);
});

test("a migrated account with no current version remains read-only", async () => {
  const account = { id: "a", game_id: "g", current_version_id: null, display_no: null };
  const client = { query: async () => ({ rows: [{ retired: true }] }) };
  const detail = await listingDetail(client as never, account as never, "owner", (() => { throw new Error("unused gate"); }) as never);
  assert.equal(detail.version, null); assert.equal(detail.available, false);
  assert.deepEqual(detail.blockers, ["LEGACY_LISTING_RELIST_REQUIRED"]);
});

test("identity READ purpose omits row locks while every existing default WRITE keeps the original lock", async () => {
  for (const purpose of [undefined, "WRITE", "READ"] as const) {
    const sqls: string[] = [];
    const client = { query: async (sql: string) => { sqls.push(sql); return { rows: [{ suspended: false, accountStatus: "ACTIVE" }], rowCount: 1 }; } };
    await assertUserContextInTransaction(client as never, { userId: "fixture_owner", sessionId: "fixture_session" }, purpose);
    assert.equal(sqls.some(sql => /FOR UPDATE/.test(sql)), purpose !== "READ");
    assert.equal(sqls.filter(sql => sql.includes('"expiresAt">clock_timestamp()')).length, 1);
    sqls.length = 0; await assertActiveInTransaction(client as never, "fixture_owner", purpose);
    assert.equal(sqls.some(sql => /FOR UPDATE/.test(sql)), purpose !== "READ");
  }
});

test("unquoted draft skins use current visible identities with explicit withheld and empty states, without snapshot writes", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let rows: Record<string, unknown>[] = [{ id: "skin_a", name: "干员-外观", base_name: "外观", owner_name: "干员", owner_kind: "AGENT", rarity_code: "epic", rarity_name: "史诗", rarityBasis: "PLATFORM_REFERENCE", isCollectible: false, defaultState: "NON_DEFAULT", mediaKind: "PROMO_POSTER", media_id: "media_a", category_retired: true, category_code: null, category_name: null }];
  const client = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ revision: "22", items: rows }] }; } };
  const result = await readDraftSkinSummary(client as never, "game", ["skin_a", "hidden_b"]);
  assert.equal(result.source, "CURRENT_DRAFT_SELECTION"); assert.equal(result.catalogRevision, "22"); assert.equal(result.withheld, 1);
  assert.deepEqual((result.items as Record<string, unknown>[])[0], freezePresentationSkin(rows[0]!));
  assert.equal((result.items as Record<string, unknown>[])[0]!.isCollectible, false);
  assert.equal((result.items as Record<string, unknown>[])[0]!.mediaKind, "PROMO_POSTER");
  assert.equal((result.items as Record<string, unknown>[])[0]!.categoryModel, "RETIRED");
  assert.match(calls[0]!.sql, /s\.media_source->>'kind' AS "mediaKind"/);
  assert.deepEqual(calls[0]!.values, ["game", ["skin_a", "hidden_b"]]);
  for (const required of ["s.game_id=$1", "s.id=ANY($2::text[])", "s.naming_state='VERIFIED'", "s.enabled=true", "s.form_visible=true", "true AS category_retired", "NULL::text AS category_code", "PUBLIC_DISPLAY", "APPROVED"]) assert(calls[0]!.sql.includes(required), required);
  assert.doesNotMatch(calls[0]!.sql, /\bskin_category\b|\bcategory_id\b/);
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
    const client={query:async(sql:string)=>sql.startsWith('SELECT * FROM')?{rows:[{id:'p',game_id:'g',status:'DRAFT',revision:'1',mode:'SPREAD',haff_rule:null}]}:sql.includes('FROM "zzsh_supply"."billable_item"')?{rows:[{id:'i',code,unit:code==='df_billable_top_insure_card'?'DAY':'ROUND',quantityScale:0,gameId:'g'}]}:{rows:[],rowCount:0}};
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
  const queries:string[]=[],priceClient={query:async(sql:string)=>{queries.push(sql);return sql.startsWith('SELECT * FROM')?{rows:[{id:'p',game_id:'g',status:'DRAFT',revision:'1',mode:'SPREAD',haff_rule:null}]}:sql.includes('FROM "zzsh_supply"."billable_item"')?{rows:[{id:'wrong',code,unit:'PIECE',quantityScale:0,gameId:'g'}]}:{rows:[],rowCount:0};}};
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
    { id: "item-a", code: "current-code", name: "审核时旧名", unit: "ROUND", mediaId: null },
    { id: "item-b", code: "snapshot-code-b", name: "审核时旧名B", unit: "HAFF_BASE", mediaId: null },
  ]);
  assert.deepEqual(result.skins, [
    { id: "skin-a", name: "旧皮肤", categoryName: "旧分类" },
    { id: "skin-b", name: "完整旧皮肤", categoryCode: "snapshot-category", categoryName: "完整旧分类" },
  ]);
});

test("current item media is projected once per presentation and cannot replace frozen labels or source data", async () => {
  const presentation = { items: [{ id: "a", name: "历史名称", code: "frozen", unit: "ROUND", mediaId: "unsafe_snapshot" }, { id: "b", name: "未匹配项", code: "b", unit: "DAY" }], skins: [] };
  const before = JSON.stringify(presentation), queries: string[] = [];
  const result = await readPresentation({ query: async (sql: string, params: unknown[]) => {
    queries.push(sql); assert.deepEqual(params, [["a", "b"], "account_a"]);
    assert.match(sql, /a\.game_id=i\.game_id/); assert.match(sql, /m\.game_id=i\.game_id/);
    for (const gate of ["PLATFORM_CATALOG", "ITEM_MEDIA", "APPROVED", "PUBLIC_DISPLAY", "public_storage_key"]) assert.ok(sql.includes(gate));
    return { rows: [{ id: "a", name: "当前名称", code: "current", unit: "DAY", mediaId: "safe_current" }] };
  } } as never, { account_id: "account_a", presentation } as never);
  assert.equal(queries.length, 1); assert.equal(JSON.stringify(presentation), before);
  assert.deepEqual(result.items, [{ ...presentation.items[0], mediaId: "safe_current" }, { ...presentation.items[1], mediaId: null }]);
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

test("readPresentation preserves existing category labels without guessing a missing field", async () => {
  let queried = false;
  const result = await readPresentation(
    {
      query: async () => { queried = true; return { rows: [{ id: "skin-a", categoryCode: "current-category", categoryName: "当前分类" }] }; },
    } as never,
    {
      presentation: {
        items: [],
        skins: [{ id: "skin-a", name: "皮肤", categoryName: "审核分类" }],
      },
    } as never,
  );

  assert.deepEqual(result.skins, [{ id: "skin-a", name: "皮肤", categoryName: "审核分类" }]);
  assert.equal(queried, false);
});

// SKIN-MODEL-7 A: a new quote/presentation snapshot freezes owner type and quality facts
// (null = not known when frozen). Snapshots written before these keys existed keep them
// absent: readPresentation never guesses category labels, type or quality.
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

test("SK7 an old snapshot without type, quality or category stays without them", async () => {
  let reads = 0;
  const result = await readPresentation(
    { query: async () => { reads++; return { rows: [] }; } } as never,
    { presentation: { items: [], skins: [{ id: "skin-old", name: "旧快照皮肤" }] } } as never,
  );
  assert.deepEqual(result.skins, [{ id: "skin-old", name: "旧快照皮肤" }]);
  assert.equal(reads, 0);
  for (const key of ["categoryCode", "categoryName", "ownerKind", "rarityCode", "rarityName", "rarityBasis", "isCollectible", "defaultState", "mediaKind"]) assert.equal(Object.hasOwn((result.skins as object[])[0]!, key), false, `${key} is not back-filled from today's catalog`);
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
    assert.equal(reads, 0, "skin-only presentation must not read today's catalog");
    assert.deepEqual(later.skins, [snapshot]);
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

const nativeGate = async () => ({ publisherBail: "NOT_REQUIRED" as const, occupancy: "FREE" as const, reference: "fixture" });
function nativeGateClient(acceptance = false, migrated = false) {
  return { query: async (sql: string) => {
    if (sql.includes("zzsh_auth_user")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }], rowCount: 1 };
    if (sql.includes("AS retired")) return { rows: [{ retired: migrated }], rowCount: 1 };
    if (sql.includes("FROM zzsh_supply.game WHERE id=$1")) return { rows: [{ id: "g", code: "delta", name: "三角洲", enabled: true, current_release_id: "rel", catalog_revision: "1" }], rowCount: 1 };
    if (sql.includes("game_service_operation")) return { rows: [{ id: "s", gameId: "g", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
    if (sql.includes("rule_acceptance")) return { rows: acceptance ? [{ ok: 1 }] : [], rowCount: acceptance ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } };
}
const nativeAccount = { id: "a", owner_user_id: "o", game_id: "g", current_version_id: "v", lifecycle: "ACTIVE", legacy_hold: "NONE", revision: "1", owner_paused: false, staff_restricted: false, display_no: null };

test("admin approval cannot publish an account that has already been published", async () => {
  const sqls: string[] = [], digest = "a".repeat(64);
  const version = { id: "v", account_id: "a", origin: "NATIVE", review_state: "SUBMITTED", rule_release_id: "rel", content_hash: digest, payload: {} };
  const client = { query: async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("FROM zzsh_supply.listing_version")) return { rows: [version], rowCount: 1 };
    if (sql.includes("SELECT current_release_id")) return { rows: [{ current_release_id: "rel", catalog_revision: "1" }], rowCount: 1 };
    if (sql.includes("AS retired")) return { rows: [{ retired: false }], rowCount: 1 };
    if (sql.includes("FROM zzsh_supply.listing_publication")) return { rows: [{}], rowCount: 1 };
    throw new Error("unexpected query");
  } };
  await assert.rejects(() => reviewListing(client as never, nativeAccount as never, "admin", { expectedRevision: "1", versionId: "v", releaseId: "rel", contentHash: digest, decision: "APPROVE", reason: "核对资料" }, nativeGate), /已上架账号不能修改/);
  assert.equal(sqls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test("an authoritative completed rental blocks publication even when the old account lifecycle remains active and free", async () => {
  const draft = { id: "v", account_id: "a", origin: "NATIVE", review_state: "DRAFT", rule_release_id: null, content_hash: null, payload: null, attributes: {}, title: "" };
  for (const purpose of ["READ", "WRITE"] as const) {
    const base = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, draft as never, nativeGate, purpose);
    const completed = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, draft as never, async (_client, _account, readPurpose) => {
      assert.equal(readPurpose, purpose);
      return { ...await nativeGate(), rentalCompleted: true };
    }, purpose);
    assert.equal(completed.includes("RENTAL_COMPLETED"), true);
    assert.deepEqual(completed.filter(reason => reason !== "RENTAL_COMPLETED"), base, "existing blockers are unchanged");
    const absent = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, draft as never, async () => ({ ...await nativeGate(), rentalCompleted: false }), purpose);
    assert.equal(absent.includes("RENTAL_COMPLETED"), false, "free occupancy or a missing completion fact never invents a terminal result");
  }
});

test("retired migrated accounts and delisted accounts cannot publish again", async () => {
  const draft = { id: "v", account_id: "a", origin: "NATIVE", review_state: "DRAFT", rule_release_id: null, content_hash: null, payload: null, attributes: {}, title: "" };
  const migrated = await publicationBlockers(nativeGateClient(false, true) as never, nativeAccount as never, draft as never, nativeGate, "WRITE");
  assert.equal(migrated.includes("LEGACY_LISTING_RELIST_REQUIRED"), true);
  const migratedClient = nativeGateClient(false, true);
  const sharedRead = await publicationBlockers(migratedClient as never, nativeAccount as never, draft as never, nativeGate, "READ", false, listingPageShared(migratedClient as never));
  assert.equal(sharedRead.includes("LEGACY_LISTING_RELIST_REQUIRED"), true, "shared admin reads cannot re-expose a migrated account");
  const delisted = await publicationBlockers(nativeGateClient() as never, { ...nativeAccount, lifecycle: "DELISTED" } as never, draft as never, nativeGate, "WRITE");
  assert.equal(delisted.includes("ACCOUNT_DELISTED"), true);
  const native = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, draft as never, nativeGate, "WRITE");
  assert.equal(native.includes("LEGACY_LISTING_RELIST_REQUIRED"), false);
  const settled = await publicationBlockers(nativeGateClient() as never, { ...nativeAccount, legacy_hold: "NONE" } as never, draft as never, async () => ({ ...await nativeGate(), rentalCompleted: true }), "WRITE");
  assert.equal(settled.includes("RENTAL_COMPLETED"), true, "a settled rental must not return to a listing");
});

test("a delisted account cannot be delisted again", async () => {
  const client = { query: async () => { throw new Error("a closed account must not write"); } };
  const account = { ...nativeAccount, owner_user_id: "owner", lifecycle: "DELISTED", revision: "1" };
  await assert.rejects(() => delistListing(client as never, account as never, { expectedRevision: "1" }, { userId: "owner", sessionId: "s", requestId: "r" }), /已结束出租/);
});

test("publication freezes only an authoritative account-bound credit waiver", () => {
  const account = { id: "a", owner_user_id: "owner", game_id: "game" } as any;
  const version = { id: "v", rule_release_id: "release", payload: { ruleRefs: { priceVersionId: "price" } } } as any;
  const credit = { status: "NOT_REQUIRED", accountId: "a", ownerUserId: "owner", gameId: "game", listingVersionId: "v",
    releaseId: "release", priceVersionId: "price", reference: "ref", creditRevision: "4", coverageRevision: null, requiredCents: "0" } as const;
  const gate = { publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "ref", creditGuarantee: credit } as const;
  assert.equal(publicationWaiverRevision(account, version, gate), "4");
  assert.throws(() => publicationWaiverRevision(account, version, { ...gate, creditGuarantee: { ...credit, ownerUserId: "other" } }));
  assert.throws(() => publicationWaiverRevision(account, version, { ...gate, creditGuarantee: { ...credit, creditRevision: null } }));
  assert.throws(() => publicationWaiverRevision(account, version, { ...gate, creditGuarantee: { ...credit, requiredCents: "1" } }));
  assert.equal(publicationWaiverRevision(account, version, { ...gate, publisherBail: "SATISFIED", creditGuarantee: { ...credit, status: "SATISFIED", requiredCents: "500" } }), null);
  assert.throws(() => publicationWaiverRevision(account, version, { publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "old-policy" }));
  assert.throws(() => publicationWaiverRevision(account, version, { publisherBail: "SATISFIED", occupancy: "FREE", reference: "old-proof" }));
});

test("a previous publication blocks every draft mutation even if a later draft already exists", async () => {
  const client = { query: async (sql: string) => {
    if (sql.includes('SELECT "suspended"')) return { rows: [{ suspended: false }], rowCount: 1 };
    if (sql.includes('user_identity_state')) return { rows: [], rowCount: 0 };
    if (sql.includes('game_service_operation')) return { rows: [{ id: "s", gameId: "g", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
    if (sql.includes('AS retired')) return { rows: [{ retired: false }], rowCount: 1 };
    if (sql.includes('FROM zzsh_supply.listing_publication')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM zzsh_order.rental_order')) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${sql}`);
  } } as never;
  const account = { ...nativeAccount, current_version_id: "unpublished-later-draft" } as never;
  for (const run of [
    () => createListingDraft(client, account, "1", nativeGate),
    () => saveListingDraft(client, account, { expectedRevision: "1" }, nativeGate),
    () => quoteListing(client, account, "1"),
    () => acceptListingRules(client, account, { expectedRevision: "1" }),
    () => submitListing(client, account, "o", { expectedRevision: "1" }, nativeGate),
  ]) await assert.rejects(run, /已上架账号不能修改/);
});

test("native empty title is not a write blocker; a legacy placeholder still is", async () => {
  const draft = { id: "v", account_id: "a", origin: "NATIVE", review_state: "DRAFT", rule_release_id: null, content_hash: null, payload: null, attributes: {}, title: "" };
  const write = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, draft as never, nativeGate, "WRITE");
  assert.equal(write.includes("TITLE_REVIEW_REQUIRED"), false, JSON.stringify(write));
  const legacy = await publicationBlockers(nativeGateClient() as never, { ...nativeAccount, legacy_hold: "UNRESOLVED" } as never, { ...draft, origin: "LEGACY_OBSERVATION", title: "历史资料待核实" } as never, nativeGate, "WRITE");
  assert.equal(legacy.includes("TITLE_REVIEW_REQUIRED"), true, JSON.stringify(legacy));
  assert.equal(legacy.includes("ACCOUNT_NOT_PUBLISHABLE"), true);
});

test("an unquoted native draft is one quote step, and a stale release still blocks new orders", async () => {
  const draft = { id: "v", account_id: "a", origin: "NATIVE", review_state: "DRAFT", rule_release_id: null, content_hash: null, payload: null, attributes: {}, title: "" };
  const open = await evaluatePublication(nativeGateClient() as never, nativeAccount as never, draft as never, nativeGate, "READ");
  assert.equal(open.includes("RULE_CHANGED"), false, JSON.stringify(open));
  assert.equal(open.includes("CONFIRMATION_OR_MEDIA_REQUIRED"), false, JSON.stringify(open));
  assert.equal(open.includes("QUOTE_REQUIRED"), true, JSON.stringify(open));
  assert.equal(open.includes("MEDIA_REQUIRED"), false, JSON.stringify(open));
  const stale = await publicationBlockers(nativeGateClient() as never, nativeAccount as never, { ...draft, review_state: "PUBLISHED", rule_release_id: "old-release", payload: { ruleRefs: { catalogRevision: "1" } } } as never, nativeGate, "READ");
  assert.equal(stale.includes("RULE_CHANGED"), true, JSON.stringify(stale));
  const published = { ...draft, review_state: "PUBLISHED", rule_release_id: "rel", content_hash: "a".repeat(64), payload: { ruleRefs: { catalogRevision: "1" }, declaration: { attributes: {} } } };
  const acceptance = await evaluatePublication(nativeGateClient(false) as never, nativeAccount as never, published as never, nativeGate, "READ");
  assert.equal(acceptance.includes("ACCEPTANCE_REQUIRED"), true, JSON.stringify(acceptance));
  assert.equal(acceptance.includes("MEDIA_REQUIRED"), false, JSON.stringify(acceptance));
  assert.equal(acceptance.includes("CONFIRMATION_OR_MEDIA_REQUIRED"), false, JSON.stringify(acceptance));
  const media = await evaluatePublication(nativeGateClient(true) as never, nativeAccount as never, published as never, nativeGate, "READ");
  assert.equal(media.includes("MEDIA_REQUIRED"), true, JSON.stringify(media));
  assert.equal(media.includes("CONFIRMATION_OR_MEDIA_REQUIRED"), false, JSON.stringify(media));
  assert.equal(media.includes("QUOTE_REQUIRED"), false, JSON.stringify(media));
});

test("trade media qualification requires the same frozen legacy reference on the native publication", async () => {
  const base = nativeGateClient(true);
  const source = { ownerUserId: "o", gameId: "g", observationVersionId: "original", sourceDigest: "c".repeat(64),
    legacyId: "17", gradingCode: "6", displayPaths: ["accountsImage/20261103/source.png"], blockedPaths: [] as string[] };
  const client = { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.legacy_account_media_paths p")) return { rows: [source], rowCount: 1 };
    if (sql.includes("FROM zzsh_supply.listing_publication")) return { rows: [{ source: "LEGACY_APPROVED" }], rowCount: 1 };
    return base.query(sql);
  } };
  const proof = await readLegacyPublishedReference(client as never, "a");
  assert(proof);
  const attributes = { legacy_published_reference: proof.digest };
  const v = { id: "v", account_id: "a", origin: "NATIVE", review_state: "APPROVED", rule_release_id: "rel",
    content_hash: "a".repeat(64), attributes, payload: { ruleRefs: { catalogRevision: "1" }, declaration: { attributes, mediaBindings: [] } } };
  assert.deepEqual(await evaluatePublication(client as never, nativeAccount as never, v as never, nativeGate, "READ"), []);
  assert.deepEqual(await evaluatePublication(client as never, nativeAccount as never, { ...v, attributes: {} } as never, nativeGate, "READ"), ["MEDIA_REQUIRED"]);
  source.blockedPaths.push(source.displayPaths[0]!);
  assert.deepEqual(await evaluatePublication(client as never, nativeAccount as never, v as never, nativeGate, "READ"), ["MEDIA_REQUIRED"]);
  assert.equal(Object.hasOwn(publicListingAttributes(attributes), "legacy_published_reference"), false);

  const missing = { grading_code: "6", login_method_code: "legacy_login_qq", vit_level: 6, bear_level: 6, dive_level: 0 };
  assert.doesNotThrow(() => validateDeltaPublicationAttributes(missing, { requireGradingDivision: false, requireSupplementalDeclarations: false, requireServiceWindow: false }));
  assert.throws(() => validateDeltaPublicationAttributes(missing, { requireGradingDivision: false, requireSupplementalDeclarations: false }), /开始时间/);
  assert.throws(() => validateDeltaPublicationAttributes({ ...missing, service_window_start_minute: 0 },
    { requireGradingDivision: false, requireSupplementalDeclarations: false, requireServiceWindow: false }), /结束时间/);
});

test("public declaration reads face and ban as tri-state without inventing a verified face", () => {
  assert.equal(publicListingAttributes({}).face_is_self, null);
  assert.equal(publicListingAttributes({}).ban_record, null);
  assert.equal(publicListingAttributes({ face_is_self: false, ban_record: true }).face_is_self, false);
  assert.equal(publicListingAttributes({ face_is_self: false, ban_record: true }).ban_record, true);
  assert.equal(Object.hasOwn(publicListingAttributes({}), "face_recognition"), false);
  assert.equal(Object.hasOwn(publicListingAttributes({}), "grading_division"), false);
  const titles = orderAccountTitleFact({ snapshotTitle: "历史资料待核实", currentTitle: "当前标题", resourceSummary: "哈夫币 30M" });
  assert.equal(titles.orderTitle, null);
  assert.equal(titles.orderTitleSource, "UNKNOWN");
  assert.equal(titles.currentAccountTitle, "当前标题");
  assert.equal(titles.currentAccountSource, "CURRENT_ACCOUNT");
  assert.equal(titles.neutralSummary, "哈夫币 30M");
  for (const selected of [false, true, null]) {
    const basis = publicListingBasis({ versionId: "version-a", id: "a", fullPayoutSelected: selected, attributes: { full_payout_declaration: { selected: !selected } } });
    assert.equal(basis?.fullPayoutSelected, selected);
  }
  // Only the release read with this public version is forwarded; a missing one stays null.
  assert.equal(publicListingBasis({ versionId: "version-a", id: "a", releaseId: "release-public-a" })?.releaseId, "release-public-a");
  assert.equal(publicListingBasis({ versionId: "version-a", id: "a", releaseId: 42 })?.releaseId, null);
  assert.equal(publicListingBasis({ versionId: "version-a", id: "a" })?.releaseId, null);
  assert.equal(publicListingBasis({ id: "a", releaseId: "release-without-version" }), null);
  const legacyImages = [{ position: 0, url: "/api/v1/supply/listings/a/legacy-images/0" }];
  assert.deepEqual(publicListingBasis({ versionId: "version-a", id: "a", legacyImages })?.legacyImages, legacyImages);
});
