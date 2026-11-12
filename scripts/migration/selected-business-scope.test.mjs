import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertSelectedScopeForWrite, planSelectedBusinessScope, selectedScopeDigest, selectedScopeFilter } from "./selected-business-scope.mjs";
import { summarizePopulationScope } from "./local-source-scenarios.mjs";
import { verifySelectedPopulationFiles } from "./verify-full-source-population.mjs";
import { sourceContinuation } from './local-source-adapter.mjs';

const account = (id, over = {}) => ({ id, status: "4", is_delete: "0", user_id: "u1", no: id, price_tenant: "100.00",
  extra_goods_total_price_tenant: "30.00", deposit_amount: "50.00", rental_days: "10", default_consume_type: "1", ...over });
const order = (id, accountId, over = {}) => ({ id, accounts_id: accountId, pay_is: "0", user_id: "u1", sale_user_id: "u2", order_sn: "order-"+id, ...over });
const pay = (orderId, payIs, over = {}) => ({ id: "p" + orderId, order_id: orderId, order_type: "1", pay_is: payIs, ...over });

function independentlyCheckedFixture(planSource) {
  const data = { users: [{id:'u1'},{id:'u2'}], accounts: [account('a1',{status:'3'}),account('a2'),account('a3')],
    orders: [order('o1','a2',{pay_is:'1'}),order('o2','a2'),order('o3','a1')],
    pays: [pay('o1','1'),pay('o2','0'),pay('o3','0')], refunds: [{id:'r1',user_id:'u1',order_type:'order',order_id:'o1',order_sn:'order-o1'}] };
  const scope = planSelectedBusinessScope(planSource ?? data), sourceSha='a'.repeat(64);
  const population = summarizePopulationScope(data,'SELECTED_BUSINESS_SCOPE',selectedScopeFilter(scope),sourceSha);
  const source = {status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,
    files:Object.fromEntries(Object.entries(data).map(([domain,rows])=>[domain,{file:'source-'+domain,rows:rows.length}]))};
  const files={users:{file:'target-users'},accounts:{file:'target-accounts'},orders:{file:'target-orders'},quarantine:{file:'quarantine'}};
  const targetRows={users:data.users.map(({id:sourceId})=>({sourceId})),accounts:scope.write.accounts.map(sourceId=>{const raw=data.accounts.find(row=>row.id===sourceId);return {sourceId,ownerLegacyId:raw.user_id,sourceStatus:raw.status,sourceDeleted:raw.is_delete==='1',businessNo:raw.no,
    snapshot:sourceId==='a1'?{schema:'legacy-listing-read-v1',resourceNo:raw.no,haffRentYuan:raw.price_tenant,goodsYuan:raw.extra_goods_total_price_tenant,depositYuan:raw.deposit_amount,termDays:raw.rental_days,dailyHaffBase:'10000000'}:null};}),orders:scope.write.orders.map(sourceId=>({sourceId})),quarantine:[]};
  const rows=Object.fromEntries(Object.entries(data).map(([name,value])=>['source-'+name,value]));
  Object.assign(rows,{'target-users':targetRows.users,'target-accounts':targetRows.accounts,'target-orders':targetRows.orders,quarantine:targetRows.quarantine});
  const dataset={sourceReceiptSha256:sourceSha,population,populationSha256:createHash('sha256').update(JSON.stringify(population)).digest('hex'),selectedScope:scope,selectedScopeSha256:selectedScopeDigest(scope),
    domains:{users:{source:data.users.length,ready:data.users.length,isolated:0},accounts:{source:scope.write.accounts.length,ready:scope.write.accounts.length,isolated:0},orders:{source:scope.write.orders.length,ready:scope.write.orders.length,isolated:0}},files};
  const readRows=async(_dir,meta,visit)=>{for(const row of rows[meta.file]??[])visit(row);};
  return {data,source,dataset,rows,readRows};
}

test('independent selected-scope check proves paid orders, listed accounts and target input partition',async()=>{
  const f=independentlyCheckedFixture();
  const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
  assert.equal(proof.status,'SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN');
  assert.deepEqual(proof.users,{captured:2,retained:2,excluded:0,ready:2,isolated:0});
  assert.deepEqual(proof.accounts,{captured:3,retained:2,excluded:1,ready:2,isolated:0});
  assert.deepEqual(proof.orders,{captured:3,retained:1,excluded:2,ready:1,isolated:0});
  assert.deepEqual(proof.legacyListed,{scope:'ALL_CAPTURED_GAMES',sourceCount:1,readyWithSnapshot:1,readyWithoutSnapshot:0,isolated:0,status:'SOURCE_PARTITION_VERIFIED_TARGET_NOT_RUN'});
  assert.equal(proof.sourceConnections,0);assert.equal(proof.targetConnections,0);assert.equal(proof.targetWrites,0);
});

test('listed account source partition keeps missing snapshots and quarantined accounts visible',async()=>{
  const missing=independentlyCheckedFixture();missing.rows['target-accounts'][0].snapshot=null;
  const missingProof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...missing});
  assert.deepEqual(missingProof.legacyListed,{scope:'ALL_CAPTURED_GAMES',sourceCount:1,readyWithSnapshot:0,readyWithoutSnapshot:1,isolated:0,status:'SOURCE_REVIEW_REQUIRED'});
  const isolated=independentlyCheckedFixture();isolated.rows['target-accounts'].shift();isolated.rows.quarantine.push({domain:'accounts',sourceId:'a1'});
  isolated.dataset.domains.accounts.ready--;isolated.dataset.domains.accounts.isolated++;
  const isolatedProof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...isolated});
  assert.deepEqual(isolatedProof.legacyListed,{scope:'ALL_CAPTURED_GAMES',sourceCount:1,readyWithSnapshot:0,readyWithoutSnapshot:0,isolated:1,status:'SOURCE_REVIEW_REQUIRED'});
});

test('independent selected-scope check refuses omitted users and non-order source exclusions',async()=>{
  const missing=independentlyCheckedFixture();missing.rows['target-users'].pop();
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...missing}),/SELECTED_SCOPE_INPUT_PARTITION_INCOMPLETE/);
  const excluded=independentlyCheckedFixture();excluded.dataset.population.domains.users.considered--;
  excluded.dataset.population.domains.users.excluded++;
  excluded.dataset.populationSha256=createHash('sha256').update(JSON.stringify(excluded.dataset.population)).digest('hex');
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...excluded}),/SELECTED_SCOPE_NON_ORDER_DOMAIN_EXCLUDED/);
  const malformed=independentlyCheckedFixture();delete malformed.dataset.population.domains.refunds.capturedIdsSha256;
  malformed.dataset.populationSha256=createHash('sha256').update(JSON.stringify(malformed.dataset.population)).digest('hex');
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...malformed}),/SELECTED_SCOPE_SOURCE_DOMAIN_INVALID/);
});

test('account ownership, status and preserved rental snapshot are checked against the captured source',async()=>{
  const valid=independentlyCheckedFixture();
  const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...valid});
  assert.deepEqual(proof.accountSnapshots,{compared:1,unavailable:1});
  for(const mutate of [row=>{row.ownerLegacyId='u2';},row=>{row.sourceStatus='4';},row=>{row.snapshot.haffRentYuan='99.00';},row=>{row.snapshot.dailyHaffBase='20000000';}]){
    const f=independentlyCheckedFixture();mutate(f.rows['target-accounts'][0]);
    await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_ACCOUNT_(SOURCE|SNAPSHOT)_MISMATCH/);
  }
});

test('paid legacy states without continuation support stay visible for manual review',async()=>{
  for(const status of ['2','6','7']){
    const f=independentlyCheckedFixture();for(const row of f.rows['source-orders'])Object.assign(row,{order_status:'1',is_delete:'0'});
    f.rows['source-orders'][0].order_status=status;
    f.data.distributionOrders=[];
    f.data.tradePolicy=[{id:'policy',type:'trade',name:'advanceOrderSetRatio',value:'70'},...Array.from({length:14},(_,i)=>({id:'p'+i,type:'expendConfig',name:'item'+i,value:String(i)}))];
    for(const name of ['distributionOrders','tradePolicy']){f.rows['source-'+name]=f.data[name];f.source.files[name]={file:'source-'+name,rows:f.data[name].length};}
    f.dataset.population=summarizePopulationScope(f.data,'SELECTED_BUSINESS_SCOPE',selectedScopeFilter(f.dataset.selectedScope),f.dataset.sourceReceiptSha256);
    f.dataset.populationSha256=createHash('sha256').update(JSON.stringify(f.dataset.population)).digest('hex');f.dataset.sourceRef='source';
    const counts={'2':0,'6':0,'7':0};counts[status]=1;
    f.dataset.domains.continuations={unsupportedStatuses:counts,preparedEvidence:{commissionPolicy:'ACTIVE_OR_SETTLED_SOURCE_V1'}};
    f.dataset.domains.liabilities={source:0};
    const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
    assert.deepEqual(proof.unsupportedContinuations,{...counts,total:1});
    counts[status]=0;
    await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_CONTINUATION_STATUS_DRIFT/);
  }
});

test('selected-scope preflight compares continuation fields and commissions before target access',async()=>{
  const f=independentlyCheckedFixture();for(const row of f.rows['source-orders'])Object.assign(row,{order_status:'1',is_delete:'0'});
  const order=f.rows['source-orders'][0];Object.assign(order,{order_status:'3',is_settle:'0',pay_money:'100.00',awm_bullet_price:'8.00'});
  const account=f.rows['source-accounts'].find(row=>row.id===order.accounts_id);account.base_bot='50';
  const payment=f.rows['source-pays'][0];Object.assign(payment,{pay_order_sn:'P1',pay_money:'100.00'});
  const commission={id:'c1',order_id:order.id,order_type:'1',user_id:'u2',ratio:'20',level:'2',status:'2',earnings:'1.00',is_delete:'0'};
  f.data.distributionOrders=[commission];f.data.tradePolicy=[{id:'policy',type:'trade',name:'advanceOrderSetRatio',value:'70'},
    ...Array.from({length:14},(_,i)=>({id:'p'+i,type:'expendConfig',name:'item'+i,value:String(i)}))];
  for(const name of ['distributionOrders','tradePolicy']){f.rows['source-'+name]=f.data[name];f.source.files[name]={file:'source-'+name,rows:f.data[name].length};}
  f.dataset.population=summarizePopulationScope(f.data,'SELECTED_BUSINESS_SCOPE',selectedScopeFilter(f.dataset.selectedScope),f.dataset.sourceReceiptSha256);
  f.dataset.populationSha256=createHash('sha256').update(JSON.stringify(f.dataset.population)).digest('hex');f.dataset.sourceRef='source';
  const policy={advanceOrderSetRatio:'70',expend:Object.fromEntries(f.data.tradePolicy.slice(1).map(row=>[row.name,row.value]))};
  const value=JSON.stringify(Object.fromEntries(Object.entries(commission).sort(([a],[b])=>a.localeCompare(b))));
  const continuation={sourceId:order.id,source:sourceContinuation(order,account,[payment],[commission],policy),commissionEvidence:[{sourceRecordId:commission.id,canonical:value,
    digest:createHash('sha256').update(value).digest('hex'),evidenceRef:'source:la_distribution_order:'+commission.id}]};
  f.rows['target-continuations']=[continuation];f.dataset.files.continuations={file:'target-continuations',rows:1};
  f.dataset.domains.continuations={unsupportedStatuses:{'2':0,'6':0,'7':0},preparedEvidence:{commissionPolicy:'ACTIVE_OR_SETTLED_SOURCE_V1'}};
  f.dataset.domains.liabilities={source:0};
  await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
  continuation.source.orderPrices.awm='99.00';
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/CONTINUATION_SOURCE_FACT_CHANGED/);
  continuation.source.orderPrices.awm='8.00';continuation.source.commissions=[];continuation.commissionEvidence=[];
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/CONTINUATION_COMMISSION_SOURCE_SET_CHANGED/);
});

test('a retained user refund must reference a retained order before the migration starts',async()=>{
  const good=independentlyCheckedFixture();
  const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...good});
  assert.deepEqual(proof.refundParents,{captured:1,retainedOrder:1,subjectIsolated:0,relationshipMatched:1,relationshipUnresolved:0});
  for(const patch of [{order_id:'o2'}, {order_id:'missing'}, {order_id:null,order_sn:'order-o1'}, {order_type:'recharge'}, {user_id:'missing'}]){
    const f=independentlyCheckedFixture();Object.assign(f.rows['source-refunds'][0],patch);
    await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_REFUND_(PARENT_NOT_RETAINED|USER_NOT_CAPTURED|TYPE_NOT_SUPPORTED)/);
  }
});

test('refunds of isolated source users are counted separately and never treated as imported',async()=>{
  const f=independentlyCheckedFixture();
  f.rows['target-users'].pop();f.rows.quarantine.push({domain:'users',sourceId:'u2'});f.rows['source-refunds'][0].user_id='u2';
  f.dataset.domains.users.ready=1;f.dataset.domains.users.isolated=1;
  const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
  assert.deepEqual(proof.refundParents,{captured:1,retainedOrder:0,subjectIsolated:1,relationshipMatched:0,relationshipUnresolved:0});
});

test('a mismatched refund subject or source order number is counted as unresolved rather than rewritten',async()=>{
  for(const patch of [{user_id:'u2'},{order_sn:'another-order'}]){
    const f=independentlyCheckedFixture();Object.assign(f.rows['source-refunds'][0],patch);
    const proof=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
    assert.equal(proof.refundParents.relationshipUnresolved,1);
  }
});

test('a refund of a ready user cannot proceed while its retained order is isolated',async()=>{
  const f=independentlyCheckedFixture();
  f.rows['target-orders'].pop();f.rows.quarantine.push({domain:'orders',sourceId:'o1'});f.dataset.domains.orders.ready=0;f.dataset.domains.orders.isolated=1;
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_REFUND_PARENT_ISOLATED/);
});

test('independent selected-scope check rejects a self-consistent wrong selection and missing target input',async()=>{
  const valid=independentlyCheckedFixture(),planned=structuredClone(valid.data);
  planned.pays[0].pay_is='0';
  const wrong=independentlyCheckedFixture(planned);
  assert.doesNotThrow(()=>assertSelectedScopeForWrite(wrong.dataset));
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...wrong}),/SELECTED_SCOPE_SOURCE_ORDER_DISPOSITION_MISMATCH/);
  const wrongConflictSource=structuredClone(valid.data);wrongConflictSource.orders[1].pay_is='1';
  const wrongConflict=independentlyCheckedFixture(wrongConflictSource);
  assert.doesNotThrow(()=>assertSelectedScopeForWrite(wrongConflict.dataset));
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...wrongConflict}),/SELECTED_SCOPE_SOURCE_PAYMENT_CONFLICT_MISMATCH/);
  valid.rows['target-orders'].length=0;
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...valid}),/SELECTED_SCOPE_INPUT_PARTITION_INCOMPLETE/);
});

test('independent selected-scope check identifies retained and isolated inputs exactly once',async()=>{
  const f=independentlyCheckedFixture();
  f.rows['target-accounts'].pop();f.rows.quarantine.push({domain:'accounts',sourceId:'a2'});
  f.dataset.domains.accounts.ready=1;f.dataset.domains.accounts.isolated=1;
  const result=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
  assert.deepEqual(result.accounts,{captured:3,retained:2,excluded:1,ready:1,isolated:1});
  f.rows.quarantine.push({domain:'accounts',sourceId:'a2'});
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_INPUT_PARTITION_INCOMPLETE/);
});

test('independent selected-scope check refuses a successful payment without its source order',async()=>{
  const f=independentlyCheckedFixture();f.rows['source-pays'].push(pay('missing-order','1'));
  f.source.files.pays.rows++;
  f.dataset.population=summarizePopulationScope(f.data,'SELECTED_BUSINESS_SCOPE',selectedScopeFilter(f.dataset.selectedScope),f.dataset.sourceReceiptSha256);
  f.dataset.populationSha256=createHash('sha256').update(JSON.stringify(f.dataset.population)).digest('hex');
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_PAID_ORDER_REFERENCE_MISSING/);
});

test('two successful payment records keep their shared order once without treating either as a duplicate order',async()=>{
  const f=independentlyCheckedFixture();
  f.data.pays.push({...pay('o1','1'),id:'second-success'});f.source.files.pays.rows++;
  f.dataset.population=summarizePopulationScope(f.data,'SELECTED_BUSINESS_SCOPE',selectedScopeFilter(f.dataset.selectedScope),f.dataset.sourceReceiptSha256);
  f.dataset.populationSha256=createHash('sha256').update(JSON.stringify(f.dataset.population)).digest('hex');
  const result=await verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f});
  assert.equal(result.orders.retained,1);
  assert.equal(f.dataset.population.domains.pays.considered,4);
});

test('unknown listing or rental-payment markers cannot silently remove a possible listing or paid order',async()=>{
  const valid=independentlyCheckedFixture();
  for(const field of ['status','is_delete']){
    const changed=structuredClone(valid.data);changed.accounts[0][field]='UNKNOWN';
    assert.throws(()=>planSelectedBusinessScope(changed),/SELECTED_SCOPE_ACCOUNT_STATE_UNKNOWN/);
    const f=independentlyCheckedFixture();f.rows['source-accounts'][0][field]='UNKNOWN';
    await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_ACCOUNT_STATE_UNKNOWN/);
  }
  const changed=structuredClone(valid.data);changed.pays[0].pay_is='UNKNOWN';
  assert.throws(()=>planSelectedBusinessScope(changed),/SELECTED_SCOPE_RENTAL_PAYMENT_STATE_UNKNOWN/);
  const f=independentlyCheckedFixture();f.rows['source-pays'][0].pay_is='UNKNOWN';
  await assert.rejects(verifySelectedPopulationFiles({datasetDir:'dataset',sourceDir:'source',...f}),/SELECTED_SCOPE_RENTAL_PAYMENT_STATE_UNKNOWN/);
  const guarantee=structuredClone(valid.data);guarantee.pays.push(pay('ignored','UNKNOWN',{order_type:'2'}));
  assert.doesNotThrow(()=>planSelectedBusinessScope(guarantee));
});

test("a listed account is kept even with no order or only unpaid orders", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1", { status: "3" }), account("a2")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "0")],
  });
  assert.deepEqual(scope.write.accounts, ["a1"]);
  assert.deepEqual(scope.excludedKeys.accounts, ["a2"]);
  assert.deepEqual(scope.write.orders, []);
});

test("an account with a paid order is kept and its unpaid orders stay out", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1" }), order("o2", "a1")],
    pays: [pay("o1", "1"), pay("o2", "0")],
  });
  assert.deepEqual(scope.write.accounts, ["a1"]);
  assert.deepEqual(scope.write.orders, ["o1"]);
  assert.deepEqual(scope.excludedKeys.orders, ["o2"]);
});

test("a paid-then-cancelled order is retained because the money moved", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1", order_status: "5" })],
    pays: [pay("o1", "1")],
  });
  assert.deepEqual(scope.write.orders, ["o1"]);
});

test("an unpaid order with failed attempts is excluded, not isolated and not queried", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "0"), pay("o1", "0")],
  });
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.equal(scope.partition.orders.conflicts.count, 0);
  // Its account has no retained rental money and is not listed, so it goes too.
  assert.deepEqual(scope.excludedKeys.accounts, ["a1"]);
  assert.equal(scope.policy.channelLookup, "NOT_PERFORMED");
  assert.equal(scope.policy.unpaidWithFailedAttempts, "EXCLUDED");
});

test("a type-1 payment with a paid marker keeps an order the order row calls unpaid", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "0" })],
    pays: [pay("o1", "1")],
  });
  assert.deepEqual(scope.write.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.paymentPaidOrderUnpaid, ["o1"]);
  assert.equal(scope.partition.orders.paymentPaidOrderUnpaid.count, 1);
  assert.equal(scope.partition.orders.orderPaidPaymentUnconfirmed.count, 0);
  const dataset={population:{mode:'SELECTED_BUSINESS_SCOPE'},selectedScope:scope,selectedScopeSha256:selectedScopeDigest(scope)};
  assert.throws(()=>assertSelectedScopeForWrite(dataset),/SELECTED_PAID_RECORD_ORDER_FLAG_CONFLICT_REVIEW_REQUIRED/);
});

test("an order marked paid without a successful rental payment is excluded and counted as a conflict", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1" })],
    pays: [pay("o1", "0")],
  });
  assert.deepEqual(scope.write.orders, []);
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.deepEqual(scope.excludedKeys.accounts, ["a1"]);
  assert.deepEqual(scope.conflictKeys.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.orderPaidPaymentUnconfirmed, ["o1"]);
  assert.equal(scope.partition.orders.orderPaidPaymentUnconfirmed.count, 1);
  assert.equal(scope.partition.orders.paymentPaidOrderUnpaid.count, 0);
  assert.equal(scope.policy.orderPaidWithoutPayment, "EXCLUDED");
  const dataset={population:{mode:'SELECTED_BUSINESS_SCOPE'},selectedScope:scope,selectedScopeSha256:selectedScopeDigest(scope)};
  assert.deepEqual(assertSelectedScopeForWrite(dataset),{retainedPaidOrderFlagConflicts:0,excludedOrderPaidWithoutSuccess:1});
});

test('selected write gate rejects tampered keys, digests and incomplete partitions',()=>{
  const scope=planSelectedBusinessScope({accounts:[account('a1')],orders:[order('o1','a1',{pay_is:'1'})],pays:[pay('o1','1')]});
  const base={population:{mode:'SELECTED_BUSINESS_SCOPE'},selectedScope:scope,selectedScopeSha256:selectedScopeDigest(scope)};
  assert.deepEqual(assertSelectedScopeForWrite(base),{retainedPaidOrderFlagConflicts:0,excludedOrderPaidWithoutSuccess:0});
  for(const change of [x=>x.selectedScopeSha256='0'.repeat(64),x=>x.selectedScope.write.orders=[],
    x=>x.selectedScope.conflictKeys.orders.push('o1'),x=>x.selectedScope.excludedKeys.accounts.push('a1')]){
    const input=structuredClone(base);change(input);assert.throws(()=>assertSelectedScopeForWrite(input),/SELECTED_SCOPE_/);
  }
});

test("a listed account survives an excluded payment conflict, and another paid order keeps its own account", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("listed", { status: "3" }), account("mixed")],
    orders: [order("unpaid-listed", "listed", { pay_is: "1" }), order("unpaid-mixed", "mixed", { pay_is: "1" }), order("paid", "mixed")],
    pays: [pay("unpaid-listed", "0"), pay("unpaid-mixed", "1", { order_type: "2" }), pay("paid", "1")],
  });
  assert.deepEqual(scope.write.accounts, ["listed", "mixed"]);
  assert.deepEqual(scope.write.orders, ["paid"]);
  assert.deepEqual(scope.excludedKeys.orders, ["unpaid-listed", "unpaid-mixed"]);
  assert.deepEqual(scope.conflictKeys.orderPaidPaymentUnconfirmed, ["unpaid-listed", "unpaid-mixed"]);
});

test("the old listing deposit can never make an order look paid", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "1", { order_type: "2" })],
  });
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.equal(scope.partition.orders.conflicts.count, 0);
});

test("the partition is disjoint and covers the source", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1", { status: "3" }), account("a2"), account("a3")],
    orders: [order("o1", "a1"), order("o2", "a2", { pay_is: "1" }), order("o3", "a3")],
    pays: [pay("o2", "1")],
  });
  for (const domain of ["accounts", "orders"]) {
    const seen = new Set();
    const lists = domain === "accounts"
      ? [scope.write.accounts, scope.excludedKeys.accounts]
      : [scope.write.orders, scope.excludedKeys.orders];
    for (const list of lists) for (const id of list) {
      assert.ok(!seen.has(id), `${domain}:${id} appears twice`);
      seen.add(id);
    }
    assert.equal(seen.size, scope.totals[domain]);
    assert.equal(scope.closure[domain].complete, true);
  }
});

test("duplicate or missing source keys are refused instead of silently merged", () => {
  assert.throws(() => planSelectedBusinessScope({ accounts: [account("a1"), account("a1")], orders: [], pays: [] }), /ACCOUNT_KEY_DUPLICATE/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [{ status: "4" }], orders: [], pays: [] }), /ACCOUNT_KEY_INVALID/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [], orders: [order("o1", "a1"), order("o1", "a1")], pays: [] }), /ORDER_KEY_DUPLICATE/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [], orders: [] }), /SELECTED_SCOPE_SOURCE_INVALID/);
});

test("the digest is stable for the same source and changes with the partition", () => {
  const source = { accounts: [account("a1")], orders: [order("o1", "a1", { pay_is: "1" })], pays: [pay("o1", "1")] };
  assert.equal(selectedScopeDigest(planSelectedBusinessScope(source)), selectedScopeDigest(planSelectedBusinessScope(source)));
  const changed = { ...source, orders: [order("o1", "a1")] };
  assert.notEqual(selectedScopeDigest(planSelectedBusinessScope(source)), selectedScopeDigest(planSelectedBusinessScope(changed)));
});
