// SYNTHETIC_COMPONENT_MODEL；分录计划/读回断言，不冒充PG、正式退款或到账。
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { hashApprovalPayload } from "../src/auth/approval-audit";
import { prestartLiabilityPlan, recognizePrestartRefundLiability, verifyPrestartRefundLiability } from "../src/finance/prestart-refund-liability";
import type { PrestartPaymentBasis } from "../src/order/prestart-termination";
const fields={orderId:'o1',renterUserId:'r1',ownerUserId:'owner1',paymentConfirmationId:'pc1',source:'JOINPAY' as const,
 merchantIdentityId:'merchant1',merchantOrderNo:'ORIGINAL1',channelTrxNo:'TRX1',amountCents:'15908',currency:'CNY' as const};
const basis:PrestartPaymentBasis={...fields,digest:hashApprovalPayload({schema:'prestart-payment-basis.v1',...fields}).hash};
test('全额责任借记原收款来源、贷记本人应退，不产生正常结算或佣金',()=>{
 const p=prestartLiabilityPlan('term1',basis);assert.deepEqual(p.lines,[{account:'CAPTURED_PAYMENT_SOURCE',debit:'15908',credit:'0',user:null},
  {account:'RENTER_REFUND_PAYABLE',debit:'0',credit:'15908',user:'r1'}]);
 assert.equal(p.lines.reduce((n,l)=>n+BigInt(l.debit)-BigInt(l.credit),0n),0n);
 assert.deepEqual(prestartLiabilityPlan('term1',basis),p);
});
test('金额/原款/币种/主体或摘要改变，不能创建责任计划',()=>{
 for(const change of [{amountCents:'0'},{amountCents:'-1'},{amountCents:'15908.0'},{amountCents:'10000000000000000'},
  {currency:'USD'},{renterUserId:'other'},{channelTrxNo:'OTHER'},{digest:'0'.repeat(64)}])assert.throws(()=>prestartLiabilityPlan('term1',{...basis,...change} as any));
});
test('责任首次记录后独立核两条分录；不推进钱包可用余额或revision',async()=>{
 const calls:{sql:string;v:any[]}[]=[];
 const c={query:async(sql:string,v:any[]=[])=>{calls.push({sql,v});return{rows:sql.startsWith('SELECT id FROM')?[]:sql.startsWith('SELECT ledger_revision')?[{ledger_revision:'7'}]:sql.startsWith('SELECT EXISTS')?[{valid:true}]:[]};}} as unknown as PoolClient;
 const p=await recognizePrestartRefundLiability(c,'term1',basis,'req1');
 assert.equal(calls.filter(x=>x.sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry')).length,2);
 assert.equal(calls.filter(x=>x.sql.startsWith('INSERT INTO zzsh_order.finance_event')).length,1);
 assert.equal(calls.find(x=>x.sql.startsWith('INSERT INTO zzsh_order.finance_event'))?.v[3],'7');
 assert.equal(calls.some(x=>/^(UPDATE.*wallet_revision|INSERT INTO.*wallet_coverage|INSERT INTO zzsh_order.settlement_posting)/.test(x.sql)),false);
 assert.equal(calls.some(x=>x.sql.startsWith('INSERT INTO zzsh_order.wallet_revision')||x.sql.includes('wallet_revision WHERE user_id=$1 FOR UPDATE')),false);
 const lines=calls.filter(x=>x.sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry'));
 assert.equal(lines[0]!.v[7],'pc1');assert.equal(lines[1]!.v[7],null);
 assert.match(p.eventId,/^prestart_liability_/);
});
test('已有责任仅复核，不触碰已完成批次；缺分录/坏关联不能当重放成功',async()=>{
 for(const valid of [true,false]){const seen:string[]=[];const c={query:async(sql:string)=>{seen.push(sql);return{rows:sql.startsWith('SELECT id FROM')?[{id:'existing'}]:[{valid}]};}} as unknown as PoolClient;
  if(valid)await recognizePrestartRefundLiability(c,'term1',basis,'req1');else await assert.rejects(recognizePrestartRefundLiability(c,'term1',basis,'req1'),(e:any)=>e.status===503);
  assert.equal(seen.some(s=>/INSERT|UPDATE|DELETE/.test(s)),false);}
 const p=prestartLiabilityPlan('term1',basis);await assert.rejects(verifyPrestartRefundLiability({} as PoolClient,'term1',basis,p.rootId,'wrong'),(e:any)=>e.status===503);
});
