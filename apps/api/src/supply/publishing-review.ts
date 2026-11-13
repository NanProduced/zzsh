/**
 * 上架审核与上下架域：接受规则、提交、撤回、审核决定、下架、限制与发布评估。
 * 写函数接收调用方的 PoolClient，过账与审核写入顺序保持在原函数内，不拆成多个提交点。
 */
import { assertFullPayoutTermsAccepted, readFullPayoutTerms } from "./full-payout-terms";
import { readReleaseEarlySettlementReference } from "../legal/legal-documents";
import { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { enqueueDelistedGuaranteeRefund } from "../credit/credit-guarantee";
import { hasUnpaidPaymentEvidence, requireFreshPaymentSnapshot, UNPAID_PAYMENT_FACT_COLUMNS, type UnpaidPaymentFacts } from "../order/unpaid-payment-facts";
import { readAccountOccupancyFacts } from "../order/legacy-order-occupancy";
import { humanText } from "./content-hash";
import { isEffectivePublicationState } from "./listing-query";
import { conflict, invalid, newSupplyId, notFound } from "./supply-util";
import { GAME_SERVICE, requireWritableGameService } from "./game-services";
import { readFundingPolicyForRelease } from "./funding-authority";
import { assignAccountNumber } from "./account-number";
import { assertFixedFeeTestListingAdmission, readScheduledDemoAccounts, type FixedFeeTestListingAdmission } from "../finance/controlled-fixed-fee-resource";
import { DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { type LegacyTakeoverGradingContext, type ListingMediaAssetRow, type ListingPageShared, type ListingPublication, type ListingVersion, type PublishingAccount, type SupplyGate, type SupplyGateReader, assertAccepted, assertCurrentRelease, assertMediaReady, assertPublicationRentalTerm, assertUnpublishedAccount, bumpAccount, checkAccountRevision, currentTradeResourcesMatch, currentVersion, isRetiredMigratedAccount, listingTitleNeedsReview, publicationBlockers, readListingPublication, requireVersionToken, validatePublicationAttributes } from "./publishing-internals";

export async function acceptListingRules(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已结束出租，不能修改上架资料");
  await assertUnpublishedAccount(client, a);
  await requireWritableGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可确认新申报草稿");
  if (!v.payload || !v.content_hash || !v.rule_release_id || !v.payload.ruleRefs)
    throw conflict("请先核对并生成本次资料的报价");
  await validatePublicationAttributes(client, a, v.payload!.declaration.attributes);
  await assertPublicationRentalTerm(client, v);
  const selected=v.payload?.declaration.attributes.full_payout_declaration as {selected?:boolean}|undefined;
  const policy=selected?.selected?await readFundingPolicyForRelease(client,v.rule_release_id!):null;
  if(selected?.selected && !policy)throw conflict("包赔资金政策未提供");
  const terms=selected?.selected?await readFullPayoutTerms(client,a.game_id,policy!,v.payload!.ruleRefs.priceVersionId):undefined;
  const accepted=terms?assertFullPayoutTermsAccepted(terms,body.fullPayoutTermsAcceptance):undefined;
  if(!terms && body.fullPayoutTermsAcceptance!==undefined)throw invalid("这份资料未选择包赔","fullPayoutTermsAcceptance");
  await client.query(
    `INSERT INTO zzsh_supply.rule_acceptance(id,owner_user_id,account_id,listing_version_id,rule_release_id,accepted_content_hash,full_payout_terms_version_id,full_payout_terms_digest,full_payout_disclosure_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_user_id,listing_version_id,rule_release_id,accepted_content_hash) DO NOTHING`,
    [
      newSupplyId("accept"),
      a.owner_user_id,
      a.id,
      v.id,
      v.rule_release_id,
      v.content_hash,
      accepted?.termsVersionId??null,accepted?.termsDigest??null,accepted?.disclosureVersion??null,
    ],
  );
  await bumpAccount(client, a);
}

/** Only an explicit, account-bound credit waiver may be frozen on publication. */
export function publicationWaiverRevision(a: PublishingAccount, v: ListingVersion, gate: SupplyGate): string | null {
  if (gate.occupancy !== "FREE" || !gate.reference || !["SATISFIED", "NOT_REQUIRED"].includes(gate.publisherBail))
    throw conflict("上架资格已变化，请刷新后重试");
  const credit = gate.creditGuarantee;
  if (!credit) throw conflict("信用与保证金资格暂不能确认，请联系客服");
  if (credit.accountId !== a.id || credit.ownerUserId !== a.owner_user_id || credit.gameId !== a.game_id
    || credit.listingVersionId !== v.id || credit.releaseId !== v.rule_release_id || !v.payload?.ruleRefs || credit.priceVersionId !== v.payload.ruleRefs.priceVersionId
    || credit.reference !== gate.reference || credit.status !== gate.publisherBail)
    throw conflict("上架保证金依据已变化，请刷新后重试");
  const revision = credit.status === "NOT_REQUIRED" ? credit.creditRevision : null;
  if (credit.status === "NOT_REQUIRED" && (credit.requiredCents !== "0" || !revision || !/^[1-9]\d*$/.test(revision)))
    throw conflict("上架免缴依据暂不能确认，请联系客服");
  return revision;
}

async function publicationTime(client: PoolClient): Promise<string> {
  const at = (await client.query<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
  if (!at) throw conflict("上架时间无法核实");
  return at;
}

export async function submitListing(
  client: PoolClient,
  a: PublishingAccount,
  actorId: string,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
  fixedFeeTestAdmission?: FixedFeeTestListingAdmission,
  fixedFeeDemo?: DemoFinanceResource,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已结束出租，不能再次上架");
  await assertUnpublishedAccount(client, a);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  if (v.review_state !== "DRAFT") throw conflict("当前资料不能重复提交");
  // shortcut: fixed-fee publication remains closed until the accounting and refund guards are complete.
  if (v.payload?.schemaVersion === 4 || v.payload?.pricingPolicy?.pricingModel === "SPREAD") {
    if (fixedFeeDemo) {
      if (!(await readScheduledDemoAccounts(client, fixedFeeDemo, [a.id], "WRITE")).has(a.id))
        throw conflict("此账号未获准进行模拟交易");
    } else {
      if (v.payload.pricingPolicy?.pricingModel === "SPREAD") throw conflict("价差订单结算暂未就绪");
      if (!fixedFeeTestAdmission) throw conflict("固定手续费订单结算暂未就绪");
      await assertFixedFeeTestListingAdmission(client, fixedFeeTestAdmission, { role: "OWNER", actorId, ownerUserId: a.owner_user_id,
        accountId: a.id, listingVersionId: v.id, listingHash: v.content_hash });
    }
  }

  await assertCurrentRelease(client, a, v);
  if (!v.payload || !v.content_hash || !v.rule_release_id || !v.payload.ruleRefs)
    throw conflict("请先核对并生成本次资料的报价");
  await validatePublicationAttributes(client, a, v.payload!.declaration.attributes);
  await assertPublicationRentalTerm(client, v);
  const blockers = await publicationBlockers(client, a, v, gate);
  if (blockers.length) throw conflict(blockers.join(","));
  await assertAccepted(client, a, v);
  await assertMediaReady(client, a, v, "direct", true);
  await readReleaseEarlySettlementReference(client, a.game_id, v.rule_release_id!);
  // The gate has locked current credit/coverage; freeze only its explicit waiver.
  const waivedRevision = publicationWaiverRevision(a, v, await gate(client, a, "WRITE"));
  a.display_no = await assignAccountNumber(client, a.id);
  const publishedAt = await publicationTime(client);
  await assertCurrentRelease(client, a, v, publishedAt);
  await client.query(
    `INSERT INTO zzsh_supply.listing_publication
      (id,version_id,account_id,owner_user_id,game_id,rule_release_id,content_hash,source,published_by_realm,published_by_user_id,published_at,
       credit_guarantee_waived,credit_guarantee_waived_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,'OWNER_DIRECT','user',$8,$9::timestamptz,$10,$11)`,
    [newSupplyId("publication"),v.id,a.id,a.owner_user_id,a.game_id,v.rule_release_id,v.content_hash,actorId,publishedAt,waivedRevision ? true : null,waivedRevision],
  );
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='PUBLISHED',revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}

export async function withdrawListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  if (v.id !== body.versionId || v.review_state !== "SUBMITTED")
    throw conflict("该版本已被处理");
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='WITHDRAWN',revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}

export async function reviewListing(
  client: PoolClient,
  a: PublishingAccount,
  actorId: string,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
  legacyGrading?: LegacyTakeoverGradingContext,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "SUBMITTED") throw conflict("该版本已被处理");
  if (!["APPROVE", "REJECT"].includes(String(body.decision)))
    throw invalid("审核决定错误");
  const reason = humanText(String(body.reason ?? "")).trim();
  if (reason.length < 2 || reason.length > 500)
    throw invalid("请填写具体审核理由");
  let waivedRevision: string | null = null;
  if (body.decision === "APPROVE") {
    await assertUnpublishedAccount(client, a);
    // shortcut: fixed-fee publication remains closed until the accounting and refund guards are complete.
    if(v.payload?.schemaVersion===4)throw conflict("固定手续费订单结算暂未就绪");
    if(v.payload?.pricingPolicy?.pricingModel==="SPREAD")throw conflict("价差订单仅支持号主直接上架");

    await validatePublicationAttributes(client, a, v.payload!.declaration.attributes, legacyGrading);
    await assertPublicationRentalTerm(client, v);
    const blockers = await publicationBlockers(client, a, v, gate);
    if (blockers.length) throw conflict(blockers.join(","));
    await assertAccepted(client, a, v);
    await assertMediaReady(client, a, v, "review", true);
    await readReleaseEarlySettlementReference(client, a.game_id, v.rule_release_id!);
    waivedRevision = publicationWaiverRevision(a, v, await gate(client, a, "WRITE"));
    a.display_no = await assignAccountNumber(client, a.id);
  }
  if (body.decision === "APPROVE") await assertCurrentRelease(client, a, v, await publicationTime(client));
  await client.query(
    `INSERT INTO zzsh_supply.review_decision(id,version_id,release_id,content_hash,decision,reason,reviewer_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      newSupplyId("review"),
      v.id,
      v.rule_release_id,
      v.content_hash,
      body.decision,
      reason,
      actorId,
    ],
  );
  if (body.decision === "APPROVE") {
    await client.query(
      `UPDATE zzsh_supply.listing_version SET review_state='APPROVED',revision=revision+1 WHERE id=$1`,
      [v.id],
    );
    const publication = await client.query(
      `INSERT INTO zzsh_supply.listing_publication
        (id,version_id,account_id,owner_user_id,game_id,rule_release_id,content_hash,source,published_by_realm,published_by_admin_id,published_at,
         credit_guarantee_waived,credit_guarantee_waived_revision)
       SELECT $1,d.version_id,v.account_id,a.owner_user_id,a.game_id,d.release_id,d.content_hash,
              'LEGACY_APPROVED','admin',d.reviewer_admin_id,d.decided_at,$4,$5
         FROM zzsh_supply.review_decision d
         JOIN zzsh_supply.listing_version v ON v.id=d.version_id
         JOIN zzsh_supply.rental_account a ON a.id=v.account_id
        WHERE d.version_id=$2 AND d.release_id=v.rule_release_id AND d.content_hash=v.content_hash
          AND d.decision='APPROVE' AND d.reviewer_admin_id=$3
       RETURNING id`,
      [newSupplyId("publication"), v.id, actorId, waivedRevision ? true : null, waivedRevision],
    );
    if (publication.rowCount !== 1) throw conflict("审核决定未能形成发布事实");
  } else {
    await client.query(
      `UPDATE zzsh_supply.listing_version SET review_state='REJECTED',revision=revision+1 WHERE id=$1`,
      [v.id],
    );
  }
  await bumpAccount(client, a);
}

/** Existing order/channel facts must be resolved before a listing can be permanently removed. */
async function assertDelistPaymentSafe(client: PoolClient, accountId: string, pendingOrderId: string | null): Promise<void> {
  const functions = (await client.query<{ posting: boolean; prestart: boolean; support: boolean; controlled: boolean; supportZero: boolean }>(`SELECT
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.native_refund_terminal_complete(text)'),'EXECUTE'),false) AS posting,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.native_prestart_refund_terminal_complete(text)'),'EXECUTE'),false) AS prestart,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.support_cancellation_refund_terminal_complete(text)'),'EXECUTE'),false) AS support,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.local_controlled_refund_terminal_complete(text)'),'EXECUTE'),false) AS controlled,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS "supportZero"`)).rows[0];
  if (!functions) throw conflict("订单收款状态暂不能确认，请联系客服");
  const checks: string[] = [];
  if (functions.posting) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='POSTING' AND zzsh_order.native_refund_terminal_complete(i.id))");
  if (functions.prestart) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='PRESTART_TERMINATION' AND zzsh_order.native_prestart_refund_terminal_complete(i.id))");
  if (functions.support) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='SUPPORT_CANCELLATION' AND zzsh_order.support_cancellation_refund_terminal_complete(i.id))");
  if (functions.controlled) checks.push("(i.payment_source='CONTROLLED' AND zzsh_order.local_controlled_refund_terminal_complete(i.id))");
  const refunded = checks.length ? `EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
    WHERE i.order_id=o.id AND i.payment_confirmation_id=pc.id AND i.state='SUCCEEDED' AND i.budget_disposition='CONSUMED'
      AND i.basis_kind IN ('PRESTART_TERMINATION','SUPPORT_CANCELLATION') AND NOT i.requires_review AND (${checks.join(" OR ")}))` : "false";
  const zeroRefund = functions.supportZero ? `EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation x
    WHERE x.order_id=o.id AND x.payment_confirmation_id=pc.id AND x.refund_cents=0
      AND zzsh_order.support_poststart_cancellation_complete(x.id)
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id))` : "false";
  const unresolved = await client.query(`SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=$1 AND o.id IS DISTINCT FROM $2
    AND (o.status IN ('PAID','COMPLETED') OR o.paid_confirmation_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_request q WHERE q.order_id=o.id)
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation q WHERE q.order_id=o.id)
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction q WHERE q.native_order_id=o.id))
    AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation pc
      JOIN zzsh_order.payment_request p ON p.order_id=o.id AND p.state='ACCEPTED'
      JOIN zzsh_order.payment_channel_transaction t ON t.native_order_id=o.id AND t.request_id=p.id
        AND t.channel=p.channel AND t.merchant_identity_id=p.merchant_identity_id AND t.channel_trx_no=pc.provider_transaction_id
      WHERE pc.id=o.paid_confirmation_id AND pc.order_id=o.id AND pc.disposition='APPLIED'
        AND pc.merchant_scope_id=p.merchant_identity_id AND pc.merchant_order_no=p.channel_order_no
        AND pc.amount_cents=p.amount_cents AND pc.currency=p.currency
        AND ((p.channel='JOINPAY' AND pc.source='JOINPAY' AND pc.joinpay_request_id=p.id AND pc.joinpay_anchor_id=t.id AND t.evidence_level='JOINPAY_VERIFIED'
            AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.id=pc.joinpay_evidence_id AND e.request_id=p.id
              AND e.event='E4' AND e.schema_outcome='VALID' AND e.signature_outcome='MATCH' AND e.binding_outcome='MATCH'
              AND e.channel_trx_no=pc.provider_transaction_id AND e.provider_paid_at=pc.provider_paid_at))
          OR (p.channel='CONTROLLED' AND pc.source='CONTROLLED' AND t.confirmation_id=pc.id AND t.evidence_level='CONTROLLED_TEST'))
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation other WHERE other.order_id=o.id AND other.id<>pc.id)
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction other WHERE other.native_order_id=o.id AND other.id<>t.id)
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id
          AND (i.requires_review OR i.state IN ('UNKNOWN','REVIEW_REQUIRED')
            OR (i.state IN ('SUCCEEDED','FAILED') AND (${checks.length ? checks.join(" OR ") : "false"}) IS NOT TRUE)))
        AND ((o.status='COMPLETED' AND EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s
          WHERE s.order_id=o.id AND s.payment_confirmation_id=pc.id AND s.captured_cents=pc.amount_cents))
          OR (o.status='CANCELLED' AND (${refunded} OR ${zeroRefund})
            AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id
              AND i.state IN ('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED'))))) LIMIT 1`, [accountId, pendingOrderId]);
  if (unresolved.rowCount) throw conflict("账号存在待核对的付款或退款，请先联系客服处理");
}

/** Caller holds the owner, game and account locks through the full transaction. */
export async function delistListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  actor: { userId: string; sessionId: string; requestId: string },
) {
  checkAccountRevision(a, body.expectedRevision);
  if (a.owner_user_id !== actor.userId) throw notFound();
  if (a.lifecycle !== "ACTIVE") throw conflict("该账号已结束出租，不能再次下架");
  await requireFreshPaymentSnapshot(client);
  if (await isRetiredMigratedAccount(client, a)) throw conflict("历史账号仅保留记录，请重新填写资料上架");
  const version = await currentVersion(client, a);
  const publication = await readListingPublication(client, a, version);
  if (version.origin !== "NATIVE" || !isEffectivePublicationState(version.review_state, publication?.source))
    throw conflict("当前账号未上架或仅保留历史资料");
  const occupancy = await readAccountOccupancyFacts(client, a.id);
  if (occupancy.state === "UNKNOWN") throw conflict("账号订单状态暂不能确认，请联系客服");
  if (occupancy.state === "OCCUPIED" && occupancy.kind !== "PENDING_PAYMENT")
    throw conflict("账号已有已付款或进行中的订单，请先处理订单");
  let cancelledOrderId: string | null = null;
  if (occupancy.kind === "PENDING_PAYMENT") {
    const pending = (await client.query<{ id: string }>(`SELECT id FROM zzsh_order.rental_order
      WHERE account_id=$1 AND owner_user_id=$2 AND status='PENDING_PAYMENT' FOR UPDATE`, [a.id,a.owner_user_id])).rows;
    if (pending.length !== 1) throw conflict("待付款订单状态已变化，请刷新后重试");
    const paymentFacts = (await client.query<UnpaidPaymentFacts>(`SELECT ${UNPAID_PAYMENT_FACT_COLUMNS}
      FROM zzsh_order.rental_order o WHERE o.id=$1`, [pending[0]!.id])).rows[0];
    if (!paymentFacts || hasUnpaidPaymentEvidence(paymentFacts)) throw conflict("待付款订单的支付状态需核对，请先联系客服处理");
    await assertDelistPaymentSafe(client, a.id, pending[0]!.id);
    const updated = await client.query(`UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='OWNER_DELISTED',
      cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
      WHERE id=$1 AND account_id=$2 AND status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL`, [pending[0]!.id,a.id]);
    if (updated.rowCount !== 1) throw conflict("待付款订单状态已变化，请刷新后重试");
    cancelledOrderId = pending[0]!.id;
    await recordAudit(client, { actorType:"user",actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
      action:"order.reservation.cancelled",objectType:"rental_order",objectId:cancelledOrderId,outcome:"SUCCESS",reason:"OWNER_DELISTED",
      details:{before:{status:"PENDING_PAYMENT"},after:{status:"CANCELLED",cancelReason:"OWNER_DELISTED"},accountId:a.id,channelClosed:false} });
  }
  else await assertDelistPaymentSafe(client, a.id, null);
  const remaining = await readAccountOccupancyFacts(client, a.id);
  if (remaining.state !== "FREE") throw conflict("账号还有未处理的订单，请联系客服");
  await client.query(`UPDATE zzsh_supply.rental_account SET lifecycle='DELISTED',owner_paused=false WHERE id=$1`, [a.id]);
  a.lifecycle = "DELISTED";
  a.owner_paused = false;
  await bumpAccount(client, a);
  let guaranteeRefund: Awaited<ReturnType<typeof enqueueDelistedGuaranteeRefund>>;
  try {
    guaranteeRefund = await enqueueDelistedGuaranteeRefund(client, {accountId:a.id,ownerUserId:a.owner_user_id,requestId:actor.requestId});
  } catch {
    throw conflict("保证金退款暂不能确认，请联系客服处理后再下架");
  }
  if (guaranteeRefund.state === "REVIEW_REQUIRED") throw conflict("保证金退款需要核对，请联系客服处理后再下架");
  return {cancelledOrderId,guaranteeRefund};
}

export async function restrictListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (
    typeof body.restricted !== "boolean" ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 2 ||
    body.reason.length > 500
  )
    throw invalid("请填写限制或解除原因");
  await client.query(
    `UPDATE zzsh_supply.rental_account SET staff_restricted=$2,restriction_reason=$3 WHERE id=$1`,
    [a.id, body.restricted, humanText(body.reason)],
  );
  a.staff_restricted = body.restricted;
  a.restriction_reason = body.reason;
  await bumpAccount(client, a);
}

export async function evaluatePublication(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
  gate: SupplyGateReader,
  purpose: "READ" | "WRITE" = "WRITE",
  strictReadErrors = false,
  shared?: ListingPageShared,
  media?: () => Promise<ListingMediaAssetRow[]>,
  observed?: { publication?: ListingPublication | null },
): Promise<string[]> {
  const publication = await readListingPublication(client, a, v);
  const blockers = await publicationBlockers(client, a, v, gate, purpose, strictReadErrors, shared, isEffectivePublicationState(v.review_state, publication?.source));
  if (observed) observed.publication = publication;
  if (!isEffectivePublicationState(v.review_state, publication?.source)) blockers.push("PUBLICATION_REQUIRED");
  if (a.owner_paused) blockers.push("OWNER_PAUSED");
  if (a.staff_restricted) blockers.push("STAFF_RESTRICTED");
  try {
    await assertAccepted(client, a, v);
  } catch (error) {
    if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
    // Acceptance failed before media was read, so this is not a confirmed missing image.
    blockers.push(v.payload && v.content_hash && v.rule_release_id ? "ACCEPTANCE_REQUIRED" : "QUOTE_REQUIRED");
    return blockers;
  }
  try {
    await assertMediaReady(client, a, v, "direct", false, media ? await media() : undefined);
  } catch (error) {
    if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
    blockers.push("MEDIA_REQUIRED");
  }
  return blockers;
}

/** Transaction preview keeps WRITE qualification predicates, but uses ordinary SELECT facts and READ gates. */
export async function evaluatePricePreviewPublication(client: PoolClient, a: PublishingAccount, v: ListingVersion, gate: SupplyGateReader): Promise<string[]> {
  const blockers = await evaluatePublication(client, a, v, gate, "READ", true);
  if (v.payload && v.origin === "NATIVE" && !(await currentTradeResourcesMatch(client, a, v, false))) blockers.push("RULE_CHANGED");
  if (listingTitleNeedsReview(v)) blockers.push("TITLE_REVIEW_REQUIRED");
  return [...new Set(blockers)];
}
