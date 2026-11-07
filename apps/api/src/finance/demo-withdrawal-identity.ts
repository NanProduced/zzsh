import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { demoFinanceScope, type DemoFinanceResource } from "./ecs-test-demo-resource";

/** A test payout is not real KYC; still require an adult identity fact before a new demo request. */
export async function assertDemoWithdrawalIdentity(client:PoolClient,userId:string,demo:DemoFinanceResource) {
  const row=(await client.query<{account_status:string;identity_status:string;age_status:string;provider:string;provider_reference:string|null;verified_at:Date|null;now:Date}>(
    `SELECT account_status,identity_status,age_status,provider,provider_reference,verified_at,clock_timestamp() AS now
      FROM zzsh_iam.user_identity_state WHERE user_id=$1`,[userId])).rows[0];
  const local=demoFinanceScope(demo)==="LOCAL_DEMO_SIMULATED", validProvider=row?.provider==="aliyun-id2meta" || local&&row?.provider==="fake";
  const reference=row?.provider_reference, time=row?.verified_at;
  if(!row || row.account_status!=="ACTIVE" || row.identity_status!=="VERIFIED")
    throw new SecurityApiError(403,"DEMO_WITHDRAW_IDENTITY_REQUIRED","请先完成本人实名认证");
  if(row.age_status!=="ADULT")throw new SecurityApiError(403,"DEMO_WITHDRAW_ADULT_REQUIRED","请先确认实名信息属于成年人");
  if(!validProvider || typeof reference!=="string" || !reference || reference.trim()!==reference || Buffer.byteLength(reference)>512
    || /[\u0000-\u001f\u007f]/.test(reference) || !local&&/SYNTHETIC|MODEL|LOCAL_CONTROLLED|FAKE|MOCK|TEST/i.test(reference)
    || !(time instanceof Date) || !Number.isFinite(time.getTime()) || !(row.now instanceof Date) || time>row.now)
    throw new SecurityApiError(403,"DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED","实名信息暂无法核实，请联系客服");
}
