import { WithdrawalRequestError, assertCurrent, badWithdrawal, cents, id, key, record, recoveryStorage, revision, text, time, underWithdrawalLock, withdrawalRequest, type WithdrawalWriteOptions } from "./withdrawal-client-core.ts";

export type DemoScope = "LOCAL_DEMO_SIMULATED" | "ECS_TEST_SIMULATED";
export type DemoWithdrawalLimits = { minCents: string; maxCents: string };
export type DemoTargetBody = { bankBindingId: string; bankBindingRevision: string; amountCents: string };
export type DemoBody = { amountCents: string; destinationId: string; policyVersion: string; expectedWalletVersion: string };
export type DemoTarget = { id: string; kind: "BANK_CARD"; mask: string; amountCents: string; currency: "CNY"; expiresAt: string; policyVersion: string };
export type DemoQuote = { destinationId: string; policyVersion: string; ledgerRevision: string; acceptedAt: string; currency: "CNY"; grossCents: string; netCents: string; feeCents: string; requestKey: string };
export type DemoIntent = { id: string; state: "RESERVED" | "SUBMITTING" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "RECONCILIATION_REQUIRED"; fundsDisposition: "RESERVED" | "PAYOUT_POSTED" | "RELEASE_POSTED"; amountCents: string; netCents: string; feeCents: string; acceptedAt: string };
export type DemoPending = { version: 1; userId: string; scope: DemoScope } & (
  | { stage: "target"; key: string; body: DemoTargetBody }
  | { stage: "target-ready"; key: string; body: DemoTargetBody; target: DemoTarget }
  | { stage: "confirm"; key: string; body: DemoBody; quote: DemoQuote }
);
const prefix = "zzsh.demo-withdrawal.v1:";
const scopes = ["LOCAL_DEMO_SIMULATED", "ECS_TEST_SIMULATED"] as const;
const demoScope = (value: unknown): DemoScope => { if (!scopes.includes(value as DemoScope)) throw badWithdrawal(); return value as DemoScope; };
const positive = (value: unknown) => { const n = cents(value); if (BigInt(n) <= 0n) throw badWithdrawal(); return n; };
function amounts(value: Record<string, unknown>, amountKey: string) {
  const amount = positive(value[amountKey]), net = positive(value.netCents), fee = cents(value.feeCents);
  if (BigInt(amount) !== BigInt(net) + BigInt(fee)) throw badWithdrawal();
  return { amount, net, fee };
}
function envelope(value: unknown, contractVersion: string) {
  const row = record(value), scope = demoScope(row.scope);
  if (row.contractVersion !== contractVersion || row.bankArrival !== "UNKNOWN") throw badWithdrawal();
  return { row, scope };
}
export function parseDemoAvailability(value: unknown) {
  const {row,scope} = envelope(value,"demo-withdrawal-availability.v1");
  if (typeof row.withdrawalEnabled !== "boolean" || row.productionPayoutCapability !== false) throw badWithdrawal();
  const raw=record(row.limits),minCents=positive(raw.minCents),maxCents=positive(raw.maxCents);
  if(BigInt(minCents)>BigInt(maxCents))throw badWithdrawal();
  return {scope,withdrawalEnabled:row.withdrawalEnabled,limits:{minCents,maxCents},observedAt:time(row.observedAt)};
}
export function parseDemoTarget(value: unknown) {
  const {row,scope} = envelope(value,"demo-withdrawal-target.v1"), target = record(row.target), mask = text(target.mask,32);
  if (target.kind !== "BANK_CARD" || target.currency !== "CNY" || !/^\*{4} \*{4} \d{4}$/.test(mask)) throw badWithdrawal();
  return {scope,target:{id:id(target.id),kind:"BANK_CARD" as const,mask,amountCents:positive(target.amountCents),currency:"CNY" as const,expiresAt:time(target.expiresAt),policyVersion:id(target.policyVersion)}};
}
export function parseDemoQuote(value: unknown) {
  const {row,scope} = envelope(value,"demo-withdrawal-quote.v1"), q=record(row.quote), a=amounts(q,"grossCents");
  if (q.currency !== "CNY") throw badWithdrawal();
  return {scope,quote:{destinationId:id(q.destinationId),policyVersion:id(q.policyVersion),ledgerRevision:revision(q.ledgerRevision),acceptedAt:time(q.acceptedAt),currency:"CNY" as const,grossCents:a.amount,netCents:a.net,feeCents:a.fee,requestKey:key(q.requestKey)}};
}
export function parseDemoResult(value: unknown) {
  const {row,scope} = envelope(value,"demo-withdrawal-result.v1"), i=record(row.intent), a=amounts(i,"amountCents");
  if (!["RESERVED","SUBMITTING","PROCESSING","UNKNOWN","SUCCEEDED","FAILED","RECONCILIATION_REQUIRED"].includes(String(i.state))
    || !["RESERVED","PAYOUT_POSTED","RELEASE_POSTED"].includes(String(i.fundsDisposition))
    || i.state === "SUCCEEDED" && i.fundsDisposition !== "PAYOUT_POSTED" || i.state === "FAILED" && i.fundsDisposition !== "RELEASE_POSTED"
    || ["RESERVED","SUBMITTING","PROCESSING","UNKNOWN"].includes(String(i.state)) && i.fundsDisposition !== "RESERVED") throw badWithdrawal();
  return {scope,intent:{id:id(i.id),state:i.state as DemoIntent["state"],fundsDisposition:i.fundsDisposition as DemoIntent["fundsDisposition"],amountCents:a.amount,netCents:a.net,feeCents:a.fee,acceptedAt:time(i.acceptedAt)}};
}
export function parseDemoReceipt(value: unknown, stage: "target" | "confirm") {
  const {row,scope}=envelope(value,stage==="target"?"demo-withdrawal-target-receipt.v1":"demo-withdrawal-receipt.v1");
  if (!["KNOWN","UNKNOWN"].includes(String(row.knowledge)) || row.mayReapply!==false || (row.knowledge==="KNOWN")!==(row.receipt!==null)) throw badWithdrawal();
  const receipt=row.receipt===null?null:stage==="target"?parseDemoTarget(row.receipt):parseDemoResult(row.receipt);
  if (receipt && receipt.scope!==scope) throw badWithdrawal();
  return {scope,knowledge:row.knowledge as "KNOWN"|"UNKNOWN",receipt};
}
function targetBody(value: DemoTargetBody): DemoTargetBody { const bankBindingRevision=revision(value.bankBindingRevision);if(bankBindingRevision==="0")throw badWithdrawal();return {bankBindingId:id(value.bankBindingId),bankBindingRevision,amountCents:positive(value.amountCents)}; }
function demoBody(value: DemoBody): DemoBody { return {amountCents:positive(value.amountCents),destinationId:id(value.destinationId),policyVersion:id(value.policyVersion),expectedWalletVersion:revision(value.expectedWalletVersion)}; }
function requireScope(actual: DemoScope, expected: DemoScope) { if (actual!==expected) throw badWithdrawal(); }
function storage(userId: string) { return prefix+id(userId); }
export function pendingDemoWithdrawal(userId: string): DemoPending | null {
  try {
    const raw=recoveryStorage().getItem(storage(userId));if(raw===null)return null;
    const item=record(JSON.parse(raw)),scope=demoScope(item.scope),body=record(item.body),pendingKey=key(item.key);
    if(item.version!==1||item.userId!==userId)throw badWithdrawal();
    if(item.stage==="target")return {version:1,userId,scope,stage:"target",key:pendingKey,body:targetBody(body as DemoTargetBody)};
    if(item.stage==="target-ready") { const target=parseDemoTarget({contractVersion:"demo-withdrawal-target.v1",scope,target:item.target,bankArrival:"UNKNOWN"}).target;
      const original=targetBody(body as DemoTargetBody);if(target.amountCents!==original.amountCents)throw badWithdrawal();
      return {version:1,userId,scope,stage:"target-ready",key:pendingKey,body:original,target}; }
    if(item.stage==="confirm") { const quote=parseDemoQuote({contractVersion:"demo-withdrawal-quote.v1",scope,quote:item.quote,bankArrival:"UNKNOWN"}).quote;
      const original=demoBody(body as DemoBody);if(quote.requestKey!==pendingKey||quote.grossCents!==original.amountCents||quote.destinationId!==original.destinationId||quote.policyVersion!==original.policyVersion||quote.ledgerRevision!==original.expectedWalletVersion)throw badWithdrawal();
      return {version:1,userId,scope,stage:"confirm",key:pendingKey,body:original,quote}; }
    throw badWithdrawal();
  } catch { throw new WithdrawalRequestError(0,"RECOVERY_STORAGE_UNAVAILABLE"); }
}
function storePending(pending: DemoPending) {
  try { const s=recoveryStorage(),raw=JSON.stringify(pending);s.setItem(storage(pending.userId),raw);if(s.getItem(storage(pending.userId))!==raw)throw Error(); }
  catch { throw new WithdrawalRequestError(0,"RECOVERY_STORAGE_UNAVAILABLE"); }
}
function clearPending(pending: DemoPending) { const current=pendingDemoWithdrawal(pending.userId);if(current?.key!==pending.key||current.scope!==pending.scope)throw new WithdrawalRequestError(409,"RECOVERY_CONTEXT_CHANGED");recoveryStorage().removeItem(storage(pending.userId)); }
function definitive(error: unknown, current: () => boolean) { return current() && error instanceof WithdrawalRequestError && [400,403,404,413,422].includes(error.status); }
export async function readDemoAvailability(userId: string, signal?: AbortSignal) { return parseDemoAvailability(await withdrawalRequest("demo-withdrawal","",{expectedUserId:userId,signal})); }
export async function createDemoTarget(userId: string, scope: DemoScope, value: DemoTargetBody, options: WithdrawalWriteOptions = {}) {
  const body=targetBody(value),current=options.isCurrent??(()=>true);
  return underWithdrawalLock("demo-withdrawal",userId,async()=>{
    assertCurrent(current,options.signal);if(pendingDemoWithdrawal(userId))throw new WithdrawalRequestError(409,"PENDING_REQUEST_EXISTS");
    const pending:DemoPending={version:1,userId,scope,stage:"target",key:crypto.randomUUID(),body};storePending(pending);
    try {const result=parseDemoTarget(await withdrawalRequest("demo-withdrawal","/target",{expectedUserId:userId,method:"POST",body,key:pending.key,signal:options.signal}));
      assertCurrent(current,options.signal);requireScope(result.scope,scope);if(result.target.amountCents!==body.amountCents)throw badWithdrawal();
      const ready:DemoPending={...pending,stage:"target-ready",target:result.target};storePending(ready);return ready;
    } catch(error) {if(definitive(error,current))clearPending(pending);throw error;}
  });
}
export async function quoteDemoWithdrawal(userId: string, scope: DemoScope, target: DemoTarget, walletVersion: string, signal?: AbortSignal) {
  const body=demoBody({amountCents:target.amountCents,destinationId:target.id,policyVersion:target.policyVersion,expectedWalletVersion:walletVersion});
  const result=parseDemoQuote(await withdrawalRequest("demo-withdrawal","/quote",{expectedUserId:userId,method:"POST",body,signal}));requireScope(result.scope,scope);
  if(result.quote.grossCents!==body.amountCents||result.quote.destinationId!==body.destinationId||result.quote.policyVersion!==body.policyVersion||result.quote.ledgerRevision!==body.expectedWalletVersion)throw badWithdrawal();
  return {body,quote:result.quote};
}
export async function confirmDemoWithdrawal(userId: string, scope: DemoScope, body: DemoBody, quote: DemoQuote, options: WithdrawalWriteOptions = {}) {
  const current=options.isCurrent??(()=>true),input=demoBody(body);
  return underWithdrawalLock("demo-withdrawal",userId,async()=>{
    assertCurrent(current,options.signal);const original=pendingDemoWithdrawal(userId);
    if(!original||original.scope!==scope||original.stage!=="target-ready"||original.target.id!==input.destinationId||original.target.amountCents!==input.amountCents||original.target.policyVersion!==input.policyVersion||quote.ledgerRevision!==input.expectedWalletVersion||quote.grossCents!==input.amountCents||quote.destinationId!==input.destinationId||quote.policyVersion!==input.policyVersion)throw new WithdrawalRequestError(409,"RECOVERY_CONTEXT_CHANGED");
    const pending:DemoPending={version:1,userId,scope,stage:"confirm",key:key(quote.requestKey),body:input,quote};storePending(pending);
    try {const result=parseDemoResult(await withdrawalRequest("demo-withdrawal","/confirm",{expectedUserId:userId,method:"POST",body:input,key:pending.key,signal:options.signal}));
      assertCurrent(current,options.signal);requireScope(result.scope,scope);if(result.intent.amountCents!==quote.grossCents||result.intent.netCents!==quote.netCents||result.intent.feeCents!==quote.feeCents)throw badWithdrawal();clearPending(pending);return result.intent;
    } catch(error) {if(definitive(error,current))clearPending(pending);throw error;}
  });
}
export async function recoverDemoWithdrawal(userId: string, scope: DemoScope, options: WithdrawalWriteOptions = {}) {
  const current=options.isCurrent??(()=>true);
  return underWithdrawalLock("demo-withdrawal",userId,async()=>{
    assertCurrent(current,options.signal);const pending=pendingDemoWithdrawal(userId);if(!pending||pending.scope!==scope)throw new WithdrawalRequestError(409,"RECOVERY_CONTEXT_CHANGED");
    if(pending.stage==="target-ready")return {knowledge:"KNOWN" as const,pending,intent:null};
    const path=(pending.stage==="target"?"/target/receipt?key=":"/receipt?key=")+encodeURIComponent(pending.key);
    const result=parseDemoReceipt(await withdrawalRequest("demo-withdrawal",path,{expectedUserId:userId,signal:options.signal}),pending.stage);assertCurrent(current,options.signal);requireScope(result.scope,scope);
    if(result.knowledge==="UNKNOWN"||!result.receipt)return {knowledge:"UNKNOWN" as const,pending,intent:null};
    if(pending.stage==="target"&&"target" in result.receipt) {const target=result.receipt.target;if(target.amountCents!==pending.body.amountCents)throw badWithdrawal();
      const ready:DemoPending={...pending,stage:"target-ready",target};storePending(ready);return {knowledge:"KNOWN" as const,pending:ready,intent:null};}
    if(pending.stage==="confirm"&&"intent" in result.receipt){const intent=result.receipt.intent;if(intent.amountCents!==pending.quote.grossCents||intent.netCents!==pending.quote.netCents||intent.feeCents!==pending.quote.feeCents)throw badWithdrawal();clearPending(pending);return {knowledge:"KNOWN" as const,pending:null,intent};}
    throw badWithdrawal();
  });
}
export async function discardDemoTarget(userId:string,scope:DemoScope) {return underWithdrawalLock("demo-withdrawal",userId,async()=>{const pending=pendingDemoWithdrawal(userId);if(!pending||pending.scope!==scope||pending.stage!=="target-ready")throw new WithdrawalRequestError(409,"RECOVERY_CONTEXT_CHANGED");clearPending(pending);});}
export async function readDemoIntent(userId:string,scope:DemoScope,intentId:string,signal?:AbortSignal) {const result=parseDemoResult(await withdrawalRequest("demo-withdrawal","/intents/"+encodeURIComponent(id(intentId)),{expectedUserId:userId,signal}));requireScope(result.scope,scope);if(result.intent.id!==intentId)throw badWithdrawal();return result.intent;}
