import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/supply/content-hash";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import { sha256Hex } from "../src/supply/supply-util";
import { legacyMoneyCents, legacyEpochTimestamp, normalizeLegacyOrderReadInput, type LegacyOrderReadInput } from "../src/order/legacy-order-read";
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
