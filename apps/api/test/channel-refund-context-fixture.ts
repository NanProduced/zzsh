// 仅支付隔离库的合成上下文。复用原个人建单、完整受控接纳和假IM履约，不补写旧订单。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { AppConfig } from "../src/config/config";
import { assertAdminContextInTransaction, type AdminContext } from "../src/auth/auth-security";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission } from "../src/auth/admin-authorization";
import { writeAdminGameScope } from "../src/auth/admin-scope";
import { changeRentalMembership, readRentalMembership } from "../src/auth/rental-membership";
import { recordAudit, withTransaction } from "../src/auth/security-core";
import { createPaymentDistributionStore } from "../src/finance/distribution-payment-store";
import { ImIdentityProvisioner, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { updateOwnPresence } from "../src/im/consultation";
import { dispatchPaidOrders } from "../src/im/order-dispatch";
import { advanceOrderTeam } from "../src/im/order-team";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { acceptControlledPayment, assertSyntheticChannelRequestCapability, createSyntheticChannelRequestCapability } from "../src/order/channel-payment-store";
import { readOrderOccupancy } from "../src/order/order";
import { issuePersonalConfirmation, type PersonalConfirmationOptions } from "../src/order/personal-confirmation";
import { createPersonalReservation } from "../src/order/personal-order";
import { createControlledPaymentSource, type PaymentInput } from "../src/order/payment-confirmation";
import { computeContentHash } from "../src/supply/content-hash";
import { seedAdmin } from "./im-test-fixtures";
import { fakeIdentityAccounts, OrderTeamTransport } from "./order-team-fixtures";

export const REFUND_FIXTURE_PERMISSIONS = [ADMIN_PERMISSION.orderRead, ADMIN_PERMISSION.orderSettlementWrite,
  ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.imSupportAccept, ADMIN_PERMISSION.imSupportPresence,
  ADMIN_PERMISSION.userRentalMembershipManage] as const;
type Actor = { userId: string; sessionId: string };
type Checkpoint = { stage: string; orderId: string | null; declaredPayment: PaymentInput | null; confirmationId: string | null };
export type RefundContextInput = {
  config: AppConfig; resourceSet: string; resourceOid: number; approvalDigest: string; expiresAt: string; attempt: string;
  accountId: string; listingVersionId: string; gameId: string; renter: Actor; owner: Actor;
  support: Actor; roleId: string; appId: string; merchantScopeId: string;
  checkpoint: (value: Checkpoint) => Promise<void>;
  /** 当前personal-v2/v4使用既有完整reader装配；不将缺失声明降级成v1。 */
  confirmationOptions?: PersonalConfirmationOptions;
  /** 仅续办已提交的本fixture客服；必须重新核对原角色/会话/权限，不重新初始化。 */
  reusePreparedSupport?:true;
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 调用前必须有独立写窗；本函数不建池、安装DDL或读取配置/秘密。 */
export async function createNativeRefundContextFixture(pool: Pool, migrationPool: Pool, input: RefundContextInput) {
  if (!input || !/^[a-z][a-z0-9_]{0,20}$/.test(input.resourceSet)||!Number.isSafeInteger(input.resourceOid)||input.resourceOid<=0
    ||input.config?.database?.name!==`zzsh_test_order_${input.resourceSet}`||input.config?.database?.user!==`zzsh_order_${input.resourceSet}_r`
    || !/^[0-9a-f]{64}$/.test(input.approvalDigest) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()
    || !/^[a-z][a-z0-9_-]{0,55}$/.test(input.attempt)
    || input.reusePreparedSupport!==undefined&&input.reusePreparedSupport!==true
    || typeof input.checkpoint !== "function" || ![input.attempt, input.accountId, input.listingVersionId, input.gameId,
      input.roleId, input.appId, input.merchantScopeId, input.renter?.userId, input.renter?.sessionId,
      input.owner?.userId, input.owner?.sessionId, input.support?.userId, input.support?.sessionId].every(v => typeof v === "string" && ID.test(v))
    || input.renter.userId === input.owner.userId || [input.renter.userId,input.owner.userId].includes(input.support.userId)) {
    throw Error("REFUND_CONTEXT_INPUT_INVALID");
  }
  const capability = createSyntheticChannelRequestCapability({config:input.config,resourceSet:input.resourceSet,evidenceLevel:"CONTROLLED_TEST"});
  const progress: Checkpoint = {stage:"PREFLIGHT",orderId:null,declaredPayment:null,confirmationId:null};
  const mark = async (stage: string) => { progress.stage=stage; await input.checkpoint({...progress}); };
  const requestId = `refundfixture_${input.attempt}`;
  const support: AdminContext = { ...input.support, credentials:{headers:new Headers(),conflict:false,malformed:false},
    security:{status:"ACTIVE",isBoss:false,passwordChangeRequired:false},sessionLocked:false };
  try {
    const listing = await withTransaction(pool, async c => {
      await assertSyntheticChannelRequestCapability(c,capability);
      const row=(await c.query(`SELECT a.owner_user_id,a.game_id,a.current_version_id,v.content_hash,v.payload,v.rule_release_id
        FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
        WHERE a.id=$1 AND v.id=$2`,[input.accountId,input.listingVersionId])).rows[0];
      if(!row || row.owner_user_id!==input.owner.userId || row.game_id!==input.gameId
        || !row.content_hash || computeContentHash(row.payload)!==row.content_hash || await readOrderOccupancy(c,input.accountId)!=="FREE") {
        throw Error("REFUND_CONTEXT_CURRENT_FREE_LISTING_REQUIRED");
      }
      if(row.payload?.declaration?.attributes?.full_payout_declaration!==undefined && !input.confirmationOptions) throw Error("REFUND_CONTEXT_VERSIONED_FUNDING_NOT_ADMITTED");
      const membership=await readRentalMembership(c,input.renter.userId);
      if(membership.tier!=="STANDARD" && !(membership.tier==="UNKNOWN" && membership.version==="0")) throw Error("REFUND_CONTEXT_MEMBERSHIP_REQUIRES_REVIEW");
      const sessions=(await c.query(`SELECT id FROM zzsh_auth_user."session" WHERE (id=$1 AND "userId"=$2 OR id=$3 AND "userId"=$4)
        AND "expiresAt">clock_timestamp()`,[input.renter.sessionId,input.renter.userId,input.owner.sessionId,input.owner.userId])).rows;
      assert.equal(sessions.length,2,"original party sessions must still be active");
      return row;
    });
    await withTransaction(migrationPool,async c=>{
      const identity=(await c.query(`SELECT d.oid::int AS oid,current_user AS actor FROM pg_database d WHERE datname=current_database()`)).rows[0];
      if(identity?.oid!==input.resourceOid || identity?.actor!==`zzsh_order_${input.resourceSet}_m`) throw Error("REFUND_CONTEXT_MIGRATION_IDENTITY_MISMATCH");
      const collision=(await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_auth_admin."user" WHERE id=$1)
        OR EXISTS(SELECT 1 FROM zzsh_auth_admin."session" WHERE id=$2)
        OR EXISTS(SELECT 1 FROM zzsh_iam.admin_role WHERE id=$3 OR code=$3)
        OR EXISTS(SELECT 1 FROM zzsh_iam.im_identity_mapping WHERE app_id=$4)
        OR EXISTS(SELECT 1 FROM zzsh_order.im_order_group WHERE app_id=$4)
        OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation WHERE merchant_scope_id=$5) AS used`,
        [input.support.userId,input.support.sessionId,input.roleId,input.appId,input.merchantScopeId])).rows[0];
      if(input.reusePreparedSupport===true){
        const existing=(await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s
          JOIN zzsh_iam.admin_user_role ur ON ur.admin_user_id=s."userId" JOIN zzsh_iam.admin_role r ON r.id=ur.role_id
          WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">clock_timestamp() AND r.id=$3 AND r.code=$3 AND r.status='ACTIVE') AS prepared,
          EXISTS(SELECT 1 FROM zzsh_iam.im_identity_mapping WHERE app_id=$4)
          OR EXISTS(SELECT 1 FROM zzsh_order.im_order_group WHERE app_id=$4)
          OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation WHERE merchant_scope_id=$5) AS used`,
          [input.support.sessionId,input.support.userId,input.roleId,input.appId,input.merchantScopeId])).rows[0];
        if(existing?.prepared!==true||existing.used!==false)throw Error('REFUND_CONTEXT_ORIGINAL_SUPPORT_OR_ATTEMPT_DIFF');
        return;
      }
      if(collision?.used!==false) throw Error("REFUND_CONTEXT_ATTEMPT_ALREADY_USED_NO_RETRY");
      const permissions=(await c.query(`SELECT code FROM zzsh_iam.admin_permission WHERE code=ANY($1::text[])`,[[...REFUND_FIXTURE_PERMISSIONS]])).rows;
      assert.equal(permissions.length,REFUND_FIXTURE_PERMISSIONS.length,"all real command permissions must exist");
      // 现有helper只用query；绑定当前事务，不让它另开连接。此合成身份不证明真实MFA/登录通过。
      await seedAdmin({query:c.query.bind(c)} as Pool,input.support.userId,input.support.sessionId,input.attempt,false);
      await c.query(`INSERT INTO zzsh_iam.admin_role(id,code,name,status) VALUES($1,$1,'合成退款fixture客服','ACTIVE')`,[input.roleId]);
      await c.query(`INSERT INTO zzsh_iam.admin_role_permission(role_id,permission_code) SELECT $1,unnest($2::text[])`,[input.roleId,[...REFUND_FIXTURE_PERMISSIONS]]);
      await c.query(`INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES($1,$2)`,[input.support.userId,input.roleId]);
      await writeAdminGameScope(c,input.support.userId,{mode:"SELECTED_GAMES",gameIds:[input.gameId],replaceSelected:true},input.support.userId);
      await recordAudit(c,{actorType:"system",actorId:"refund-synthetic-fixture",requestId,action:"test.refund.fixture.staff.created",
        objectType:"admin_user",objectId:input.support.userId,outcome:"SUCCESS",details:{evidence:"CONTROLLED_TEST",isBoss:false,gameId:input.gameId,permissions:[...REFUND_FIXTURE_PERMISSIONS]}});
    });
    await mark("SYNTHETIC_SUPPORT_COMMITTED");
    await withTransaction(pool,async c=>{
      await assertAdminContextInTransaction(c,support);
      const access=await loadEffectiveAdminAccess(c,support.userId);
      assert.equal(access?.isBoss,false);
      assert.deepEqual([...access!.permissions].sort(),[...REFUND_FIXTURE_PERMISSIONS].sort());
      requirePermission(access,ADMIN_PERMISSION.userRentalMembershipManage);
      const before=await readRentalMembership(c,input.renter.userId);
      if(before.tier==="UNKNOWN" && before.version==="0") await changeRentalMembership(c,input.renter.userId,
        {tier:"STANDARD",expectedVersion:"0",sourceRef:`fixture:${input.attempt}`,reason:"合成退款个人确认前置"},support,requestId);
      else if(before.tier!=="STANDARD") throw Error("REFUND_CONTEXT_MEMBERSHIP_CHANGED");
    });
    await mark("MEMBERSHIP_READY");
    const options: PersonalConfirmationOptions & {holdSeconds:number} = input.confirmationOptions ? {...input.confirmationOptions,holdSeconds:3600} : {holdSeconds:3600,
      key:{keyId:"refund_fixture_only",secret:randomBytes(32).toString("hex")},
      gate:async(c,a)=>({occupancy:await readOrderOccupancy(c,a.id),publisherBail:"NOT_REQUIRED",reference:`fixture:${input.attempt}:not-required`}),
      fundingReader:async(_c,a,v)=>a.id===input.accountId && a.owner_user_id===input.owner.userId && v.id===input.listingVersionId && v.content_hash===listing.content_hash
        ? {schema:"personal-quote-v1",version:`fixture:${input.attempt}:v1`,sourceRef:`fixture:${input.attempt}:${a.id}`,baseDepositCents:"30000",
          publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,fullPayoutSelected:false,fullPayoutPolicyRef:"fixture:none",fullPayoutFeeCents:"0"}:null };
    const created=await withTransaction(pool,async c=>{
      const issued=await issuePersonalConfirmation(c,input.renter,{accountId:input.accountId,versionId:input.listingVersionId,releaseId:listing.rule_release_id},options);
      const result=await createPersonalReservation(c,input.renter,issued.confirmationToken,options,requestId);
      if(result.status!==200) throw Error("REFUND_CONTEXT_PERSONAL_ORDER_REJECTED");
      progress.orderId=(result.body as {order:{id:string}}).order.id;
      await mark("PERSONAL_ORDER_BEFORE_COMMIT");
      return progress.orderId;
    });
    progress.orderId=created; await mark("PERSONAL_ORDER_COMMITTED");
    const order=(await pool.query(`SELECT display_no,quote_snapshot,currency,(rental_amount_cents+deposit_amount_cents)::text AS amount
      FROM zzsh_order.rental_order WHERE id=$1 AND confirmation_id IS NOT NULL`,[created])).rows[0];
    const personalSchema=order?.quote_snapshot?.personal?.schema;
    assert.ok(['personal-quote-v1','personal-quote-v2','personal-quote-v4'].includes(personalSchema));
    if(listing.payload?.declaration?.attributes?.full_payout_declaration!==undefined&&personalSchema==='personal-quote-v1')throw Error('REFUND_CONTEXT_VERSIONED_FUNDING_DOWNGRADED');
    await withTransaction(migrationPool,async c=>{
      const audits=(await c.query(`SELECT id FROM zzsh_iam.audit_event WHERE action='order.reservation.created' AND object_type='rental_order'
        AND object_id=$1 AND request_id=$2 AND outcome='SUCCESS'`,[created,requestId])).rows;
      assert.equal(audits.length,1);
      await c.query(`INSERT INTO zzsh_order.distribution_order_admission(id,order_id,resource_oid,resource_name,resource_marker,approval_digest,
        native_creation_audit_id,revision,active,admitted_at,expires_at,created_by_admin_id,reason)
        VALUES($1,$2,$3,$4,'zzsh:order-reservation-test:v1',$5,$6,1,true,clock_timestamp(),$7::timestamptz,$8,'合成原生退款fixture')`,
        [`admission_${input.attempt}`,created,input.resourceOid,input.config.database.name,input.approvalDigest,audits[0]!.id,input.expiresAt,input.support.userId]);
    });
    progress.declaredPayment={orderId:created,merchantOrderNo:order.display_no,providerTransactionId:`trx_${input.attempt}`,
      amountCents:order.amount,currency:order.currency,providerPaidAt:new Date().toISOString(),requestId};
    await mark("DECLARED_LOCAL_PAYMENT_BEFORE_ACCEPTANCE");
    const fact=createControlledPaymentSource({config:input.config,resourceSet:input.resourceSet,appId:input.appId,
      merchantScopeId:input.merchantScopeId,allowedOrderIds:[created]})(progress.declaredPayment);
    const distribution=createPaymentDistributionStore({resourceSet:input.resourceSet,resourceOid:input.resourceOid,
      approvalDigest:input.approvalDigest,allowedOrderIds:[created]});
    const accepted=await withTransaction(pool,async c=>{
      const result=await acceptControlledPayment(c,{fact,distribution});
      progress.confirmationId=result.payment.confirmationId;
      await mark("LOCAL_PAYMENT_BEFORE_COMMIT");
      return result;
    });
    assert.equal(accepted.payment.disposition,"APPLIED");
    progress.confirmationId=accepted.payment.confirmationId; await mark("LOCAL_PAYMENT_COMMITTED");
    const accounts=fakeIdentityAccounts(),identities=new ImIdentityProvisioner(new YunxinIdentityRepository(pool),accounts.api);
    for(const [realm,kind,id] of [["admin","ADMIN",support.userId],["user","USER",input.renter.userId],
      ["user","USER",input.owner.userId],["system","SYSTEM","support-manager"]] as const){
      const key:ImIdentityKey={provider:"yunxin",appId:input.appId,realm,kind,platformSubjectId:id};
      assert.equal((await identities.ensure({key})).outcome,"READY","fake IM identity must be ready without retry");
    }
    await updateOwnPresence({pool,appId:input.appId},support,{availability:"AVAILABLE",connectionState:"CONNECTED"},requestId);
    await dispatchPaidOrders(pool,input.appId,1);
    const wire=new OrderTeamTransport();
    await advanceOrderTeam({pool,appId:input.appId,provider:wire.client,identities,membersLimit:200},created);
    const group=(await pool.query(`SELECT assigned_admin_id,team_state FROM zzsh_order.im_order_group WHERE order_id=$1 AND app_id=$2`,[created,input.appId])).rows[0];
    assert.equal(group?.assigned_admin_id,support.userId); assert.equal(group?.team_state,"READY");
    const basis=(await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.payment_distribution_basis WHERE order_id=$1 AND payment_confirmation_id=$2`,[created,progress.confirmationId])).rows[0];
    assert.equal(basis?.n,1);
    await mark("FAKE_TEAM_READY");
    const lines=order.quote_snapshot.lines as Array<{itemId:string;quantity:string}>;
    assert.ok(Array.isArray(lines) && lines.length>0 && lines.every(x=>ID.test(x.itemId)&&/^[1-9]\d*$/.test(x.quantity)));
    return {scope:"CONTROLLED_TEST" as const,orderId:created,confirmationId:progress.confirmationId,
      renter:{realm:"user" as const,...input.renter},owner:{realm:"user" as const,...input.owner},support:{realm:"admin" as const,...input.support},
      openingLines:lines.map(x=>({itemId:x.itemId,quantity:x.quantity})),remainingLines:lines.map(x=>({itemId:x.itemId,quantity:"0"})),
      capability,personalSchema:personalSchema as 'personal-quote-v1'|'personal-quote-v2'|'personal-quote-v4',realProviderCalls:0,formalRefund:false as const};
  } catch(error) {
    throw Object.assign(error instanceof Error?error:Error(String(error)),{refundContextPartial:{...progress,retainOriginalReferences:true,retryAuthorized:false}});
  }
}
