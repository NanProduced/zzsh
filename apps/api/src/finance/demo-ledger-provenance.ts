import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";

export type DemoLedgerOrigin = "LOCAL_DEMO_SIMULATED" | "ECS_TEST_SIMULATED" | "UNKNOWN";

/** Classify only exact controlled money facts. An unproved controlled source stays unknown. */
export async function readDemoLedgerOrigins(client:PoolClient,ids:readonly string[]):Promise<Map<string,DemoLedgerOrigin>> {
  const result=new Map<string,DemoLedgerOrigin>();if(!ids.length)return result;
  const status=(await client.query<{present:boolean;ready:boolean;support_ready:boolean}>(`SELECT
    to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NOT NULL AS present,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.support_poststart_cancellation'),'SELECT'),false)
      AND COALESCE(has_function_privilege(to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS support_ready,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.ecs_test_demo_finance_registration'),'SELECT'),false)
      AND COALESCE(has_table_privilege(to_regclass('zzsh_order.controlled_payment_declaration'),'SELECT'),false)
      AND COALESCE(has_table_privilege(to_regclass('zzsh_order.withdrawal_intent'),'SELECT'),false)
      AND COALESCE(has_table_privilege(to_regclass('zzsh_order.withdrawal_admission'),'SELECT'),false)
      AND COALESCE(has_table_privilege(to_regclass('zzsh_order.ecs_demo_legacy_refund'),'SELECT'),false) AS ready`)).rows[0];
  if(status?.present!==true)return result;
  if(status.ready!==true)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","测试资金来源暂不可核对");
  const rows=(await client.query<{id:string;candidate:boolean;schema:string|null}>(`SELECT l.id,
    (r.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' OR p.payment_confirmation_id IS NOT NULL AND pay.source='CONTROLLED'
      OR (r.source_kind='NATIVE_SUPPORT_CANCELLATION' ${status.support_ready ? "AND (sp.id IS NULL OR spay.source IS DISTINCT FROM 'JOINPAY')" : ""})
      OR e.kind='DEMO_LEGACY_REFUND_PAID') AS candidate,
    COALESCE(wproof.schema,pproof.schema,lproof.schema${status.support_ready ? ',sproof.schema' : ''}) AS schema
    FROM zzsh_order.settlement_ledger_entry l
    LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id
    LEFT JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
    LEFT JOIN zzsh_order.rental_referral_earning re ON r.source_kind='NATIVE_RENTAL_REFERRAL'
      AND re.economic_root_id=r.id AND re.beneficiary_user_id=l.counterparty_user_id
    LEFT JOIN zzsh_order.settlement_posting p ON p.id=COALESCE(l.posting_id,re.posting_id)
      AND (re.id IS NULL OR re.order_id=p.order_id AND re.payment_confirmation_id=p.payment_confirmation_id)
    LEFT JOIN zzsh_order.payment_confirmation pay ON pay.id=p.payment_confirmation_id AND pay.order_id=p.order_id
    ${status.support_ready ? `LEFT JOIN zzsh_order.support_poststart_cancellation sp ON sp.id=r.source_id
      AND sp.root_id=r.id AND sp.event_id=e.id AND e.kind='SUPPORT_CANCELLATION_RECOGNIZED'
    LEFT JOIN zzsh_order.payment_confirmation spay ON spay.id=sp.payment_confirmation_id AND spay.order_id=sp.order_id` : ''}
    LEFT JOIN LATERAL (SELECT s.canonical_registration::jsonb->>'schema' AS schema
      FROM zzsh_order.withdrawal_intent w JOIN zzsh_order.withdrawal_admission a
        ON a.id=w.admission_id AND a.user_id=w.user_id AND a.sandbox_registration_ref=w.sandbox_registration_ref
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=w.sandbox_registration_ref
      WHERE r.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' AND r.source_entity='withdrawal_intent' AND e.kind IN ('RESERVE','RELEASE','PAYOUT')
        AND w.id=r.source_id AND w.user_id=l.counterparty_user_id AND r.subject_user_id=w.user_id AND w.mode='LOCAL_CONTROLLED'
        AND a.resource_oid::text=(s.canonical_registration::jsonb #>> '{resource,databaseOid}')
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')) wproof ON true
    LEFT JOIN LATERAL (SELECT s.canonical_registration::jsonb->>'schema' AS schema
      FROM zzsh_order.rental_order o JOIN zzsh_order.controlled_payment_declaration d ON d.order_id=o.id
        AND d.merchant_scope_id=pay.merchant_scope_id AND d.provider_transaction_id=pay.provider_transaction_id
        AND d.merchant_order_no=pay.merchant_order_no AND d.mode='LOCAL_CONTROLLED_DECLARED_PAYMENT'
      JOIN zzsh_order.distribution_order_admission a ON a.id=d.admission_id AND a.order_id=o.id AND a.revision=d.admission_revision
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=d.approval_digest AND s.registration_digest=a.approval_digest
      WHERE pay.source='CONTROLLED' AND pay.disposition='APPLIED' AND o.id=pay.order_id AND o.paid_confirmation_id=pay.id
        AND (re.id IS NOT NULL OR l.posting_id=p.id AND ((l.account_code='OWNER_AVAILABLE' AND l.counterparty_user_id=o.owner_user_id)
          OR (l.account_code='RENTER_REFUND_PAYABLE' AND l.counterparty_user_id=o.renter_user_id)))
        AND a.mode='LOCAL_CONTROLLED' AND a.resource_oid=d.resource_oid AND a.resource_name=current_database()
        AND a.resource_marker=(s.canonical_registration::jsonb #>> '{resource,marker}')
        AND d.resource_oid::text=(s.canonical_registration::jsonb #>> '{resource,databaseOid}')
        AND d.canonical_payment::jsonb->>'orderId'=pay.order_id AND d.canonical_payment::jsonb->>'amountCents'=pay.amount_cents::text
        AND d.canonical_payment::jsonb->>'currency'=pay.currency AND d.canonical_payment::jsonb->>'providerTransactionId'=pay.provider_transaction_id
        AND d.payment_digest=encode(sha256(convert_to(d.canonical_payment,'UTF8')),'hex')
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')) pproof ON true
    LEFT JOIN LATERAL (SELECT s.canonical_registration::jsonb->>'schema' AS schema
      FROM zzsh_order.ecs_demo_legacy_refund x JOIN zzsh_order.legacy_duty_finance_fact f ON f.duty_id=x.duty_id AND f.order_id=x.order_id
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=x.registration_ref
      WHERE e.kind='DEMO_LEGACY_REFUND_PAID' AND x.event_id=e.id AND e.economic_root_id=f.root_id
        AND x.renter_user_id=l.counterparty_user_id AND x.renter_user_id=f.subject_user_id AND x.renter_user_id=e.subject_user_id
        AND f.kind='RENTER_REFUND' AND x.source_digest=f.parent_source_digest AND x.duty_fact_digest=f.facts_digest
        AND x.amount_cents=f.amount_cents AND x.created_xid=f.created_xid AND x.created_xid=e.created_xid
        AND l.line_no=1 AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=x.amount_cents AND l.credit_cents=0
        AND l.details=jsonb_build_object('demoLegacyRefundId',x.id,'dataOrigin','SIMULATED','orderId',x.order_id,'dutyFactDigest',x.duty_fact_digest)
        AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry other WHERE other.finance_event_id=x.event_id AND other.line_no=2
          AND other.account_code='PAYOUT_CLEARING' AND other.debit_cents=0 AND other.credit_cents=x.amount_cents AND other.counterparty_user_id IS NULL
          AND other.details=l.details)
        AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event audit WHERE audit.action='demo.legacy.refund.simulated' AND audit.object_id=x.duty_id
          AND audit.actor_type='admin' AND audit.actor_id=x.actor_id AND audit.session_id=x.session_id AND audit.request_id=x.request_id
          AND audit.outcome='SUCCESS' AND audit.details->>'operationId'=x.id AND audit.details->>'bankArrival'='UNKNOWN')
        AND x.assumption='SIMULATION_ASSUME_NO_PRIOR_REFUND' AND x.amount_cents>0 AND x.amount_cents<=x.paid_cents
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')) lproof ON true
    ${status.support_ready ? `LEFT JOIN LATERAL (SELECT s.canonical_registration::jsonb->>'schema' AS schema
      FROM zzsh_order.controlled_payment_declaration d
      JOIN zzsh_order.distribution_order_admission a ON a.id=d.admission_id AND a.order_id=sp.order_id AND a.revision=d.admission_revision
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=d.approval_digest AND s.registration_digest=a.approval_digest
      WHERE spay.source='CONTROLLED' AND spay.disposition='APPLIED' AND d.order_id=sp.order_id
        AND d.merchant_scope_id=spay.merchant_scope_id AND d.provider_transaction_id=spay.provider_transaction_id
        AND d.merchant_order_no=spay.merchant_order_no AND d.mode='LOCAL_CONTROLLED_DECLARED_PAYMENT'
        AND l.details->>'supportCancellationId'=sp.id AND zzsh_order.support_poststart_cancellation_complete(sp.id)
        AND a.mode='LOCAL_CONTROLLED' AND a.resource_oid=d.resource_oid AND a.resource_name=current_database()
        AND a.resource_marker=(s.canonical_registration::jsonb #>> '{resource,marker}')
        AND d.resource_oid::text=(s.canonical_registration::jsonb #>> '{resource,databaseOid}')
        AND d.canonical_payment::jsonb->>'orderId'=spay.order_id AND d.canonical_payment::jsonb->>'amountCents'=spay.amount_cents::text
        AND d.canonical_payment::jsonb->>'currency'=spay.currency AND d.canonical_payment::jsonb->>'providerTransactionId'=spay.provider_transaction_id
        AND d.payment_digest=encode(sha256(convert_to(d.canonical_payment,'UTF8')),'hex')
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')) sproof ON true` : ''}
    WHERE l.id=ANY($1::text[])`,[ids])).rows;
  for(const row of rows){
    if(row.schema==='ecs-test-demo-finance.v1')result.set(row.id,'ECS_TEST_SIMULATED');
    else if(row.schema==='local-demo-clone-finance.v1')result.set(row.id,'LOCAL_DEMO_SIMULATED');
    else if(row.candidate===true)result.set(row.id,'UNKNOWN');
  }
  return result;
}
