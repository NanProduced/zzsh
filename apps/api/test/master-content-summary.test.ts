
import assert from "node:assert/strict";
import {test} from "node:test";
import {financeScopedVersionSql} from "../src/finance/admin-finance-query";
test("Master: ORDER scoped relations have only one outer WHERE",()=>{
 const sql=financeScopedVersionSql({refund_intents:true,refund_read_dependencies:true,native_orders:true},{mode:"document",documentRef:"ORDER:order_1"})!.text;
 assert.doesNotMatch(sql,/WHERE i\.posting_id IS NULL WHERE/);
 assert.doesNotMatch(sql,/WHERE a\.action='order\.refund\.abnormal\.first_submit\.blocked' WHERE/);
});
test("Master: refund intent still has an exact scoped digest with attempts",()=>{
 const sql=financeScopedVersionSql({refund_intents:true,refund_read_dependencies:true,native_orders:true},{mode:"document",documentRef:"REFUND_INTENT:rfi_1"});
 assert.notEqual(sql,null);assert.match(sql!.text,/joinpay_refund_attempt/);
 assert.doesNotMatch(sql!.text,/order\.refund\.abnormal\.first_submit\.blocked/);
});
test("Master: ORDER scoped digest includes normal refund events",()=>{
 const sql=financeScopedVersionSql({refund_intents:true,refund_read_dependencies:true,native_orders:true},{mode:"document",documentRef:"ORDER:order_1"})!.text;
 assert.match(sql,/NATIVE_RENTAL_REFUND/);assert.match(sql,/source_kind<>'NATIVE_ABNORMAL_REFUND'/);
 assert.match(sql,/payment_confirmation/);
});
