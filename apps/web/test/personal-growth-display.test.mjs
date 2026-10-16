import assert from "node:assert/strict";
import {test} from "node:test";
import {personalMembershipLabel,personalBenefitSources} from "../src/lib/order-display.ts";
test("new quote displays actual growth tier and separate whole-price/deposit sources without old tier labels",()=>{
 const quote={membershipBenefits:{schema:"membership-benefits-v1",effectiveTier:"GOLD",policyTier:"GOLD",priceSource:"FRIEND",depositSource:"GROWTH",policyVersion:"1"},customerTier:"VIP"};
 assert.equal(personalMembershipLabel(quote),"金卡会员");assert.equal(personalBenefitSources(quote),"价格：挚友礼遇；押金：成长权益");assert(!personalMembershipLabel(quote).includes("VIP"));
 quote.membershipBenefits.effectiveTier="BLACK_GOLD";quote.membershipBenefits.policyTier="DIAMOND";assert.equal(personalMembershipLabel(quote),"黑金会员·终身");
 assert.equal(personalMembershipLabel({customerTier:"SVIP"}),"既有确认方案");assert.equal(personalMembershipLabel({}),"会员权益待核");assert.equal(personalBenefitSources({customerTier:"STANDARD"}),null);
});
