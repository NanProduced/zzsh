import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/supply/content-hash";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import { sha256Hex } from "../src/supply/supply-util";
import { legacyMoneyCents, legacyEpochTimestamp, legacyAccountMetricSource, normalizeLegacyOrderReadInput, type LegacyOrderReadInput } from "../src/order/legacy-order-read";
const h="a".repeat(64);
function input():LegacyOrderReadInput {
 const row={id:"1",order_sn:"legacy-1",accounts_id:"10",user_id:"20",sale_user_id:"30",order_status:"5",pay_is:"1",need_pay_money:"66.00",pay_money:"66.00",deposit_amount:"0.00",pay_time:"0",create_time:"1",cancel_time:"0",confirm_time:"0",level6_bullet_num:"2"};
 return {source:{legacyId:"1",digest:sha256Hex(canonicalize(row)),evidenceRef:"test:legacy-1",row},account:{accountId:"account-10",gameId:"game-1",legacyId:"10",businessNo:"A-10",sourceDigest:h},owner:{userId:legacyOwnerUserId("legacy_mysql_restore","la_user","30"),legacyId:"30",businessNo:"U-30",sourceDigest:h},renter:{userId:legacyOwnerUserId("legacy_mysql_restore","la_user","20"),legacyId:"20",businessNo:"U-20",sourceDigest:h}};
}
test("legacy exact cents and unknown timestamps do not coerce invalid facts",()=>{
 assert.equal(legacyMoneyCents(null),null);assert.equal(legacyMoneyCents("0.00"),"0");assert.equal(legacyMoneyCents("9999999999999.99"),"999999999999999");
 for(const v of ["1.2","1.234","1e3",1,"01.00"])assert.throws(()=>legacyMoneyCents(v));
 assert.equal(legacyEpochTimestamp("0"),null);assert.throws(()=>legacyEpochTimestamp("1.5"));
 const n=normalizeLegacyOrderReadInput(input());assert.equal(n.paidCents,"6600");assert.equal(n.paidAt,null);assert.equal(n.depositCents,"0");
});
test("full target binding changes cannot be mistaken for a replay",()=>{
 const original=input(),before=normalizeLegacyOrderReadInput(original);
 const changed=structuredClone(original);changed.account.gameId="game-2";assert.notEqual(normalizeLegacyOrderReadInput(changed).bindingDigest,before.bindingDigest);
 changed.owner.userId=original.renter.userId;assert.throws(()=>normalizeLegacyOrderReadInput(changed));
 const snapshot=structuredClone(original);snapshot.source.row.pay_money="1.00";assert.throws(()=>normalizeLegacyOrderReadInput(snapshot));
 const quantity=structuredClone(original);quantity.source.row.level6_bullet_num="1.5";quantity.source.digest=sha256Hex(canonicalize(quantity.source.row));assert.throws(()=>normalizeLegacyOrderReadInput(quantity));
});

test("full frozen source retains optional deletion fact without changing money or accepting malformed flags", () => {
 const original = input(), before = normalizeLegacyOrderReadInput(original);
 for (const is_delete of ["0", "1"]) {
  const changed = structuredClone(original); changed.source.row.is_delete = is_delete;
  changed.source.digest = sha256Hex(canonicalize(changed.source.row));
  const normalized = normalizeLegacyOrderReadInput(changed);
  assert.equal(normalized.paidCents, before.paidCents); assert.equal(normalized.dueCents, before.dueCents);
  assert.notEqual(normalized.bindingDigest, before.bindingDigest); assert.equal(changed.source.row.is_delete, is_delete);
 }
 for (const is_delete of ["2", "true", "", null]) {
  const changed = structuredClone(original); changed.source.row.is_delete = is_delete;
  changed.source.digest = sha256Hex(canonicalize(changed.source.row));
  assert.throws(() => normalizeLegacyOrderReadInput(changed), (error: unknown) => (error as { status?: number }).status === 400);
 }
});

test("source detain amount remains exact and frozen, never subtracted from historical gross refund display", () => {
 const changed = input(); changed.source.row.detain_money = "5.00"; changed.source.row.return_order_money = "87.00";
 changed.source.digest = sha256Hex(canonicalize(changed.source.row));
 assert.equal(normalizeLegacyOrderReadInput(changed).paidCents,"6600");
 assert.equal(changed.source.row.return_order_money,"87.00"); assert.equal(changed.source.row.detain_money,"5.00");
 for (const detain_money of ["1.234", "1e2", "NaN", "01.00"]) {
  const malformed=structuredClone(changed);malformed.source.row.detain_money=detain_money;
  malformed.source.digest=sha256Hex(canonicalize(malformed.source.row));
  assert.throws(()=>normalizeLegacyOrderReadInput(malformed));
 }
});

test("legacy compensation is preserved as source evidence without creating a new financial movement", () => {
 const original=input(),before=normalizeLegacyOrderReadInput(original),withSource=structuredClone(original);
 withSource.source.row.compensation="891.80";withSource.source.digest=sha256Hex(canonicalize(withSource.source.row));
 const after=normalizeLegacyOrderReadInput(withSource);
 assert.equal(withSource.source.row.compensation,"891.80");assert.equal(after.paidCents,before.paidCents);assert.equal(after.dueCents,before.dueCents);
 assert.notEqual(after.bindingDigest,before.bindingDigest);
 for(const value of [null,"-1.00"]) {const raw=structuredClone(withSource);raw.source.row.compensation=value;raw.source.digest=sha256Hex(canonicalize(raw.source.row));assert.doesNotThrow(()=>normalizeLegacyOrderReadInput(raw));}
 for(const value of ["1.234","1e3","NaN","01.00"]) {const raw=structuredClone(withSource);raw.source.row.compensation=value;raw.source.digest=sha256Hex(canonicalize(raw.source.row));assert.throws(()=>normalizeLegacyOrderReadInput(raw));}
 withSource.source.row.compensation="1.00";assert.throws(()=>normalizeLegacyOrderReadInput(withSource));
});

test("legacy share and account flag remain separate source facts with their original binding", () => {
 const original=input(),before=normalizeLegacyOrderReadInput(original),changed=structuredClone(original);
 changed.source.row.share_money="10.25";changed.source.row.commission_money="2.50";changed.source.row.pay_time="1779469800";
 changed.source.digest=sha256Hex(canonicalize(changed.source.row));changed.account.metricSourceFields={is_full_payout:"1"};
 const after=normalizeLegacyOrderReadInput(changed),fact=legacyAccountMetricSource(changed);
 assert.equal(after.paidCents,before.paidCents);assert.equal(after.dueCents,before.dueCents);assert.equal(after.paidAt,"2026-05-22T17:10:00.000Z");
 assert.deepEqual(fact,{schema:"legacy-account-metric-source-v1",sourceSystem:"legacy_mysql_restore",sourceEntity:"la_rental_accounts",legacyId:"10",sourceDigest:h,orderEvidenceRef:"test:legacy-1",fields:{is_full_payout:"1"}});
 assert.equal(Object.hasOwn(changed.source.row,"is_full_payout"),false);assert.notEqual(after.bindingDigest,before.bindingDigest);
 const missing=structuredClone(changed);missing.account.metricSourceFields={};assert.deepEqual(legacyAccountMetricSource(missing)?.fields,{});
 const unknown=structuredClone(changed);unknown.account.metricSourceFields={is_full_payout:null};assert.equal(legacyAccountMetricSource(unknown)?.fields.is_full_payout,null);
 const rawFlag=structuredClone(changed);rawFlag.account.metricSourceFields={is_full_payout:"7"};assert.doesNotThrow(()=>normalizeLegacyOrderReadInput(rawFlag));
 for(const value of ["1.234","1e2","NaN"]) {const invalid=structuredClone(changed);invalid.source.row.share_money=value;invalid.source.digest=sha256Hex(canonicalize(invalid.source.row));assert.throws(()=>normalizeLegacyOrderReadInput(invalid));}
});
