import assert from "node:assert/strict";
import test from "node:test";
import { convertLegacyDisplayFields, legacyDisplayDigest, parseLegacyDisplaySnapshot } from "../src/supply/legacy-display-snapshot";
import { recordLegacyDisplaySnapshot, readLegacyListing, buildLegacyListingCandidates, buildMixedListingCandidates, projectLegacyHistoricalRead, loadLegacyHistoricalRead, loadLegacyHistoricalReads, legacyHistoricalReadSql } from "../src/supply/legacy-listing-read";
import { legacyAdmissionSql, parseLegacyPublicAdmission } from "../src/legacy-load/legacy-public-admission";
import type { ListingQueryV2 } from "../src/supply/listing-filter-contract";

const source=()=>({ratio_type:"fast",haff:"30",awm_bullet_num:"2",level6_bullet_num:"2",level6_helmet_num:"0",level6_armor_num:"1",barrett_bullet_num:"0",coffee_num:"0",top_insure_card_num:"3",insure_lv:"9",grading_lv:"6",vit_lv:"7",bear_lv:"7",dive_lv:"0",character_lv:"60",login_way:"2",province:"浙江省",city:"杭州市",secret_kd:"1.25",processing_time_start:"23",processing_time_end:"8",high_risk_owner:0,ban_record:"1",face_is_self:"0"});
const input=()=>({observationVersionId:"v-1",baseSourceDigest:"b".repeat(64),extractSha256:"a".repeat(64),sourceUpdatedAt:"2026-09-13T00:00:00.000Z",evidenceRef:`legacy-display-v1:${"a".repeat(64)}:1`,snapshot:convertLegacyDisplayFields(source())});
test("restored units preserve M, 60-round groups, source zero and historical DAY without quoting",()=>{
  const snapshot=convertLegacyDisplayFields(source());
  assert.equal(snapshot.rentalMode,"fast");
  assert.deepEqual(snapshot.resources.map(r=>[r.quantity,r.unit]),[["30000000","HAFF_BASE"],["2","ROUND"],["120","ROUND"],["0","PIECE"],["1","PIECE"],["0","ROUND"],["0","PIECE"],["3","DAY"]]);
  assert.equal(snapshot.attributes.safe_box_code,"safe_box_3x3");
  assert.equal(snapshot.attributes.login_method_code,"legacy_login_wechat");
  assert.equal(snapshot.attributes.service_window_start_minute,1380);
  assert.equal(snapshot.attributes.service_window_end_minute,480);
  assert.equal(snapshot.attributes.service_window_cross_midnight,true);
  assert.deepEqual(snapshot.risk,{highRiskOwner:false,banRecord:true,faceIsSelf:false});
  assert.deepEqual(parseLegacyDisplaySnapshot(snapshot),snapshot);
  assert.ok(!JSON.stringify(snapshot).includes('price'));
});
test("missing, out of range, unsafe and ambiguous facts remain unknown; raw private values stay out",()=>{
  const x=convertLegacyDisplayFields({...source(),ratio_type:"future",haff:null,coffee_num:"-1",character_lv:"1954095103",processing_time_start:"8",processing_time_end:"8",province:"微信13800138000",high_risk_owner:null});
  assert.equal(x.rentalMode,null); assert.equal(x.resources[0]!.quantity,null); assert.equal(x.resources[6]!.quantity,null);
  assert.equal(x.attributes.character_level,null); assert.equal(x.attributes.region_province,null); assert.equal(x.attributes.service_window_start_minute,null);
  assert.equal(x.risk.highRiskOwner,null); assert.ok(x.issues.includes("character_lv:OUT_OF_RANGE"));
  assert.ok(!JSON.stringify(x).includes("13800138000")); assert.deepEqual(parseLegacyDisplaySnapshot(x),x);
  const midnight=convertLegacyDisplayFields({...source(),processing_time_start:"24",processing_time_end:"8"}); assert.equal(midnight.attributes.service_window_start_minute,0);
  const fullDay=convertLegacyDisplayFields({...source(),processing_time_start:"0",processing_time_end:"24"}); assert.equal(fullDay.attributes.service_window_end_minute,1440);
  assert.equal(convertLegacyDisplayFields({...source(),processing_time_start:"24",processing_time_end:"24"}).attributes.service_window_start_minute,null);
});
test("display parser rejects injected fields, bad units, levels and inconsistent windows",()=>{
  const x=convertLegacyDisplayFields(source());
  for(const broken of [{...x,secret:"private"},{...x,attributes:{...x.attributes,character_level:70}},{...x,attributes:{...x.attributes,ownerUserId:"private"}},{...x,attributes:{...x.attributes,service_window_cross_midnight:false}},{...x,resources:x.resources.map((r,i)=>i? r:{...r,unit:"M"})}]) assert.throws(()=>parseLegacyDisplaySnapshot(broken));
  const a=input(), digest=legacyDisplayDigest("a-1",a);
  assert.notEqual(digest,legacyDisplayDigest("a-1",{...a,extractSha256:"c".repeat(64)}));
  assert.notEqual(digest,legacyDisplayDigest("a-2",a));
});
test("old admission cannot authorize an added display snapshot; new digest binds every read",()=>{
  const a={schema:"legacy-public-admission-v2",sourceBatchSha256:"a".repeat(64),resource:{database:"test",oid:1,marker:"test",runtimeRole:"runtime"},records:[{accountId:"a-1",ownerUserId:"u-1",gameId:"g-1",observationVersionId:"v-1",sourceSystem:"legacy_mysql_restore",sourceEntity:"la_rental_accounts",legacyId:"1",sourceDigest:"b".repeat(64),evidenceRef:"legacy-migration-preflight-20261006:la_rental_accounts:1",sourceUpdatedAt:"2026-09-13T00:00:00.000Z",snapshot:{},title:"历史资料待核实",description:null,attributes:{},displayDigest:legacyDisplayDigest("a-1",input())}]};
  const approved=parseLegacyPublicAdmission(a); assert.throws(()=>parseLegacyPublicAdmission({...a,schema:"legacy-public-admission-v1"}));
  assert.throws(()=>parseLegacyPublicAdmission({...a,records:a.records.map(({displayDigest,...r})=>r)}));
  assert.match(legacyAdmissionSql(undefined,()=>"$1"),/d\.account_id IS NULL/);
  const q={gameId:"g-1",filters:{safeBoxCodes:["safe_box_3x3"]},q:"A-1",sort:"latest",direction:"DESC",coreItemId:null,limit:2,cursor:null} as ListingQueryV2;
  for(const build of [buildLegacyListingCandidates,buildMixedListingCandidates]){
    const sql=build(q,null,approved); assert.match(sql.text,/d\.display_digest=approved\."displayDigest"/);
    assert.match(sql.text,/risk,highRiskOwner/); assert.match(sql.text,/COALESCE\(d\.snapshot->'attributes',v\.attributes\)/);
    assert.match(sql.text,/NOT u\.suspended/); assert.match(sql.text,/h\.source_status=3/);
    assert.doesNotMatch(sql.text,/resourceNo/); assert.match(sql.text,/NOT EXISTS.*listing_publication/);
  }
});
test("maintenance writer rejects malformed payload before any SQL and revoked actor before any insert",async()=>{
  await assert.rejects(()=>recordLegacyDisplaySnapshot({query:async()=>{throw Error("NO_SQL_EXPECTED")}} as never,"a-1",{...input(),extractSha256:"bad"},{id:"admin",sessionId:"s",requestId:"r"}),/Invalid/);
  let inserts=0;
  const client={query:async(sql:string)=>{if(sql.includes("INSERT"))inserts++;return {rows:[],rowCount:0};}};
  await assert.rejects(()=>recordLegacyDisplaySnapshot(client as never,"a-1",input(),{id:"revoked-admin",sessionId:"s",requestId:"r"}));
  assert.equal(inserts,0);
});

test("shared public projection exposes safe display facts with exact historical amounts and rejects corrupt supplemental bytes",async()=>{
  const extra=input(), row={id:"a-1",game_id:"g-1",game_code:"delta",game_name:"三角洲行动",version_id:"v-1",title:"历史资料待核实",description:null,attributes:{},source_status:3,owner_paused:false,
    snapshot:{schema:"legacy-listing-read-v1",resourceNo:"A-1",haffRentYuan:"2038.00",goodsYuan:"20.00",depositYuan:"50.00",termDays:"102",dailyHaffBase:"10000000"},source_updated_at:new Date(extra.sourceUpdatedAt),evidence_ref:"legacy-migration-preflight-20261006:la_rental_accounts:1",
    display_snapshot:extra.snapshot,display_digest:legacyDisplayDigest("a-1",extra),display_version_id:extra.observationVersionId,base_source_digest:extra.baseSourceDigest,extract_sha256:extra.extractSha256,display_updated_at:new Date(extra.sourceUpdatedAt),display_evidence_ref:extra.evidenceRef};
  const client={query:async(sql:string)=>({rows:sql.startsWith("SELECT a.id,a.owner_user_id,a.display_no,g.id game_id")?[{...row,owner_user_id:"owner-fixture"}]:[],rowCount:1})};
  const result=await readLegacyListing(client as never,"a-1");
  assert.equal(result.rentalMode,"fast"); assert.equal(result.canCreateOrder,false); assert.equal(result.quote,null);
  assert.equal(result.historicalQuote.haffRent.amount,"2038.00"); assert.equal(result.historicalQuote.goods.amount,"20.00"); assert.equal(result.historicalQuote.deposit.amount,"50.00");
  assert.equal(result.inventory.length,8); assert.equal(result.inventory[0]!.quantity,"30000000"); assert.equal(result.inventory[2]!.quantity,"120");
  assert.equal(result.attributeDisplay.loginMethod?.displayName,"微信扫码");
  assert.doesNotMatch(JSON.stringify(result),/highRiskOwner|banRecord|faceIsSelf|extractSha256|evidenceRef|sourceDigest|displayDigest|ownerUserId/);
  row.display_digest="c".repeat(64); await assert.rejects(()=>readLegacyListing(client as never,"a-1"),e=>(e as {status:number}).status===404);
});

function historicalRow(accountId = "a-1", legacyId = "1") {
  const extra = { ...input(), evidenceRef: "legacy-display-v1:" + "a".repeat(64) + ":" + legacyId };
  return {
    account_id: accountId, source_status: 4, legacy_id: legacyId, owner_user_id: "owner-fixture",
    observation_version_id: extra.observationVersionId, source_digest: extra.baseSourceDigest,
    base_updated_at: new Date(extra.sourceUpdatedAt),
    snapshot: { schema: "legacy-listing-read-v1", resourceNo: "SOURCE-" + legacyId, haffRentYuan: "12.30", goodsYuan: "0.40", depositYuan: "0.00", termDays: "2", dailyHaffBase: "1000000" },
    display_account_id: accountId, display_version_id: extra.observationVersionId,
    base_source_digest: extra.baseSourceDigest, extract_sha256: extra.extractSha256,
    display_updated_at: new Date(extra.sourceUpdatedAt), display_evidence_ref: extra.evidenceRef,
    display_snapshot: extra.snapshot, display_digest: legacyDisplayDigest(accountId, extra),
  };
}

test("authorized private projection reuses frozen display facts without public visibility or private risk data", () => {
  const result = projectLegacyHistoricalRead(historicalRow(), "a-1");
  assert.equal(result.sourceStatus, 4);
  assert.equal(result.quote, null);
  assert.equal(result.canCreateOrder, false);
  assert.equal(result.trade, "UNKNOWN");
  assert.equal(result.display.state, "KNOWN");
  if (result.display.state !== "KNOWN") return;
  assert.equal(result.display.facts.resources[0]!.quantity, "30000000");
  assert.equal(result.display.facts.resources[3]!.quantity, "0");
  assert.equal(result.display.facts.attributeDisplay.loginMethod?.displayName, "微信扫码");
  assert.deepEqual(result.historicalQuote, { haffRentYuan: "12.30", goodsYuan: "0.40", depositYuan: "0.00", termDays: "2", dailyHaffBase: "1000000" });
  assert.doesNotMatch(JSON.stringify(result), /highRiskOwner|banRecord|faceIsSelf|ownerRatio|extractSha256|sourceDigest|displayDigest|evidenceRef|phone|contact/);
  assert.doesNotMatch(legacyHistoricalReadSql(), /source_status=3|legacyAdmission|suspended|FOR UPDATE/);
  assert.match(legacyHistoricalReadSql(), /d.schema_version=1/);
});

test("no base, no display and corrupt display remain distinct", async () => {
  const calls: string[] = [];
  const absent = await loadLegacyHistoricalRead({ query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as never, "a-1");
  assert.equal(absent, null);
  const row = historicalRow();
  const withoutDisplay = { ...row, display_account_id: null, display_version_id: null, base_source_digest: null, extract_sha256: null, display_updated_at: null, display_evidence_ref: null, display_snapshot: null, display_digest: null };
  assert.deepEqual(projectLegacyHistoricalRead(withoutDisplay).display, { state: "NOT_IMPORTED", facts: null });
  const missingValue = historicalRow();
  missingValue.display_snapshot.resources[0]!.quantity = null;
  missingValue.display_digest = legacyDisplayDigest("a-1", { ...input(), snapshot: missingValue.display_snapshot });
  const missing = projectLegacyHistoricalRead(missingValue);
  assert.equal(missing.display.state === "KNOWN" && missing.display.facts.resources[0]!.quantity, null);
  for (const patch of [
    { display_account_id: "other" }, { account_id: "other" }, { display_version_id: "other-version" },
    { base_source_digest: "c".repeat(64) }, { extract_sha256: "c".repeat(64) },
    { display_digest: "c".repeat(64) }, { display_updated_at: new Date("2026-09-14T00:00:00.000Z") },
    { display_snapshot: { ...row.display_snapshot, private: "injected" } }, { display_account_id: null },
    { snapshot: { ...row.snapshot, depositYuan: 0 } },
  ]) assert.throws(() => projectLegacyHistoricalRead({ ...row, ...patch }, "a-1"), { status: 503, code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(calls.length, 1);
  assert(calls.every(sql => !/INSERT|UPDATE|DELETE|ensure/.test(sql)));
});

test("authorized page IDs load in one bounded batch and empty pages issue no historical query", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [historicalRow(), historicalRow("a-2", "2")] }; } };
  assert.equal((await loadLegacyHistoricalReads(client as never, [])).size, 0);
  assert.equal(calls.length, 0);
  const result = await loadLegacyHistoricalReads(client as never, ["a-1", "a-2"]);
  assert.equal(result.size, 2);
  assert.deepEqual(calls[0]!.values, [["a-1", "a-2"]]);
  assert.match(calls[0]!.sql, /h.account_id = ANY/);
  assert.equal(calls.length, 1);
  const single = projectLegacyHistoricalRead(historicalRow(), "a-1");
  assert.deepEqual(result.get("a-1"), single);
  await assert.rejects(() => loadLegacyHistoricalReads(client as never, ["other"]), { status: 503, code: "EVIDENCE_UNAVAILABLE" });
});
