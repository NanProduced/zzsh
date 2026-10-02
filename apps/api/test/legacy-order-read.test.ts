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
