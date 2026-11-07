import type { Pool } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { assertEcsTestDemoResource, demoFinanceScope, type DemoFinanceResource } from "./ecs-test-demo-resource";
import { declareLocalSandboxWithdrawalTarget, readLocalSandboxWithdrawalTargetReceipt } from "./local-sandbox-withdrawal-target";
import { createControlledWithdrawal, readControlledWithdrawalQuote, readControlledWithdrawals, recoverControlledWithdrawal } from "./controlled-withdrawal-store";
import { ownerLocalWithdrawalPolicy } from "./controlled-withdrawal";
import type { NativeWithdrawalScope } from "./native-withdrawal-resource";

type Actor = UserContext & { requestId: string };
export type EcsDemoWithdrawalOptions = Readonly<{ demo: DemoFinanceResource; scope: NativeWithdrawalScope }>;
type Intent = { id:string; state:string; fundsDisposition:string; amountCents:string; netCents:string; feeCents:string; acceptedAt:string };
type Target = { id:string; kind:string; mask:string; amountCents:string; currency:string; expiresAt:string; policyVersion:string };
const unavailable=()=>new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","测试提现原记录暂不可用");
function originalTarget(value:unknown):Target {
  const target=(value as {target?:Partial<Target>}|null)?.target;
  if (!target || typeof target.id!=="string" || !/^sandbox_wdd_[a-f0-9]{40}$/.test(target.id) || target.kind!=="BANK_CARD"
    || typeof target.mask!=="string" || !/^\*{4} \*{4} [0-9]{4}$/.test(target.mask)
    || typeof target.amountCents!=="string" || !/^[1-9][0-9]{0,23}$/.test(target.amountCents) || target.currency!=="CNY"
    || typeof target.expiresAt!=="string" || !Number.isFinite(Date.parse(target.expiresAt))
    || typeof target.policyVersion!=="string" || !target.policyVersion) throw unavailable();
  return target as Target;
}
function originalIntent(value:unknown):Intent {
  const intent=(value as {intent?:Partial<Intent>}|null)?.intent;
  if (!intent || typeof intent.id!=="string" || !/^wd_[a-f0-9]{40}$/.test(intent.id)
    || typeof intent.state!=="string" || !["RESERVED","SUBMITTING","PROCESSING","UNKNOWN","SUCCEEDED","FAILED","RECONCILIATION_REQUIRED"].includes(intent.state)
    || typeof intent.fundsDisposition!=="string" || !["RESERVED","PAYOUT_POSTED","RELEASE_POSTED"].includes(intent.fundsDisposition)
    || ![intent.amountCents,intent.netCents,intent.feeCents].every(x=>typeof x==="string"&&/^(0|[1-9][0-9]{0,23})$/.test(x))
    || typeof intent.acceptedAt!=="string" || !Number.isFinite(Date.parse(intent.acceptedAt))) throw unavailable();
  if (BigInt(intent.amountCents!)!==BigInt(intent.netCents!)+BigInt(intent.feeCents!))throw unavailable();
  return intent as Intent;
}

function targetResult(demo:DemoFinanceResource, target:Target) {
  return { contractVersion:"demo-withdrawal-target.v1", scope:demoFinanceScope(demo), target,
    bankArrival:"UNKNOWN" as const };
}
function intentResult(demo:DemoFinanceResource, intent:Intent) {
  const {id,state,fundsDisposition,amountCents,netCents,feeCents,acceptedAt}=intent;
  return { contractVersion:"demo-withdrawal-result.v1", scope:demoFinanceScope(demo),
    intent:{id,state,fundsDisposition,amountCents,netCents,feeCents,acceptedAt}, bankArrival:"UNKNOWN" as const };
}

export async function readDemoWithdrawalAvailability(pool:Pool,actor:Actor,options:EcsDemoWithdrawalOptions) {
  return withTransaction(pool,async c=>{
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const registration=await assertEcsTestDemoResource(c,options.demo,"READ_ORIGINAL");
    await assertUserContextInTransaction(c,actor,"READ");
    const policy=ownerLocalWithdrawalPolicy("BANK_CARD",[actor.userId]);
    return {contractVersion:"demo-withdrawal-availability.v1",scope:demoFinanceScope(options.demo),
      withdrawalEnabled:registration.active,limits:{minCents:policy.minCents,maxCents:policy.maxCents},productionPayoutCapability:false,bankArrival:"UNKNOWN" as const,observedAt:new Date().toISOString()};
  });
}

export async function createDemoWithdrawalTarget(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,options:EcsDemoWithdrawalOptions) {
  const result=await declareLocalSandboxWithdrawalTarget(pool,actor,body,key,options.demo);
  return targetResult(options.demo,originalTarget(result.body));
}
export async function readDemoWithdrawalTargetReceipt(pool:Pool,actor:Actor,key:string,options:EcsDemoWithdrawalOptions) {
  const result=await readLocalSandboxWithdrawalTargetReceipt(pool,actor,key,options.demo);
  return {contractVersion:"demo-withdrawal-target-receipt.v1",scope:demoFinanceScope(options.demo),knowledge:result.knowledge,
    receipt:result.receipt?targetResult(options.demo,originalTarget(result.receipt)):null,mayReapply:false,bankArrival:"UNKNOWN" as const};
}
export async function quoteDemoWithdrawal(pool:Pool,actor:Actor,body:Record<string,unknown>,options:EcsDemoWithdrawalOptions) {
  const {quote}=await readControlledWithdrawalQuote(pool,actor,body,options.scope);
  const {destinationId,policyVersion,ledgerRevision,acceptedAt,currency,grossCents,netCents,feeCents,requestKey}=quote;
  return {contractVersion:"demo-withdrawal-quote.v1",scope:demoFinanceScope(options.demo),
    quote:{destinationId,policyVersion,ledgerRevision,acceptedAt,currency,grossCents,netCents,feeCents,requestKey},bankArrival:"UNKNOWN" as const};
}
export async function confirmDemoWithdrawal(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,options:EcsDemoWithdrawalOptions) {
  const result=await createControlledWithdrawal(pool,actor,body,key,options.scope);
  return intentResult(options.demo,originalIntent(result.body));
}
export async function readDemoWithdrawalReceipt(pool:Pool,actor:Actor,key:string,options:EcsDemoWithdrawalOptions) {
  const result=await recoverControlledWithdrawal(pool,actor,key,options.scope);
  return {contractVersion:"demo-withdrawal-receipt.v1",scope:demoFinanceScope(options.demo),knowledge:result.knowledge,
    receipt:result.receipt?intentResult(options.demo,originalIntent(result.receipt)):null,mayReapply:false,bankArrival:"UNKNOWN" as const};
}
export async function readDemoWithdrawalIntent(pool:Pool,actor:Actor,id:string,options:EcsDemoWithdrawalOptions) {
  const result=await readControlledWithdrawals(pool,actor,id,options.scope);
  return intentResult(options.demo,originalIntent(result));
}
