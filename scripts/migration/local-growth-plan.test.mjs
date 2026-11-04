import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyCompletedComponents } from "./local-growth-plan.mjs";

const names=["barrett_bullet","level6_bullet","awm_bullet","level6_armor","level6_helmet","coffee","top_insure_card"];
function completed(){return {order_status:"4",pay_is:"1",confirm_time:"1790000000",compensation:null,is_settle:"1",detain_money:"0.00",pay_money:"1000.00",return_order_money:"900.00",expend_money:null,expend_pay_money:"800.00",deposit_amount:"500.00",...Object.fromEntries(names.flatMap(name=>[[name+"_num",null],[name+"_price",null]])),awm_bullet_num:"2",awm_bullet_price:"3.00"};}
test("final stored components and original frozen prices keep deposit and prepaid material out of growth",()=>{
 const raw=completed();assert.deepEqual(legacyCompletedComponents(raw),{rentalCents:"9400",materialCents:"600",minimumBillingCents:"0",minimumAgreementRef:null,basis:"FINAL_QUANTITIES_AND_FROZEN_ORDER_PRICES"});
 raw.expend_money="5.00";assert.equal(legacyCompletedComponents(raw).materialCents,"500");
 raw.expend_pay_money="99999.00";raw.deposit_amount="99999.00";assert.equal(legacyCompletedComponents(raw).rentalCents,"9500");
});
test("a historical NULL quantity has explicit final utility semantics; absent required fields and fallback prices stay unknown",()=>{
 const raw=completed();raw.awm_bullet_num=null;assert.equal(legacyCompletedComponents(raw).materialCents,"0");
 delete raw.awm_bullet_num;assert.throws(()=>legacyCompletedComponents(raw),/FINAL_QUANTITY_UNPROVEN/);
 const fallback=completed();fallback.awm_bullet_price="0.00";assert.throws(()=>legacyCompletedComponents(fallback),/HISTORICAL_FALLBACK_PRICE_UNPROVEN/);
});
test("unconfirmed, negative-return, compensation, confiscation and over-net materials never become a known zero",()=>{
 for(const [patch,reason]of [[{order_status:"8"},"NOT_CONFIRMED_COMPLETED"],[{return_order_money:"-1.00"},"NEGATIVE_ORIGINAL_RETURN"],[{compensation:"1.00"},"COMPENSATION_CLASSIFICATION"],[{is_settle:"3"},"CONFISCATED_DEPOSIT"],[{expend_money:"100.01"},"COMPONENT_TOTAL_CONFLICT"]])assert.throws(()=>legacyCompletedComponents({...completed(),...patch}),new RegExp(reason));
});
