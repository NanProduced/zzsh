import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { computeContentHash } from "../src/supply/content-hash";
import { compatRule } from "./pricing-compat-fixture";
import type { Options } from "./supply-publishing-checks";
import { createReservation } from "../src/order/order";
import { withTransaction } from "../src/auth/security-core";
import { runPersonalConfirmationChecks } from "./personal-confirmation-checks";

export async function runPricingCompatChecks(o: Options): Promise<void> {
  const frozen=async()=>({
    listings:(await o.pool.query(`SELECT id,payload,content_hash FROM zzsh_supply.listing_version WHERE payload IS NOT NULL ORDER BY id`)).rows,
    orders:(await o.pool.query(`SELECT id,quote_snapshot FROM zzsh_order.rental_order ORDER BY id`)).rows,
    rules:(await o.pool.query(`SELECT id,haff_rule FROM zzsh_supply.price_version WHERE status='SEALED' ORDER BY id`)).rows,
  });
  const before=await frozen();
  assert.ok(before.listings.length>0);
  const countBefore=(await o.migration.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n;
  assert.ok(countBefore===39 || countBefore===40 || countBefore===41 || countBefore===42 || countBefore===43);
  await runBusinessMigrations(o.migration,{runtimeUser:o.runtimeUser});
  await runBusinessMigrations(o.migration,{runtimeUser:o.runtimeUser});
  assert.deepEqual(await frozen(),before,"incremental migration preserves sealed payload/hash/order snapshots");
  for(const row of before.listings) assert.equal(computeContentHash(row.payload),row.content_hash);
  const folder=join(__dirname,"../../migrations/business");
  const journal=JSON.parse(await readFile(join(folder,"meta/_journal.json"),"utf8"));
  const migrations=(await o.migration.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
  assert.equal(migrations.length,43);
  for(const [i,entry] of journal.entries.entries()) {
    const hash=createHash("sha256").update(await readFile(join(folder,entry.tag+".sql"))).digest("hex");
    assert.deepEqual(migrations[i],{hash,created_at:String(entry.when)});
  }
  console.log("PC1 migration",{from:countBefore,to:migrations.length,sql39:migrations[39].hash,legacyListings:before.listings.length,legacyOrders:before.orders.length});
  const call=async(path:string,body?:unknown,admin=false,method=body===undefined?"GET":"POST",key="pc1_"+randomUUID())=>{
    const jar=admin?o.boss:o.user;
    const response=await fetch(o.base+path,{method,headers:{cookie:jar.header(),origin:admin?o.adminOrigin:o.userOrigin,...(body===undefined?{}:{"content-type":"application/json","idempotency-key":key})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    jar.update?.(response);
    return {status:response.status,body:await response.json()};
  };
  const ok=async(path:string,body?:unknown,admin=false,method?:string)=>{const r=await call(path,body,admin,method);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const current=(await o.pool.query(`SELECT r.* FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id WHERE g.id=$1`,[o.gameId])).rows[0];
  const price=await ok("/api/bff/admin/supply/price-drafts",{gameId:o.gameId,mode:"SPREAD"},true);
  const fixed=await ok(`/api/bff/admin/supply/games/${o.gameId}/items`,{code:"pc1_round",name:"PC1 rounds",unit:"ROUND"},true);
  const lines=["STANDARD","VIP","SVIP","DISCOUNT_USER"].flatMap(customerTier=>[
    {itemId:o.itemId,customerTier,pricingKind:"HAFF_RATIO"},
    {itemId:fixed.id,customerTier,pricingKind:"FIXED_UNIT",unitQuantity:"60",ownerUnitAmount:"4",buyerUnitAmount:customerTier==="STANDARD"?"10":customerTier==="SVIP"?"7":"8"},
  ]);
  const save={expectedRevision:"1",haffRule:compatRule(),lines};
  const bad=structuredClone(save);bad.haffRule.compatibility!.fast.discounts.VIP="13";
  assert.equal((await call(`/api/bff/admin/supply/price-drafts/${price.id}`,bad,true,"PUT")).status,400);
  const mismatch=structuredClone(save);mismatch.lines[3]!.ownerUnitAmount="5";
  assert.equal((await call(`/api/bff/admin/supply/price-drafts/${price.id}`,mismatch,true,"PUT")).status,400);
  await ok(`/api/bff/admin/supply/price-drafts/${price.id}`,save,true,"PUT");
  await o.testContext.test("PC1 R1: missing tiers reject atomically; explicit v2 and legacy v1 saves retain prices", async () => {
    const snapshot = async (id: string) => ({
      version: (await o.pool.query(`SELECT * FROM zzsh_supply.price_version WHERE id=$1`, [id])).rows,
      lines: (await o.pool.query(`SELECT * FROM zzsh_supply.price_line WHERE price_version_id=$1 ORDER BY item_id,customer_tier`, [id])).rows,
      audit: (await o.pool.query(`SELECT * FROM zzsh_iam.audit_event WHERE object_id=$1 ORDER BY id`, [id])).rows,
    });
    // Same lossy itemId map as the old editor, including its last-tier-wins value.
    const lost = Object.values(Object.fromEntries<Record<string, unknown>>(lines.map(({customerTier: _tier, ...line}) => [line.itemId, line])));
    const beforeSave = await snapshot(price.id);
    for (const customerTier of [null, 0, false, {}, [], "UNKNOWN"]) {
      const rejected = await call(`/api/bff/admin/supply/price-drafts/${price.id}`, {expectedRevision:"2", lines:lost.map(line=>({...line,customerTier}))}, true, "PUT");
      assert.equal(rejected.status,400,JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code,"INVALID_ARGUMENT");
      assert.deepEqual(await snapshot(price.id),beforeSave,"invalid explicit tier cannot alter version, prices or audit");
    }
    const changedRule = compatRule(); changedRule.compatibility!.ordinary.spreadDelta = "9";
    for (const rulePatch of [{}, {haffRule: changedRule}, {haffRule: null}]) {
      const rejected = await call(`/api/bff/admin/supply/price-drafts/${price.id}`, {expectedRevision:"2", ...rulePatch, lines:lost}, true, "PUT");
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.details[0].path, "lines");
      assert.deepEqual(await snapshot(price.id), beforeSave, "revision, rule, every line and successful audit are unchanged");
    }
    await ok(`/api/bff/admin/supply/price-drafts/${price.id}`, {expectedRevision:"2", lines:[...lines].reverse()}, true, "PUT");
    const read = await ok(`/api/bff/admin/supply/games/${o.gameId}/rules`, undefined, true);
    const actual = read.priceLines.filter((line: any) => line.priceVersionId===price.id && line.itemId===fixed.id);
    assert.equal(actual.length,4);
    assert.deepEqual(Object.fromEntries(actual.map((line:any)=>[line.customerTier,line.buyerUnitAmount])),{STANDARD:"10.00000000",VIP:"8.00000000",SVIP:"7.00000000",DISCOUNT_USER:"8.00000000"});
    const legacy = await ok("/api/bff/admin/supply/price-drafts",{gameId:o.gameId,mode:"SPREAD"},true);
    const legacyBefore = await snapshot(legacy.id);
    assert.equal((await call(`/api/bff/admin/supply/price-drafts/${legacy.id}`,{...save,lines:lost},true,"PUT")).status,400,"v1 to v2 transition also requires explicit tiers");
    assert.deepEqual(await snapshot(legacy.id),legacyBefore);
    const {compatibility: _compat, ...baseRule} = compatRule();
    await ok(`/api/bff/admin/supply/price-drafts/${legacy.id}`,{expectedRevision:"1",haffRule:{...baseRule,schema:"haff-ratio-v1",options:{standard:{delta:"0",enabled:true}},spreadDelta:"8"},lines:[{itemId:fixed.id,pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:"10",ownerUnitAmount:"4"}]},true,"PUT");
    assert.deepEqual((await o.pool.query(`SELECT customer_tier,buyer_unit_amount::text FROM zzsh_supply.price_line WHERE price_version_id=$1`,[legacy.id])).rows,[{customer_tier:"STANDARD",buyer_unit_amount:"10.00000000"}]);
  });
  await ok(`/api/bff/admin/supply/price-drafts/${price.id}/seal`,{expectedRevision:"3"},true);
  const release=await ok("/api/bff/admin/supply/releases",{gameId:o.gameId,priceVersionId:price.id,termVersionId:current.term_version_id,agreementVersionId:current.agreement_version_id,expectedGeneration:String(current.generation)},true);
  assert.ok((await o.pool.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1`,[price.id])).rowCount);
  await assert.rejects(()=>o.pool.query(`UPDATE zzsh_supply.price_line SET buyer_unit_amount=1 WHERE price_version_id=$1 AND pricing_kind='FIXED_UNIT'`,[price.id]));

  // Reuse this account's own reviewed media; create a fresh editable version through its API.
  const path=`/api/v1/supply/accounts/${o.accountId}`;
  let d=await ok(path);
  if(d.version.reviewState!=="DRAFT") d=await ok(path+"/drafts",{expectedRevision:d.account.revision});
  const ownAssets=(await o.pool.query(`SELECT id,purpose FROM zzsh_supply.media_asset WHERE account_id=$1 AND review_state='APPROVED' ORDER BY id`,[o.accountId])).rows;
  const display=ownAssets.find(a=>a.purpose==="ACCOUNT_DISPLAY");assert.ok(display);
  const declaration={title:"PC1 compatible account",attributes:{safe_box_code:"box-a",vit_level:6,bear_level:6,rentalPricing:{rentalMode:"custom",ownerRatioB:"46"}},termOptionCode:"daily-10m",pricingOptionCode:"",inventory:[{itemId:o.itemId,quantity:"100000000"},{itemId:fixed.id,quantity:"60"}],skins:[],entitlements:[],mediaBindings:[{assetId:display.id,position:0}]};
  d=await ok(path+"/draft",{...declaration,expectedRevision:d.account.revision},false,"PUT");
  assert.equal((await call(path+"/quote",{expectedRevision:d.account.revision,customerTier:"VIP"})).status,400);
  d=await ok(path+"/quote",{expectedRevision:d.account.revision});
  const token=(v:any)=>({expectedRevision:v.account.revision,versionId:v.version.id,releaseId:v.version.releaseId,contentHash:v.version.contentHash});
  const old=token(d);const hash=d.version.contentHash;
  d=await ok(path+"/accept-rules",token(d));
  declaration.attributes.rentalPricing.ownerRatioB="45";
  d=await ok(path+"/draft",{...declaration,expectedRevision:d.account.revision},false,"PUT");
  d=await ok(path+"/quote",{expectedRevision:d.account.revision});
  assert.notEqual(d.version.contentHash,hash);
  assert.equal((await call(path+"/accept-rules",{...old,expectedRevision:d.account.revision})).status,409);
  d=await ok(path+"/accept-rules",token(d));
  o.gates.set(o.accountId,{publisherBail:"NOT_REQUIRED",occupancy:"FREE",reference:"fixture:pc1"});
  const submitBody=token(d);const submitKey="pc1_submit_"+randomUUID();
  const submitted=await call(path+"/submit",submitBody,false,"POST",submitKey);assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  d=submitted.body;
  d=await ok(`/api/bff/admin/supply/listing-reviews/${o.accountId}/decide`,{...token(d),decision:"APPROVE",reason:"PC1 isolated validation"},true);
  if(d.account.owner_paused) d=await ok(path+"/resume",{expectedRevision:d.account.revision});
  const pub=await ok(`/api/v1/supply/listings/${o.accountId}`);
  const payload=(await o.pool.query(`SELECT payload,content_hash FROM zzsh_supply.listing_version WHERE id=$1`,[d.version.id])).rows[0];
  assert.equal(payload.payload.schemaVersion,2);
  assert.equal(payload.payload.quoteValues.pricingInputs.compatibility.customerTier,"STANDARD");
  assert.equal(payload.payload.quoteValues.resourceTotal.amount,"280.27");
  assert.equal(computeContentHash(payload.payload),payload.content_hash);
  for(const forbidden of ["ownerUnitAmount","ownerAmount","platformFullProfit","memberDelta","pricingInputs"]) assert.equal(JSON.stringify(pub).includes('"'+forbidden+'"'),false,forbidden);
  assert.equal(JSON.stringify(pub).includes('"280.27"'),true);
  const renter=(await o.pool.query(`SELECT u.id,s.id AS session_id FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId"=u.id WHERE u.email='m3b-user-2@example.invalid' LIMIT 1`)).rows[0];
  const owner=(await o.pool.query(`SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1`,[o.accountId])).rows[0];
  await assert.rejects(()=>withTransaction(o.pool,client=>createReservation(client,{context:{userId:renter.id,sessionId:renter.session_id},accountId:o.accountId,versionId:d.version.id,releaseId:d.version.releaseId,ownerUserId:owner.owner_user_id,gameId:o.gameId,holdSeconds:300,gate:async()=>o.gates.get(o.accountId)!,requestId:"pc1-schema"})),(error:any)=>error.code==="PRICING_SCHEMA_UNSUPPORTED");
  assert.deepEqual((await frozen()).orders,before.orders);
  await runPersonalConfirmationChecks(o,d);
  // Current release changes invalidate fresh confirmations, but not completed same-key responses.
  const finalGeneration=(await o.pool.query(`SELECT max(generation)::text AS generation FROM zzsh_supply.rule_release WHERE game_id=$1`,[o.gameId])).rows[0].generation;
  await ok("/api/bff/admin/supply/releases",{gameId:o.gameId,priceVersionId:price.id,termVersionId:current.term_version_id,agreementVersionId:current.agreement_version_id,expectedGeneration:finalGeneration},true);
  assert.deepEqual((await call(path+"/submit",submitBody,false,"POST",submitKey)),submitted);
  console.log("PC1 STANDARD publish/accept/review/public, stale-confirmation, replay, audit and tier constraint PASS");
}
