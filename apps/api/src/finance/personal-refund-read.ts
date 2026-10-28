import type { PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { SecurityApiError } from "../auth/security-core";
import { invalid, notFound } from "../supply/supply-util";

export const PERSONAL_REFUND_READ_VERSION = "personal-native-refunds.v1";
const INTENT_LIMIT = 50;
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const REFUND_NO = /^RF[0-9a-f]{28}$/;
const EVENT = /^[A-Z][A-Z_]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const ZERO_OR_CENTS = /^(0|[1-9][0-9]{0,23})$/;
const POSITIVE_CENTS = /^[1-9][0-9]{0,15}$/;
const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const ORDER_STATUSES = ["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"] as const;
const INTENT_STATES = ["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED", "SUCCEEDED", "FAILED"] as const;
const DISPOSITIONS = ["ALLOCATED", "CONSUMED", "RELEASED"] as const;
const EVIDENCE_LEVELS = ["PROVIDER_RESPONSE", "SYNTHETIC_PROTOCOL"] as const;

export type PersonalOrderStatus = (typeof ORDER_STATUSES)[number] | "UNRECOGNIZED";
export type PersonalRefundSource = "LOCAL_CONTROLLED" | "JOINPAY_FORMAL" | "UNRECOGNIZED";
export type PersonalRefundIntentState = (typeof INTENT_STATES)[number] | "UNRECOGNIZED";
export type PersonalRefundBudgetDisposition = (typeof DISPOSITIONS)[number] | "UNRECOGNIZED";
export type PersonalRefundOutcome =
  | "RESPONSIBILITY_NOT_POSTED"
  | "ZERO_RESPONSIBILITY"
  | "NOT_DUE"
  | "NO_INTENT"
  | "PARTIALLY_ALLOCATED"
  | "FULLY_ALLOCATED"
  | "PARTIALLY_CONSUMED"
  | "FULLY_CONSUMED"
  | "RELEASED"
  | "PROCESSING"
  | "UNKNOWN"
  | "REVIEW_REQUIRED"
  | "TRUNCATED"
  | "CONFLICT";

export type PersonalRefundObservation = Readonly<{
  source: "JOINPAY" | "CONTROLLED";
  event: string;
  failureReason: string | null;
  evidenceLevel: (typeof EVIDENCE_LEVELS)[number] | null;
  observedAt: string;
  ageSeconds: number | null;
  trust: "LOCAL_OBSERVATION_NOT_REVALIDATED";
}>;

export type PersonalRefundBasis = "POSTING" | "REVIEW_CONFIRMATION";
export type PersonalFirstSubmit = Readonly<{
  dispatch: "NEVER_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
  blockedReason: "ORIGINAL_ORDER_NO_AMBIGUOUS" | "ABNORMAL_BASIS_REVIEW" | null;
  blockedAt: string | null;
  blockedAuditCount: number | null;
  trust: "LOCAL_AUDIT_AND_ATTEMPT";
}>;
export type PersonalAbnormalResponsibility = Readonly<{
  confirmationId: string;
  reasonCode: "DUPLICATE_PAYMENT" | "LATE_PAYMENT" | "UNKNOWN_REASON";
  originalCents: string | null;
  currency: "CNY" | null;
  liabilityRootId: string | null;
  liabilityEventId: string | null;
  intentIds: readonly string[];
  allocatedCents: string | null;
  consumedCents: string | null;
  releasedCents: string | null;
  remainingCents: string | null;
  totalsComplete: boolean;
  state: "NO_INTENT" | "READY" | "PROCESSING" | "UNKNOWN" | "CONSUMED" | "RELEASED" | "REVIEW_REQUIRED" | "CONFLICT";
  firstSubmit: PersonalFirstSubmit | null;
  reasonCodes: readonly string[];
}>;

export type PersonalRefundIntent = Readonly<{
  intentId: string;
  refundOrderNo: string | null;
  source: PersonalRefundSource;
  evidenceLevel: string | null;
  basisKind: PersonalRefundBasis;
  paymentConfirmationId: string | null;
  amount: Readonly<{ cents: string; currency: "CNY" }> | null;
  state: PersonalRefundIntentState;
  budgetDisposition: PersonalRefundBudgetDisposition;
  requiresReview: boolean;
  dueAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  latestObservation: PersonalRefundObservation | null;
  latestFailure: PersonalRefundObservation | null;
  firstSubmit: PersonalFirstSubmit | null;
  savedChannelEvidence: Readonly<{
    terminal: "SUCCEEDED" | "FAILED_NO_EXECUTION";
    evidenceLevel: (typeof EVIDENCE_LEVELS)[number] | null;
    providerRefundTrxNo: string | null;
    completedAt: string | null;
    trust: "SAVED_EVIDENCE_NOT_REVALIDATED";
  }> | null;
  localAccounting: Readonly<{
    disposition: PersonalRefundBudgetDisposition;
    writeOff: Readonly<{ eventId: string; amountCents: string; postedAt: string | null; trust: "LOCAL_LEDGER" }> | null;
    release: Readonly<{ intentUpdatedAt: string | null; ledgerEventId: null; trust: "LOCAL_INTENT_ONLY" }> | null;
    reasonCodes: readonly string[];
  }>;
  channelFacts: Readonly<{
    actualAmountCents: null;
    channelRefundTrxNo: null;
    completedAt: null;
    destination: null;
    bankArrival: "UNKNOWN";
    reasonCodes: readonly string[];
  }>;
  reasonCodes: readonly string[];
}>;

export type PersonalRefundReadProjection = Readonly<{
  contractVersion: "personal-native-refunds.v1";
  subjectId: string;
  order: Readonly<{ orderId: string; displayNo: string | null; status: PersonalOrderStatus }>;
  status: "AVAILABLE" | "NOT_APPLICABLE";
  outcome: PersonalRefundOutcome;
  coverage: Readonly<{ scope: "LOCAL_REGISTERED_ONLY"; intentLimit: number; intentsComplete: boolean; channelRecordsChecked: false }>;
  asOf: string;
  responsibility: Readonly<{
    state: "POSTED" | "NOT_POSTED";
    postingId: string | null;
    originalCents: string | null;
    allocatedCents: string | null;
    consumedCents: string | null;
    releasedCents: string | null;
    remainingCents: string | null;
    totalsComplete: boolean;
    dueAt: string | null;
    dueState: "DUE" | "NOT_DUE" | "UNKNOWN";
  }>;
  abnormalResponsibilities: readonly PersonalAbnormalResponsibility[];
  responsibilitiesTruncated: boolean;
  responsibilityTotals: Readonly<{
    originalCents: string | null;
    allocatedCents: string | null;
    consumedCents: string | null;
    releasedCents: string | null;
    remainingCents: string | null;
    totalsComplete: boolean;
    postingOriginalCents: string | null;
    abnormalOriginalCents: string | null;
    abnormalConfirmationCount: number;
  }>;
  intents: readonly PersonalRefundIntent[];
  returnedIntentCount: number;
  intentsTruncated: boolean;
  actualChannelRefund: Readonly<{
    amountCents: null;
    channelRefundTrxNo: null;
    completedAt: null;
    destination: null;
    bankArrival: "UNKNOWN";
    reasonCodes: readonly string[];
  }>;
  localFundsEffect: Readonly<{
    basis: "LOCAL_REGISTERED_ACCOUNTING";
    writtenOffCents: string | null;
    releasedCents: string | null;
    bankArrival: "UNKNOWN";
  }>;
  reasonCodes: readonly string[];
  unknowns: readonly string[];
}>;

type Row = Record<string, unknown>;

const REQUIRED = [
  { table: "zzsh_order.rental_order", columns: ["id", "display_no", "status", "renter_user_id"] },
  { table: "zzsh_order.settlement_posting", columns: ["id", "order_id", "currency", "renter_refund_cents", "refund_due_at", "posted_at"] },
  { table: "zzsh_order.payment_confirmation", columns: ["id", "order_id", "source", "disposition", "reason_code", "currency", "amount_cents",
    "merchant_scope_id", "provider_transaction_id", "merchant_order_no", "joinpay_request_id", "joinpay_evidence_id", "joinpay_anchor_id"] },
  { table: "zzsh_order.payment_request", columns: ["id", "order_id", "channel", "evidence_level", "merchant_identity_id", "channel_order_no", "amount_cents", "currency"] },
  { table: "zzsh_order.joinpay_collection_binding", columns: ["request_id", "wire_merchant_no", "formal_admission_ref"] },
  { table: "zzsh_order.payment_channel_transaction", columns: ["id", "channel", "evidence_level", "native_order_id", "request_id", "merchant_identity_id", "channel_trx_no"] },
  { table: "zzsh_order.channel_refund_intent", columns: ["id", "posting_id", "order_id", "renter_user_id", "payment_source", "evidence_level",
    "refund_order_no", "amount_cents", "currency", "state", "budget_disposition", "requires_review", "due_at", "created_at", "updated_at",
    "terminal_evidence_id", "terminal_root_id", "terminal_event_id", "provider_refund_trx_no", "completed_at",
    "basis_kind", "payment_confirmation_id", "liability_root_id", "liability_event_id", "responsibility_version_hash",
    "merchant_identity_id", "original_payment_trx_no", "original_payment_order_no"] },
  { table: "zzsh_order.channel_refund_observation", columns: ["id", "intent_id", "event", "failure_reason", "created_at"] },
  { table: "zzsh_order.joinpay_refund_observation", columns: ["id", "intent_id", "event", "evidence_level", "schema_status", "signature_status",
    "binding_status", "response_complete", "transport_failure", "created_at"] },
  { table: "zzsh_order.joinpay_refund_attempt", columns: ["id", "intent_id", "operation", "created_at"] },
  { table: "zzsh_order.joinpay_refund_evidence", columns: ["id", "intent_id", "observation_id", "terminal", "refund_transaction_no", "completed_at"] },
  { table: "zzsh_order.finance_event", columns: ["id", "economic_root_id", "kind", "subject_user_id", "created_at"] },
  { table: "zzsh_order.finance_economic_root", columns: ["id", "source_kind", "source_type", "source_system", "source_entity", "source_id",
    "subject_user_id", "beneficiary_role", "source_digest", "policy_version", "basis_id"] },
  { table: "zzsh_order.settlement_ledger_entry", columns: ["id", "finance_event_id", "line_no", "account_code", "debit_cents", "credit_cents",
    "counterparty_user_id", "posting_id", "source_payment_confirmation_id", "details"] },
  { table: "zzsh_iam.audit_event", columns: ["id", "action", "object_type", "object_id", "outcome", "occurred_at", "details"] },
] as const;

const PREFLIGHT_SQL = `WITH req AS (
    SELECT e.ordinality AS n,e.value->>'table' AS tbl,
      ARRAY(SELECT jsonb_array_elements_text(e.value->'columns')) AS cols
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(value,ordinality)
  ),checked AS (
    SELECT r.n,r.tbl,to_regclass(r.tbl) IS NOT NULL AS installed,
      (SELECT count(*)=cardinality(r.cols) FROM pg_attribute a WHERE a.attrelid=to_regclass(r.tbl)
        AND a.attnum>0 AND NOT a.attisdropped AND a.attname=ANY(r.cols)
        AND has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT')) AS columns_ready,
      EXISTS(SELECT 1 FROM pg_class t JOIN pg_roles p ON p.rolname=current_user WHERE t.oid=to_regclass(r.tbl)
        AND t.relkind='r' AND t.relpersistence='p' AND NOT t.relrowsecurity
        AND NOT p.rolsuper AND NOT p.rolbypassrls) AS resource_ready
    FROM req r
  )
  SELECT current_database() AS database,current_user AS runtime_user,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of,
    COALESCE(bool_and(installed AND columns_ready AND resource_ready),false) AS ready
  FROM checked`;

const ORDER_SQL = `SELECT o.id,o.display_no,o.status,o.renter_user_id,
    p.id AS posting_id,p.currency AS posting_currency,p.renter_refund_cents::text AS refund_cents,
    to_char(p.refund_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at
  FROM zzsh_order.rental_order o
  LEFT JOIN zzsh_order.settlement_posting p ON p.order_id=o.id
  WHERE o.id=$1
  ORDER BY p.posted_at,p.id COLLATE "C" LIMIT 2`;

const INTENT_SQL = `SELECT i.id,i.posting_id,i.order_id,i.renter_user_id,i.payment_source,i.evidence_level,i.refund_order_no,
    i.amount_cents::text AS amount_cents,i.currency,i.state,i.budget_disposition,i.requires_review,
    i.basis_kind,i.payment_confirmation_id,i.liability_root_id,i.liability_event_id,i.responsibility_version_hash,i.merchant_identity_id,
    i.original_payment_trx_no,i.original_payment_order_no,
    i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,i.provider_refund_trx_no,to_char(i.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
    to_char(i.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
    (SELECT count(*)::int FROM zzsh_order.joinpay_refund_attempt x WHERE x.intent_id=i.id AND x.operation='SUBMIT') AS submit_attempts,
    (SELECT count(*)::int FROM zzsh_iam.audit_event a WHERE a.action='order.refund.abnormal.first_submit.blocked'
      AND a.object_type='channel_refund_intent' AND a.object_id=i.id AND a.outcome='FAILURE') AS blocked_count,
    (SELECT to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM zzsh_iam.audit_event a
      WHERE a.action='order.refund.abnormal.first_submit.blocked' AND a.object_type='channel_refund_intent'
        AND a.object_id=i.id AND a.outcome='FAILURE' ORDER BY a.occurred_at DESC,a.id COLLATE "C" DESC LIMIT 1) AS blocked_at,
    (SELECT a.details->>'gateReason' FROM zzsh_iam.audit_event a
      WHERE a.action='order.refund.abnormal.first_submit.blocked' AND a.object_type='channel_refund_intent'
        AND a.object_id=i.id AND a.outcome='FAILURE' ORDER BY a.occurred_at DESC,a.id COLLATE "C" DESC LIMIT 1) AS blocked_reason,
    e.terminal AS evidence_terminal,e.refund_transaction_no AS evidence_trx_no,
    to_char(e.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS evidence_completed_at,
    eo.evidence_level AS terminal_evidence_level,
    obs.observation_source AS latest_source,obs.event AS latest_event,obs.failure_reason AS latest_failure_reason,
    obs.evidence_level AS latest_evidence_level,obs.observed_at AS latest_observed_at,
    fail.observation_source AS failure_source,fail.event AS failure_event,
    fail.failure_reason AS failure_reason_code,fail.evidence_level AS failure_evidence_level,
    fail.observed_at AS failure_observed_at
  FROM zzsh_order.channel_refund_intent i
  LEFT JOIN zzsh_order.joinpay_refund_evidence e ON e.id=i.terminal_evidence_id AND e.intent_id=i.id
  LEFT JOIN zzsh_order.joinpay_refund_observation eo ON eo.id=e.observation_id AND eo.intent_id=i.id
  LEFT JOIN LATERAL (
    SELECT observation_source,event,failure_reason,evidence_level,observed_at FROM (
      SELECT 'JOINPAY'::text AS observation_source,o.event,NULL::text AS failure_reason,o.evidence_level,o.id AS observation_id,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
      FROM zzsh_order.joinpay_refund_observation o WHERE o.intent_id=i.id
      UNION ALL
      SELECT 'CONTROLLED',c.event,c.failure_reason,NULL,c.id,
        to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM zzsh_order.channel_refund_observation c WHERE c.intent_id=i.id
    ) u ORDER BY observed_at DESC,observation_source COLLATE "C" DESC,observation_id COLLATE "C" DESC LIMIT 1
  ) obs ON true
  LEFT JOIN LATERAL (
    SELECT observation_source,event,failure_reason,evidence_level,observed_at FROM (
      SELECT 'JOINPAY'::text AS observation_source,o.event,
        CASE WHEN o.transport_failure IS NOT NULL THEN 'TRANSPORT_FAILURE'
          WHEN o.schema_status<>'VALID' THEN 'SCHEMA_INVALID'
          WHEN o.signature_status<>'MATCH' THEN 'SIGNATURE_MISMATCH'
          WHEN o.binding_status<>'MATCH' THEN 'BINDING_MISMATCH'
          WHEN o.response_complete IS NOT TRUE THEN 'INCOMPLETE_RESPONSE'
          WHEN o.event='UNKNOWN' THEN 'RESULT_UNKNOWN'
          WHEN o.event='REVIEW' THEN 'REVIEW_REQUIRED'
          WHEN o.event='STALE' THEN 'STALE_OBSERVATION'
          ELSE NULL END AS failure_reason,
        o.evidence_level,o.id AS observation_id,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
      FROM zzsh_order.joinpay_refund_observation o WHERE o.intent_id=i.id
        AND (o.event IN('UNKNOWN','REVIEW','STALE') OR o.transport_failure IS NOT NULL
          OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
          OR o.response_complete IS NOT TRUE)
      UNION ALL
      SELECT 'CONTROLLED',c.event,c.failure_reason,NULL,c.id,
        to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM zzsh_order.channel_refund_observation c WHERE c.intent_id=i.id AND c.event IN('UNKNOWN','STALE')
    ) f ORDER BY observed_at DESC,observation_source COLLATE "C" DESC,observation_id COLLATE "C" DESC LIMIT 1
  ) fail ON true
  WHERE i.posting_id=$1
  ORDER BY i.created_at,i.id COLLATE "C" LIMIT ${INTENT_LIMIT + 1}`;

const ABNORMAL_INTENT_SQL = INTENT_SQL.replace("WHERE i.posting_id=$1",
  "WHERE i.order_id=$1 AND i.payment_source='JOINPAY' AND i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NULL");

const ABNORMAL_RESPONSIBILITY_SQL = `SELECT c.id AS confirmation_id,c.order_id,c.reason_code,c.amount_cents::text AS original_cents,
    c.currency,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.joinpay_request_id,c.joinpay_evidence_id,c.joinpay_anchor_id,
    o.renter_user_id,
    rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
    rq.channel_order_no AS request_order_no,rq.amount_cents::text AS request_amount_cents,rq.currency AS request_currency,
    b.wire_merchant_no,b.formal_admission_ref,
    a.channel AS anchor_channel,a.evidence_level AS anchor_evidence_level,a.native_order_id AS anchor_order,a.request_id AS anchor_request,
    a.merchant_identity_id AS anchor_merchant,a.channel_trx_no AS anchor_trx,
    lr.id AS liability_root_id,lr.source_kind AS liability_root_kind,lr.source_type AS liability_root_type,
    lr.source_system AS liability_root_system,lr.source_entity AS liability_root_entity,lr.source_id AS liability_root_source_id,
    lr.subject_user_id AS liability_root_subject,lr.beneficiary_role AS liability_root_role,lr.source_digest AS liability_root_digest,
    lr.policy_version AS liability_root_policy,lr.basis_id AS liability_root_basis,
    le.id AS liability_event_id,le.kind AS liability_event_kind,le.economic_root_id AS liability_event_root,
    le.subject_user_id AS liability_event_subject,
    (SELECT count(*)::int FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=c.id
      AND x.payment_source='JOINPAY' AND x.basis_kind='REVIEW_CONFIRMATION') AS intent_count,
    (SELECT count(*)::int FROM zzsh_order.channel_refund_intent x JOIN zzsh_order.joinpay_refund_attempt y ON y.intent_id=x.id
      WHERE x.payment_confirmation_id=c.id AND x.payment_source='JOINPAY' AND x.basis_kind='REVIEW_CONFIRMATION'
        AND y.operation='SUBMIT') AS submit_attempts,
    (SELECT count(*)::int FROM zzsh_iam.audit_event a2 WHERE a2.action='order.refund.abnormal.first_submit.blocked'
      AND a2.object_type='channel_refund_intent' AND a2.outcome='FAILURE'
      AND a2.object_id IN (SELECT x.id FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=c.id
        AND x.payment_source='JOINPAY' AND x.basis_kind='REVIEW_CONFIRMATION')) AS blocked_count,
    (SELECT to_char(a2.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM zzsh_iam.audit_event a2
      WHERE a2.action='order.refund.abnormal.first_submit.blocked' AND a2.object_type='channel_refund_intent' AND a2.outcome='FAILURE'
        AND a2.object_id IN (SELECT x.id FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=c.id
          AND x.payment_source='JOINPAY' AND x.basis_kind='REVIEW_CONFIRMATION')
      ORDER BY a2.occurred_at DESC,a2.id COLLATE "C" DESC LIMIT 1) AS blocked_at,
    (SELECT a2.details->>'gateReason' FROM zzsh_iam.audit_event a2
      WHERE a2.action='order.refund.abnormal.first_submit.blocked' AND a2.object_type='channel_refund_intent' AND a2.outcome='FAILURE'
        AND a2.object_id IN (SELECT x.id FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=c.id
          AND x.payment_source='JOINPAY' AND x.basis_kind='REVIEW_CONFIRMATION')
      ORDER BY a2.occurred_at DESC,a2.id COLLATE "C" DESC LIMIT 1) AS blocked_reason
  FROM zzsh_order.payment_confirmation c
  JOIN zzsh_order.rental_order o ON o.id=c.order_id
  LEFT JOIN zzsh_order.payment_request rq ON rq.id=c.joinpay_request_id AND rq.order_id=c.order_id
  LEFT JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=rq.id
  LEFT JOIN zzsh_order.payment_channel_transaction a ON a.id=c.joinpay_anchor_id
  LEFT JOIN LATERAL (SELECT * FROM zzsh_order.finance_economic_root r
    WHERE r.source_kind='NATIVE_ABNORMAL_REFUND' AND r.source_id=c.id ORDER BY r.id COLLATE "C" LIMIT 1) lr ON true
  LEFT JOIN zzsh_order.finance_event le ON le.economic_root_id=lr.id AND le.kind='REFUND_LIABILITY_RECOGNIZED'
  WHERE c.order_id=$1 AND c.source='JOINPAY' AND c.disposition='REVIEW_REQUIRED'
    AND c.reason_code IN('DUPLICATE_PAYMENT','LATE_PAYMENT') AND c.currency='CNY'
  ORDER BY c.id COLLATE "C" LIMIT ${INTENT_LIMIT + 1}`;

const LIABILITY_SQL = `SELECT e.id AS event_id,e.kind AS event_kind,e.subject_user_id AS event_subject,
    r.id AS root_id,r.source_kind AS root_kind,r.source_type AS root_type,r.source_system AS root_system,
    r.source_entity AS root_entity,r.source_id AS root_source_id,r.subject_user_id AS root_subject,
    r.beneficiary_role AS root_role,r.source_digest AS root_digest,r.policy_version AS root_policy,r.basis_id AS root_basis,
    COALESCE(sum(l.debit_cents) FILTER(WHERE l.line_no=1 AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT'),0)::text AS line1_debit,
    COALESCE(sum(l.credit_cents) FILTER(WHERE l.line_no=1 AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT'),0)::text AS line1_credit,
    count(*) FILTER(WHERE l.line_no=1 AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.counterparty_user_id IS NULL
      AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
      AND l.details->>'abnormalRefundLiabilityId'=r.source_id AND l.details->>'paymentConfirmationId'=r.source_id)::text AS line1_good,
    COALESCE(sum(l.debit_cents) FILTER(WHERE l.line_no=2 AND l.account_code='RENTER_REFUND_PAYABLE'),0)::text AS line2_debit,
    COALESCE(sum(l.credit_cents) FILTER(WHERE l.line_no=2 AND l.account_code='RENTER_REFUND_PAYABLE'),0)::text AS line2_credit,
    count(*) FILTER(WHERE l.line_no=2 AND l.account_code='RENTER_REFUND_PAYABLE' AND l.counterparty_user_id=r.subject_user_id
      AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
      AND l.details->>'abnormalRefundLiabilityId'=r.source_id AND l.details->>'paymentConfirmationId'=r.source_id)::text AS line2_good,
    count(*)::text AS total_lines
  FROM zzsh_order.finance_event e
  JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.finance_event_id=e.id
  WHERE e.id=ANY($1::text[]) AND e.kind='REFUND_LIABILITY_RECOGNIZED'
  GROUP BY e.id,r.id`;

const LEDGER_SQL = `SELECT e.id AS event_id,e.subject_user_id,e.economic_root_id,
    r.id AS root_id,r.source_kind AS root_source_kind,r.source_id AS root_source_id,r.subject_user_id AS root_subject_user_id,
    to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at,
    COALESCE(sum(l.debit_cents) FILTER(WHERE l.account_code='RENTER_REFUND_PAYABLE'),0)::text AS payable_debit,
    COALESCE(sum(l.credit_cents) FILTER(WHERE l.account_code='RENTER_REFUND_PAYABLE'),0)::text AS payable_credit,
    count(*) FILTER(WHERE l.account_code='RENTER_REFUND_PAYABLE')::text AS payable_lines,
    count(*) FILTER(WHERE l.account_code='RENTER_REFUND_PAYABLE' AND l.counterparty_user_id=$2)::text AS payable_subject_lines,
    COALESCE(sum(l.debit_cents) FILTER(WHERE l.account_code='PAYOUT_CLEARING'),0)::text AS clearing_debit,
    COALESCE(sum(l.credit_cents) FILTER(WHERE l.account_code='PAYOUT_CLEARING'),0)::text AS clearing_credit,
    count(*) FILTER(WHERE l.account_code='PAYOUT_CLEARING')::text AS clearing_lines,
    COALESCE(sum(l.debit_cents) FILTER(WHERE l.account_code='JOINPAY_UNALLOCATED_RECEIPT'),0)::text AS unallocated_debit,
    COALESCE(sum(l.credit_cents) FILTER(WHERE l.account_code='JOINPAY_UNALLOCATED_RECEIPT'),0)::text AS unallocated_credit,
    count(*) FILTER(WHERE l.account_code='JOINPAY_UNALLOCATED_RECEIPT')::text AS unallocated_lines,
    count(*)::text AS total_lines
  FROM zzsh_order.finance_event e
  JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.finance_event_id=e.id
  WHERE e.id=ANY($1::text[]) AND e.kind='REFUND_PAID'
  GROUP BY e.id,r.id`;

const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const plainText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f\ufffd]/.test(value) ? value : null;
const known = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : null;
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
function ageSeconds(asOf: string, observedAt: string | null): number | null {
  if (!observedAt) return null;
  const end = Date.parse(asOf), start = Date.parse(observedAt);
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, Math.floor((end - start) / 1000)) : null;
}
function unique(values: Iterable<string>): string[] { return [...new Set(values)]; }

async function preflight(client: PoolClient): Promise<{ asOf: string }> {
  const row = (await client.query<Row>(PREFLIGHT_SQL, [JSON.stringify(REQUIRED)])).rows[0];
  if (!row || row.ready !== true || typeof row.database !== "string" || typeof row.runtime_user !== "string" || !timestamp(row.as_of)) {
    throw unavailable("Personal refund read schema is unavailable");
  }
  return { asOf: row.as_of as string };
}

function observationOf(row: Row, sourceKey: string, eventKey: string, reasonKey: string, levelKey: string,
  observedKey: string, asOf: string, reasons: Set<string>): PersonalRefundObservation | null {
  const rawAt = row[observedKey];
  if (rawAt === null || rawAt === undefined) return null;
  const source = row[sourceKey], event = row[eventKey];
  if ((source !== "JOINPAY" && source !== "CONTROLLED") || typeof event !== "string" || !EVENT.test(event) || !timestamp(rawAt)) {
    reasons.add("REFUND_OBSERVATION_UNREADABLE");
    return null;
  }
  const rawLevel = row[levelKey];
  const level = source === "CONTROLLED" ? null : known(rawLevel, EVIDENCE_LEVELS);
  if (source === "JOINPAY" && level === null) reasons.add("REFUND_OBSERVATION_EVIDENCE_LEVEL_UNKNOWN");
  const failureReason = typeof row[reasonKey] === "string" && EVENT.test(row[reasonKey] as string)
    ? row[reasonKey] as string : null;
  return { source, event, failureReason, evidenceLevel: level, observedAt: rawAt,
    ageSeconds: ageSeconds(asOf, rawAt), trust: "LOCAL_OBSERVATION_NOT_REVALIDATED" };
}

type IntentDraft = {
  intent: Omit<PersonalRefundIntent, "localAccounting" | "channelFacts" | "reasonCodes">;
  disposition: PersonalRefundBudgetDisposition;
  amountCents: string | null;
  terminalEventId: string | null;
  terminalRootId: string | null;
  completedAt: string | null;
  liabilityRootId: string | null;
  liabilityEventId: string | null;
  merchantIdentityId: string | null;
  originalPaymentTrxNo: string | null;
  originalPaymentOrderNo: string | null;
  reasons: string[];
  writeOff: PersonalRefundIntent["localAccounting"]["writeOff"];
  release: PersonalRefundIntent["localAccounting"]["release"];
};

const FIRST_SUBMIT_REASONS = ["ORIGINAL_ORDER_NO_AMBIGUOUS", "ABNORMAL_BASIS_REVIEW"] as const;
function firstSubmitOf(raw: Row, state: PersonalRefundIntentState, reasons: Set<string>, conflict: (reason: string) => void): PersonalFirstSubmit | null {
  const attempts = raw.submit_attempts, blockedCount = raw.blocked_count;
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(blockedCount)) {
    conflict("FIRST_SUBMIT_FACTS_UNREADABLE"); reasons.add("FIRST_SUBMIT_FACTS_UNREADABLE"); return null;
  }
  const attemptsCount = attempts as number, blockedAuditCount = blockedCount as number;
  const blockedAt = timestamp(raw.blocked_at) ? raw.blocked_at : null;
  const blockedReason = known(raw.blocked_reason, FIRST_SUBMIT_REASONS);
  if (raw.blocked_at !== null && raw.blocked_at !== undefined && !blockedAt) {
    conflict("FIRST_SUBMIT_BLOCK_TIME_UNREADABLE"); reasons.add("FIRST_SUBMIT_BLOCK_TIME_UNREADABLE");
  }
  if (blockedAuditCount > 0 && blockedAt === null) {
    conflict("FIRST_SUBMIT_BLOCK_TIME_MISSING"); reasons.add("FIRST_SUBMIT_BLOCK_TIME_MISSING");
  }
  if (blockedAt !== null && blockedReason === null) {
    conflict("FIRST_SUBMIT_BLOCK_REASON_UNKNOWN"); reasons.add("FIRST_SUBMIT_BLOCK_REASON_UNKNOWN");
  }
  if (attemptsCount > 0) return { dispatch: "DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  if (blockedAt !== null) return { dispatch: "NEVER_DISPATCHED", blockedReason, blockedAt,
    blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  if (state === "READY") return { dispatch: "NEVER_DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  conflict("SUBMIT_ATTEMPT_MISSING"); reasons.add("SUBMIT_ATTEMPT_MISSING");
  return { dispatch: "UNKNOWN", blockedReason: null, blockedAt: null, blockedAuditCount: blockedCount as number,
    trust: "LOCAL_AUDIT_AND_ATTEMPT" };
}

function parseIntentRow(raw: Row, ctx: { actorId: string; orderId: string; basis: PersonalRefundBasis;
  expectedPostingId: string | null; responsibilityCents: string | null; responsibilityDigest?: string | null; asOf: string;
  conflict: (reason: string) => void; onForeign: () => void }): IntentDraft | null {
  const { conflict, basis, expectedPostingId, responsibilityCents } = ctx;
  const reasons = new Set<string>();
  const intentId = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  if (!intentId) { conflict("INTENT_ID_UNREADABLE"); return null; }
  if (raw.renter_user_id !== ctx.actorId) { conflict("INTENT_RENTER_MISMATCH"); ctx.onForeign(); return null; }
  if (raw.order_id !== ctx.orderId) conflict("INTENT_ORDER_MISMATCH");
  if (raw.basis_kind !== basis) { conflict("INTENT_BASIS_MISMATCH"); reasons.add("INTENT_BASIS_MISMATCH"); }
  const paymentConfirmationId = typeof raw.payment_confirmation_id === "string" && ID.test(raw.payment_confirmation_id)
    ? raw.payment_confirmation_id : null;
  if (!paymentConfirmationId) { conflict("INTENT_CONFIRMATION_UNREADABLE"); reasons.add("INTENT_CONFIRMATION_UNREADABLE"); }
  if (basis === "POSTING") {
    if (raw.posting_id !== expectedPostingId) conflict("INTENT_POSTING_MISMATCH");
  } else {
    if (raw.posting_id !== null && raw.posting_id !== undefined) { conflict("ABNORMAL_INTENT_POSTING_PRESENT"); reasons.add("ABNORMAL_INTENT_POSTING_PRESENT"); }
    if (!raw.liability_root_id || !raw.liability_event_id) { conflict("ABNORMAL_LIABILITY_MISSING"); reasons.add("ABNORMAL_LIABILITY_MISSING"); }
  }

  const paymentSource = raw.payment_source, evidenceLevel = plainText(raw.evidence_level, 64);
  let source: PersonalRefundSource = "UNRECOGNIZED";
  if (paymentSource === "CONTROLLED" && evidenceLevel === "CONTROLLED_TEST") source = "LOCAL_CONTROLLED";
  else if (paymentSource === "JOINPAY" && evidenceLevel === "JOINPAY_FORMAL") source = "JOINPAY_FORMAL";
  else { conflict("UNRECOGNIZED_REFUND_SOURCE"); reasons.add("UNRECOGNIZED_REFUND_SOURCE"); }

  const currency = raw.currency, rawAmount = raw.amount_cents;
  const amountCents = typeof rawAmount === "string" && POSITIVE_CENTS.test(rawAmount) ? rawAmount : null;
  if (currency !== "CNY") { conflict("INTENT_CURRENCY_NOT_CNY"); reasons.add("INTENT_CURRENCY_NOT_CNY"); }
  if (amountCents === null) { conflict("INTENT_AMOUNT_INVALID"); reasons.add("INTENT_AMOUNT_INVALID"); }
  if (basis === "REVIEW_CONFIRMATION" && responsibilityCents !== null && amountCents !== responsibilityCents) {
    conflict("ABNORMAL_INTENT_AMOUNT_MISMATCH"); reasons.add("ABNORMAL_INTENT_AMOUNT_MISMATCH");
  }
  if (basis === "REVIEW_CONFIRMATION" && ctx.responsibilityDigest !== undefined && ctx.responsibilityDigest !== null
    && raw.responsibility_version_hash !== ctx.responsibilityDigest) {
    conflict("ABNORMAL_INTENT_DIGEST_MISMATCH"); reasons.add("ABNORMAL_INTENT_DIGEST_MISMATCH");
  }
  const amount = amountCents !== null && currency === "CNY" ? { cents: amountCents, currency: "CNY" as const } : null;

  const state = known(raw.state, INTENT_STATES) ?? "UNRECOGNIZED";
  if (state === "UNRECOGNIZED") { conflict("UNRECOGNIZED_INTENT_STATE"); reasons.add("UNRECOGNIZED_INTENT_STATE"); }
  const disposition = known(raw.budget_disposition, DISPOSITIONS) ?? "UNRECOGNIZED";
  if (disposition === "UNRECOGNIZED") { conflict("UNRECOGNIZED_BUDGET_DISPOSITION"); reasons.add("UNRECOGNIZED_BUDGET_DISPOSITION"); }
  if (typeof raw.requires_review !== "boolean") { conflict("INTENT_REVIEW_FLAG_UNREADABLE"); reasons.add("INTENT_REVIEW_FLAG_UNREADABLE"); }
  const requiresReview = raw.requires_review === true;

  const refundOrderNo = typeof raw.refund_order_no === "string" && REFUND_NO.test(raw.refund_order_no) ? raw.refund_order_no : null;
  if (!refundOrderNo) { conflict("REFUND_ORDER_NO_UNREADABLE"); reasons.add("REFUND_ORDER_NO_UNREADABLE"); }
  const intentDueAt = timestamp(raw.due_at) ? raw.due_at : null;
  const createdAt = timestamp(raw.created_at) ? raw.created_at : null;
  const updatedAt = timestamp(raw.updated_at) ? raw.updated_at : null;
  if (!intentDueAt || !createdAt || !updatedAt) { conflict("INTENT_TIMESTAMP_UNREADABLE"); reasons.add("INTENT_TIMESTAMP_UNREADABLE"); }
  const completedAt = timestamp(raw.completed_at) ? raw.completed_at : null;
  if (raw.completed_at !== null && raw.completed_at !== undefined && !completedAt) {
    conflict("INTENT_TERMINAL_TIME_UNREADABLE"); reasons.add("INTENT_TERMINAL_TIME_UNREADABLE");
  }
  const firstSubmit = basis === "REVIEW_CONFIRMATION" ? firstSubmitOf(raw, state, reasons, conflict) : null;

  const latestObservation = observationOf(raw, "latest_source", "latest_event", "latest_failure_reason",
    "latest_evidence_level", "latest_observed_at", ctx.asOf, reasons);
  const latestFailure = observationOf(raw, "failure_source", "failure_event", "failure_reason_code",
    "failure_evidence_level", "failure_observed_at", ctx.asOf, reasons);
  for (const reason of reasons) if (reason.startsWith("REFUND_OBSERVATION_")) conflict(reason);
  for (const observation of [latestObservation, latestFailure]) {
    if (observation && (source === "LOCAL_CONTROLLED" && observation.source !== "CONTROLLED"
      || source === "JOINPAY_FORMAL" && observation.source !== "JOINPAY")) {
      conflict("REFUND_OBSERVATION_SOURCE_MISMATCH"); reasons.add("REFUND_OBSERVATION_SOURCE_MISMATCH");
    }
  }

  const terminalEvidenceId = raw.terminal_evidence_id;
  const evidenceTerminal = raw.evidence_terminal;
  const evidenceTrxNo = plainText(raw.evidence_trx_no, 128);
  const evidenceCompletedAt = timestamp(raw.evidence_completed_at) ? raw.evidence_completed_at : null;
  const terminalLevel = known(raw.terminal_evidence_level, EVIDENCE_LEVELS);
  const intentTrxNo = plainText(raw.provider_refund_trx_no, 128);

  let savedChannelEvidence: PersonalRefundIntent["savedChannelEvidence"] = null;
  const terminalState = state === "SUCCEEDED" || state === "FAILED";
  if (terminalState) {
    if (state === "SUCCEEDED" && disposition !== "CONSUMED") { conflict("SUCCEEDED_WITHOUT_CONSUMED_BUDGET"); reasons.add("SUCCEEDED_WITHOUT_CONSUMED_BUDGET"); }
    if (state === "FAILED" && disposition !== "RELEASED") { conflict("FAILED_WITHOUT_RELEASED_BUDGET"); reasons.add("FAILED_WITHOUT_RELEASED_BUDGET"); }
    if (terminalEvidenceId === null || terminalEvidenceId === undefined) {
      conflict("TERMINAL_EVIDENCE_MISSING"); reasons.add("TERMINAL_EVIDENCE_MISSING");
    } else if (source !== "JOINPAY_FORMAL") {
      conflict("TERMINAL_EVIDENCE_OUTSIDE_JOINPAY"); reasons.add("TERMINAL_EVIDENCE_OUTSIDE_JOINPAY");
    } else if (state === "SUCCEEDED" && evidenceTerminal !== "SUCCEEDED"
      || state === "FAILED" && evidenceTerminal !== "FAILED_NO_EXECUTION") {
      conflict("TERMINAL_EVIDENCE_MISMATCH"); reasons.add("TERMINAL_EVIDENCE_MISMATCH");
    } else {
      if (terminalLevel === null) { conflict("TERMINAL_EVIDENCE_LEVEL_UNKNOWN"); reasons.add("TERMINAL_EVIDENCE_LEVEL_UNKNOWN"); }
      if (state === "SUCCEEDED" && (!evidenceTrxNo || !evidenceCompletedAt)) {
        conflict("TERMINAL_EVIDENCE_INCOMPLETE"); reasons.add("TERMINAL_EVIDENCE_INCOMPLETE");
      }
      if ((intentTrxNo ?? null) !== (evidenceTrxNo ?? null) || (completedAt ?? null) !== (evidenceCompletedAt ?? null)) {
        conflict("TERMINAL_EVIDENCE_MISMATCH"); reasons.add("TERMINAL_EVIDENCE_MISMATCH");
      }
      savedChannelEvidence = { terminal: evidenceTerminal as "SUCCEEDED" | "FAILED_NO_EXECUTION",
        evidenceLevel: terminalLevel, providerRefundTrxNo: evidenceTrxNo, completedAt: evidenceCompletedAt,
        trust: "SAVED_EVIDENCE_NOT_REVALIDATED" };
    }
  } else {
    if ((terminalEvidenceId !== null && terminalEvidenceId !== undefined) || (raw.provider_refund_trx_no !== null
      && raw.provider_refund_trx_no !== undefined) || (raw.completed_at !== null && raw.completed_at !== undefined)) {
      conflict("NON_TERMINAL_WITH_TERMINAL_FIELDS"); reasons.add("NON_TERMINAL_WITH_TERMINAL_FIELDS");
    }
    if (disposition === "CONSUMED" || disposition === "RELEASED") {
      conflict("BUDGET_TERMINAL_WITHOUT_TERMINAL_STATE"); reasons.add("BUDGET_TERMINAL_WITHOUT_TERMINAL_STATE");
    }
  }
  if (source === "LOCAL_CONTROLLED" && (requiresReview || terminalEvidenceId !== null && terminalEvidenceId !== undefined)) {
    conflict("CONTROLLED_INTENT_SHAPE_CONFLICT"); reasons.add("CONTROLLED_INTENT_SHAPE_CONFLICT");
  }

  let release: PersonalRefundIntent["localAccounting"]["release"] = null;
  let terminalEventId: string | null = null;
  let terminalRootId: string | null = null;
  if (disposition === "RELEASED" && state === "FAILED") {
    release = { intentUpdatedAt: updatedAt, ledgerEventId: null, trust: "LOCAL_INTENT_ONLY" };
    if (raw.terminal_event_id !== null && raw.terminal_event_id !== undefined) {
      conflict("RELEASED_WITH_LEDGER_EVENT"); reasons.add("RELEASED_WITH_LEDGER_EVENT");
    }
  }
  if (disposition === "CONSUMED" && state === "SUCCEEDED") {
    terminalEventId = typeof raw.terminal_event_id === "string" && ID.test(raw.terminal_event_id) ? raw.terminal_event_id : null;
    terminalRootId = typeof raw.terminal_root_id === "string" && ID.test(raw.terminal_root_id) ? raw.terminal_root_id : null;
    if (!terminalEventId) { conflict("LOCAL_WRITE_OFF_EVENT_MISSING"); reasons.add("LOCAL_WRITE_OFF_EVENT_MISSING"); }
    if (!terminalRootId) { conflict("LOCAL_WRITE_OFF_ROOT_MISSING"); reasons.add("LOCAL_WRITE_OFF_ROOT_MISSING"); }
  }
  return { intent: { intentId, refundOrderNo, source, evidenceLevel, basisKind: basis, paymentConfirmationId, amount, state,
    budgetDisposition: disposition, requiresReview, dueAt: intentDueAt, createdAt, updatedAt, latestObservation, latestFailure,
    firstSubmit, savedChannelEvidence }, disposition, amountCents, terminalEventId, terminalRootId, completedAt,
    liabilityRootId: typeof raw.liability_root_id === "string" ? raw.liability_root_id : null,
    liabilityEventId: typeof raw.liability_event_id === "string" ? raw.liability_event_id : null,
    merchantIdentityId: typeof raw.merchant_identity_id === "string" ? raw.merchant_identity_id : null,
    originalPaymentTrxNo: typeof raw.original_payment_trx_no === "string" ? raw.original_payment_trx_no : null,
    originalPaymentOrderNo: typeof raw.original_payment_order_no === "string" ? raw.original_payment_order_no : null,
    reasons: [...reasons], writeOff: null, release };
}

function emptyProjection(order: PersonalRefundReadProjection["order"], asOf: string, status: "AVAILABLE" | "NOT_APPLICABLE",
  outcome: PersonalRefundOutcome, reasonCodes: readonly string[]): PersonalRefundReadProjection {
  return { contractVersion: PERSONAL_REFUND_READ_VERSION, subjectId: "", order, status, outcome,
    coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: INTENT_LIMIT, intentsComplete: true, channelRecordsChecked: false }, asOf,
    responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null,
      releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
    abnormalResponsibilities: [], responsibilitiesTruncated: false,
    responsibilityTotals: { originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null,
      remainingCents: null, totalsComplete: false, postingOriginalCents: null, abnormalOriginalCents: null, abnormalConfirmationCount: 0 },
    intents: [], returnedIntentCount: 0, intentsTruncated: false,
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED", "NO_TRUSTED_CHANNEL_TERMINAL"] },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
    reasonCodes: unique([...reasonCodes, "LOCAL_RECORDS_ONLY"]),
    unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"] };
}


type AbnormalRead = {
  responsibilities: PersonalAbnormalResponsibility[];
  intents: IntentDraft[];
  conflictReasons: Set<string>;
  reasons: string[];
  truncated: boolean;
  foreign: number;
};

function abnormalFirstSubmit(raw: Row, intentDrafts: IntentDraft[], reasons: Set<string>,
  conflict: (reason: string) => void): PersonalFirstSubmit | null {
  if (intentDrafts.length === 0) return null;
  const latest = [...intentDrafts].sort((a, b) =>
    (a.intent.createdAt ?? "").localeCompare(b.intent.createdAt ?? "") || a.intent.intentId.localeCompare(b.intent.intentId)).at(-1)!;
  if (latest.intent.firstSubmit) return latest.intent.firstSubmit;
  const attempts = raw.submit_attempts, blockedCount = raw.blocked_count;
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(blockedCount)) {
    conflict("FIRST_SUBMIT_FACTS_UNREADABLE"); reasons.add("FIRST_SUBMIT_FACTS_UNREADABLE"); return null;
  }
  const attemptsCount = attempts as number, blockedAuditCount = blockedCount as number;
  const blockedAt = timestamp(raw.blocked_at) ? raw.blocked_at : null;
  if (attemptsCount > 0) return { dispatch: "DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  if (blockedAt) return { dispatch: "NEVER_DISPATCHED", blockedReason: known(raw.blocked_reason, FIRST_SUBMIT_REASONS),
    blockedAt, blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  return { dispatch: "NEVER_DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
}

function liabilityValid(row: Row | undefined, responsibility: PersonalAbnormalResponsibility,
  actorId: string, digest: string | null, reasons: Set<string>, conflict: (reason: string) => void): boolean {
  if (!row) { conflict("ABNORMAL_LIABILITY_MISSING"); reasons.add("ABNORMAL_LIABILITY_MISSING"); return false; }
  const amount = responsibility.originalCents;
  const good = responsibility.liabilityRootId !== null && responsibility.liabilityEventId !== null && amount !== null
    && row.root_id === responsibility.liabilityRootId && row.event_id === responsibility.liabilityEventId
    && row.root_kind === "NATIVE_ABNORMAL_REFUND" && row.root_type === "NATIVE" && row.root_system === "zzsh"
    && row.root_entity === "joinpay_abnormal_refund_liability" && row.root_source_id === responsibility.confirmationId
    && row.root_subject === actorId && row.root_role === "RENTER" && row.root_policy === null && row.root_basis === null
    && (digest === null || row.root_digest === digest)
    && row.event_kind === "REFUND_LIABILITY_RECOGNIZED" && row.event_root === responsibility.liabilityRootId
    && row.event_subject === actorId
    && row.total_lines === "2" && row.line1_good === "1" && row.line2_good === "1"
    && row.line1_debit === amount && row.line1_credit === "0" && row.line2_debit === "0" && row.line2_credit === amount;
  if (!good) { conflict("ABNORMAL_LIABILITY_MISMATCH"); reasons.add("ABNORMAL_LIABILITY_MISMATCH"); }
  return good;
}

async function readAbnormalSection(client: PoolClient, actorId: string, orderId: string, asOf: string): Promise<AbnormalRead> {
  const conflictReasons = new Set<string>(), reasons: string[] = [];
  const conflict = (reason: string) => { if (!conflictReasons.has(reason)) { conflictReasons.add(reason); reasons.push(reason); } };
  const rows = (await client.query<Row>(ABNORMAL_RESPONSIBILITY_SQL, [orderId])).rows;
  const truncated = rows.length > INTENT_LIMIT;
  if (truncated) reasons.push("ABNORMAL_RESPONSIBILITY_LIST_TRUNCATED");
  const confirmationRows = rows.slice(0, INTENT_LIMIT);
  const responsibilityByConfirmation = new Map<string, { raw: Row; reasons: Set<string> }>();
  for (const raw of confirmationRows) {
    const confirmationId = typeof raw.confirmation_id === "string" && ID.test(raw.confirmation_id) ? raw.confirmation_id : null;
    if (!confirmationId) { conflict("ABNORMAL_CONFIRMATION_UNREADABLE"); continue; }
    const local = new Set<string>();
    const fail = (reason: string) => { local.add(reason); conflict(reason); };
    if (raw.order_id !== orderId || raw.renter_user_id !== actorId) fail("ABNORMAL_CONFIRMATION_SUBJECT_MISMATCH");
    if (!["DUPLICATE_PAYMENT", "LATE_PAYMENT"].includes(raw.reason_code as string)) fail("ABNORMAL_CONFIRMATION_REASON_UNKNOWN");
    if (raw.currency !== "CNY") fail("ABNORMAL_CONFIRMATION_CURRENCY_NOT_CNY");
    if (raw.request_channel !== "JOINPAY" || raw.request_evidence_level !== "JOINPAY_CANDIDATE"
      || raw.request_merchant !== raw.merchant_scope_id || raw.request_order_no !== raw.merchant_order_no
      || raw.request_amount_cents !== raw.original_cents || raw.request_currency !== "CNY"
      || typeof raw.formal_admission_ref !== "string" || raw.formal_admission_ref.length < 1) fail("ABNORMAL_ORIGINAL_REQUEST_MISMATCH");
    if (raw.anchor_channel !== "JOINPAY" || raw.anchor_order !== orderId || raw.anchor_request !== raw.joinpay_request_id
      || raw.anchor_merchant !== raw.merchant_scope_id || raw.anchor_trx !== raw.provider_transaction_id
      || raw.anchor_evidence_level !== "JOINPAY_VERIFIED") fail("ABNORMAL_ANCHOR_MISMATCH");
    const amount = typeof raw.original_cents === "string" && POSITIVE_CENTS.test(raw.original_cents) ? raw.original_cents : null;
    if (amount === null) fail("ABNORMAL_AMOUNT_INVALID");
    responsibilityByConfirmation.set(confirmationId, { raw, reasons: local });
  }
  const intentRows = (await client.query<Row>(ABNORMAL_INTENT_SQL, [orderId])).rows;
  if (rows.length === 0 && intentRows.length === 0) return { responsibilities: [], intents: [], conflictReasons, reasons, truncated: false, foreign: 0 };
  const intentTruncated = intentRows.length > INTENT_LIMIT;
  if (intentTruncated) reasons.push("INTENT_LIST_TRUNCATED");
  const intents: IntentDraft[] = [];
  const unmatched = new Map<string, IntentDraft[]>();
  let foreign = 0;
  for (const raw of intentRows.slice(0, INTENT_LIMIT)) {
    const confirmationId = typeof raw.payment_confirmation_id === "string" ? raw.payment_confirmation_id : "";
    const target = responsibilityByConfirmation.get(confirmationId);
    if (!target) {
      conflict("ABNORMAL_INTENT_CONFIRMATION_UNMATCHED");
      const draft = parseIntentRow(raw, { actorId, orderId, basis: "REVIEW_CONFIRMATION", expectedPostingId: null,
        responsibilityCents: null, responsibilityDigest: null, asOf, conflict, onForeign: () => { foreign += 1; } });
      if (draft) unmatched.set(confirmationId || "unmatched_intent", [...(unmatched.get(confirmationId || "unmatched_intent") ?? []), draft]);
      continue;
    }
    const responsibilityAmount = typeof target.raw.original_cents === "string" ? target.raw.original_cents : null;
    const responsibilityDigest = typeof target.raw.liability_root_digest === "string" ? target.raw.liability_root_digest : null;
    const draft = parseIntentRow(raw, { actorId, orderId, basis: "REVIEW_CONFIRMATION", expectedPostingId: null,
      responsibilityCents: responsibilityAmount, responsibilityDigest, asOf, conflict, onForeign: () => { foreign += 1; } });
    if (draft) intents.push(draft);
  }
  await applyWriteOffs(client, intents, actorId, conflict);
  const byConfirmation = new Map<string, IntentDraft[]>();
  for (const draft of intents) {
    const id = draft.intent.paymentConfirmationId;
    if (!id) continue;
    byConfirmation.set(id, [...(byConfirmation.get(id) ?? []), draft]);
  }
  const liabilityIds = unique([...responsibilityByConfirmation.values()].flatMap(value =>
    typeof value.raw.liability_event_id === "string" ? [value.raw.liability_event_id] : []));
  const liabilityRows = liabilityIds.length ? (await client.query<Row>(LIABILITY_SQL, [liabilityIds])).rows : [];
  const liability = new Map(liabilityRows.map(row => [row.event_id, row]));
  const responsibilities: PersonalAbnormalResponsibility[] = [];
  for (const [confirmationId, value] of responsibilityByConfirmation) {
    const raw = value.raw;
    const localDrafts = byConfirmation.get(confirmationId) ?? [];
    for (const draft of localDrafts) {
      if (draft.liabilityRootId !== (typeof raw.liability_root_id === "string" ? raw.liability_root_id : null)
        || draft.liabilityEventId !== (typeof raw.liability_event_id === "string" ? raw.liability_event_id : null)
        || draft.merchantIdentityId !== (typeof raw.merchant_scope_id === "string" ? raw.merchant_scope_id : null)
        || draft.originalPaymentTrxNo !== (typeof raw.provider_transaction_id === "string" ? raw.provider_transaction_id : null)
        || draft.originalPaymentOrderNo !== (typeof raw.merchant_order_no === "string" ? raw.merchant_order_no : null)) {
        value.reasons.add("ABNORMAL_INTENT_BINDING_MISMATCH"); conflict("ABNORMAL_INTENT_BINDING_MISMATCH");
      }
      for (const reason of draft.reasons) { value.reasons.add(reason); conflict(reason); }
    }
    const amount = typeof raw.original_cents === "string" && POSITIVE_CENTS.test(raw.original_cents) ? raw.original_cents : null;
    const digest = typeof raw.liability_root_digest === "string" ? raw.liability_root_digest : null;
    const rootId = typeof raw.liability_root_id === "string" && ID.test(raw.liability_root_id) ? raw.liability_root_id : null;
    const eventId = typeof raw.liability_event_id === "string" && ID.test(raw.liability_event_id) ? raw.liability_event_id : null;
    if (Number(raw.intent_count) > localDrafts.length) { value.reasons.add("ABNORMAL_INTENT_UNREADABLE"); conflict("ABNORMAL_INTENT_UNREADABLE"); }
    if (localDrafts.length === 0 && Number(raw.intent_count) === 0 && rootId === null && eventId === null) continue;
    const shouldHaveLiability = localDrafts.length > 0 || Number(raw.intent_count) > 0 || rootId !== null || eventId !== null;
    if (shouldHaveLiability) liabilityValid(eventId ? liability.get(eventId) : undefined,
      { confirmationId, reasonCode: "UNKNOWN_REASON", originalCents: amount, currency: raw.currency === "CNY" ? "CNY" : null,
        liabilityRootId: rootId, liabilityEventId: eventId, intentIds: [], allocatedCents: null, consumedCents: null,
        releasedCents: null, remainingCents: null, totalsComplete: false, state: "CONFLICT", firstSubmit: null, reasonCodes: [] },
      actorId, digest, value.reasons, (reason) => { value.reasons.add(reason); conflict(reason); });
    const active = localDrafts.filter(d => d.disposition !== "RELEASED");
    if (active.length > 1) { value.reasons.add("ABNORMAL_MULTIPLE_ACTIVE_INTENTS"); conflict("ABNORMAL_MULTIPLE_ACTIVE_INTENTS"); }
    let allocated: bigint | null = amount === null ? null : 0n, consumed: bigint | null = amount === null ? null : 0n,
      released: bigint | null = amount === null ? null : 0n, remaining: bigint | null = null;
    if (amount !== null) {
      for (const draft of localDrafts) {
        if (draft.amountCents === null) { allocated = null; consumed = null; released = null; break; }
        const cents = BigInt(draft.amountCents);
        if (draft.disposition === "RELEASED") released! += cents;
        else { allocated! += cents; if (draft.disposition === "CONSUMED") consumed! += cents; }
      }
      if (allocated !== null) {
        if (allocated > BigInt(amount)) { value.reasons.add("ABNORMAL_ALLOCATION_EXCEEDS_RESPONSIBILITY"); conflict("ABNORMAL_ALLOCATION_EXCEEDS_RESPONSIBILITY"); allocated = null; consumed = null; released = null; }
        else remaining = BigInt(amount) - allocated;
      }
    }
    const firstSubmit = abnormalFirstSubmit(raw, localDrafts, value.reasons, (reason) => { value.reasons.add(reason); conflict(reason); });
    const anyReview = localDrafts.some(d => d.intent.requiresReview || d.intent.state === "REVIEW_REQUIRED");
    const blocked = firstSubmit?.dispatch === "NEVER_DISPATCHED" && firstSubmit.blockedReason !== null;
    const localConflict = localDrafts.some(d => d.reasons.length > 0)
      || [...value.reasons].some(r => /MISMATCH|INVALID|MISSING|UNREADABLE|UNKNOWN/.test(r));
    if (localConflict) { allocated = null; consumed = null; released = null; remaining = null; }
    const state: PersonalAbnormalResponsibility["state"] = localConflict ? "CONFLICT" : anyReview || blocked ? "REVIEW_REQUIRED"
      : localDrafts.some(d => d.intent.state === "UNKNOWN" || d.intent.state === "UNRECOGNIZED") ? "UNKNOWN"
      : localDrafts.some(d => d.intent.state === "SUBMITTING" || d.intent.state === "PROCESSING") ? "PROCESSING"
      : allocated !== null && consumed !== null && amount !== null && consumed === BigInt(amount) && localDrafts.length > 0 ? "CONSUMED"
      : allocated !== null && allocated === 0n && released !== null && released > 0n ? "RELEASED"
      : localDrafts.length === 0 ? "NO_INTENT" : "READY";
    responsibilities.push({ confirmationId, reasonCode: raw.reason_code === "DUPLICATE_PAYMENT" || raw.reason_code === "LATE_PAYMENT"
      ? raw.reason_code : "UNKNOWN_REASON", originalCents: amount, currency: raw.currency === "CNY" ? "CNY" : null,
      liabilityRootId: rootId, liabilityEventId: eventId, intentIds: localDrafts.map(d => d.intent.intentId),
      allocatedCents: allocated?.toString() ?? null, consumedCents: consumed?.toString() ?? null,
      releasedCents: released?.toString() ?? null, remainingCents: remaining?.toString() ?? null,
      totalsComplete: amount !== null && allocated !== null && !localConflict,
      state, firstSubmit, reasonCodes: unique(value.reasons) });
  }
  for (const [confirmationId, drafts] of unmatched) {
    for (const draft of drafts) for (const reason of draft.reasons) conflict(reason);
    responsibilities.push({ confirmationId, reasonCode: "UNKNOWN_REASON", originalCents: null, currency: null,
      liabilityRootId: null, liabilityEventId: null, intentIds: [], allocatedCents: null, consumedCents: null,
      releasedCents: null, remainingCents: null, totalsComplete: false, state: "CONFLICT", firstSubmit: null,
      reasonCodes: ["ABNORMAL_INTENT_CONFIRMATION_UNMATCHED"] });
  }
  return { responsibilities, intents, conflictReasons, reasons: unique(reasons), truncated: truncated || intentTruncated, foreign };
}


async function applyWriteOffs(client: PoolClient, drafts: IntentDraft[], actorId: string,
  conflict: (reason: string) => void): Promise<void> {
  const writeOffIds = unique(drafts.flatMap(draft => draft.terminalEventId ? [draft.terminalEventId] : []));
  if (writeOffIds.length === 0) return;
  const ledgerRows = (await client.query<Row>(LEDGER_SQL, [writeOffIds, actorId])).rows;
  const ledger = new Map(ledgerRows.map(row => [row.event_id, row]));
  for (const draft of drafts) {
    if (!draft.terminalEventId || draft.disposition !== "CONSUMED") continue;
    const row = ledger.get(draft.terminalEventId), reasons = new Set(draft.reasons);
    const abnormal = draft.intent.basisKind === "REVIEW_CONFIRMATION";
    const line2Debit = abnormal ? row?.unallocated_debit : row?.clearing_debit;
    const line2Credit = abnormal ? row?.unallocated_credit : row?.clearing_credit;
    const line2Lines = abnormal ? row?.unallocated_lines : row?.clearing_lines;
    const bindingValid = row && row.economic_root_id === draft.terminalRootId && row.root_id === draft.terminalRootId
      && row.root_source_kind === "NATIVE_RENTAL_REFUND" && row.root_source_id === draft.intent.intentId && row.root_subject_user_id === actorId;
    const valid = row && bindingValid && row.subject_user_id === actorId
      && draft.amountCents !== null
      && row.payable_debit === draft.amountCents && row.payable_credit === "0" && row.payable_lines === "1"
      && row.payable_subject_lines === "1" && line2Debit === "0" && line2Credit === draft.amountCents
      && line2Lines === "1" && row.total_lines === "2" && [row.payable_debit, row.payable_credit, row.payable_lines,
        row.payable_subject_lines, line2Debit, line2Credit, line2Lines].every(value => typeof value === "string" && COUNT.test(value));
    const postedAt = row && timestamp(row.posted_at) ? row.posted_at as string : null;
    if (!valid) {
      const reason = !row ? "LOCAL_WRITE_OFF_UNREADABLE" : row.subject_user_id !== actorId
        ? "LOCAL_WRITE_OFF_SUBJECT_MISMATCH" : !bindingValid ? "LOCAL_WRITE_OFF_BINDING_MISMATCH" : "LOCAL_WRITE_OFF_MISMATCH";
      conflict(reason); reasons.add(reason);
    } else {
      if (!postedAt) { conflict("LOCAL_WRITE_OFF_TIME_UNREADABLE"); reasons.add("LOCAL_WRITE_OFF_TIME_UNREADABLE"); }
      draft.writeOff = { eventId: draft.terminalEventId, amountCents: draft.amountCents as string, postedAt, trust: "LOCAL_LEDGER" };
    }
    draft.reasons = [...reasons];
  }
}


function personalIntentsOf(drafts: IntentDraft[]): PersonalRefundIntent[] {
  return drafts.map(draft => ({
    ...draft.intent,
    localAccounting: { disposition: draft.disposition, writeOff: draft.writeOff, release: draft.release, reasonCodes: draft.reasons },
    channelFacts: { actualAmountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED"] },
    reasonCodes: draft.reasons,
  }));
}

function abnormalTotals(abnormal: AbnormalRead): { original: bigint | null; allocated: bigint | null; consumed: bigint | null;
  released: bigint | null; remaining: bigint | null; complete: boolean } {
  let original = 0n, allocated = 0n, consumed = 0n, released = 0n;
  let complete = abnormal.conflictReasons.size === 0 && !abnormal.truncated && abnormal.foreign === 0;
  for (const responsibility of abnormal.responsibilities) {
    if (responsibility.originalCents === null || responsibility.allocatedCents === null
      || responsibility.consumedCents === null || responsibility.releasedCents === null) { complete = false; continue; }
    original += BigInt(responsibility.originalCents);
    allocated += BigInt(responsibility.allocatedCents);
    consumed += BigInt(responsibility.consumedCents);
    released += BigInt(responsibility.releasedCents);
    if (!responsibility.totalsComplete) complete = false;
  }
  return { original: complete ? original : null, allocated: complete ? allocated : null,
    consumed: complete ? consumed : null, released: complete ? released : null,
    remaining: complete && allocated <= original ? original - allocated : null, complete };
}

function abnormalOutcome(abnormal: AbnormalRead, totals: ReturnType<typeof abnormalTotals>): PersonalRefundOutcome {
  if (abnormal.conflictReasons.size > 0 || abnormal.foreign > 0) return "CONFLICT";
  if (abnormal.truncated) return "TRUNCATED";
  if (abnormal.responsibilities.some(r => r.state === "REVIEW_REQUIRED"
    || (r.firstSubmit?.dispatch === "NEVER_DISPATCHED" && r.firstSubmit.blockedReason !== null))) return "REVIEW_REQUIRED";
  if (abnormal.responsibilities.some(r => r.state === "UNKNOWN" || r.firstSubmit?.dispatch === "UNKNOWN")) return "UNKNOWN";
  if (abnormal.responsibilities.some(r => r.state === "PROCESSING")) return "PROCESSING";
  if (abnormal.responsibilities.length === 0) return "RESPONSIBILITY_NOT_POSTED";
  if (abnormal.responsibilities.every(r => r.state === "NO_INTENT")) return "NO_INTENT";
  if (totals.consumed !== null && totals.original !== null && totals.consumed === totals.original) return "FULLY_CONSUMED";
  if (totals.consumed !== null && totals.consumed > 0n) return "PARTIALLY_CONSUMED";
  if (totals.released !== null && totals.released > 0n && (totals.allocated === null || totals.allocated === 0n)) return "RELEASED";
  if (totals.allocated !== null && totals.allocated > 0n) return totals.original !== null
    && totals.allocated === totals.original ? "FULLY_ALLOCATED" : "PARTIALLY_ALLOCATED";
  return "NO_INTENT";
}

function abnormalOnlyProjection(order: PersonalRefundReadProjection["order"], asOf: string, actorId: string,
  abnormal: AbnormalRead, extraReasons: string[] = []): PersonalRefundReadProjection {
  const intents = personalIntentsOf(abnormal.intents);
  const totals = abnormalTotals(abnormal);
  const outcome = abnormalOutcome(abnormal, totals);
  const reasons = unique([...extraReasons, ...abnormal.reasons,
    ...abnormal.responsibilities.flatMap(r => r.reasonCodes), "ABNORMAL_REVIEW_CONFIRMATION_LOCAL_RESPONSIBILITY",
    "LOCAL_RECORDS_ONLY"]);
  return {
    contractVersion: PERSONAL_REFUND_READ_VERSION, subjectId: actorId, order, status: "AVAILABLE", outcome,
    coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: INTENT_LIMIT,
      intentsComplete: !abnormal.truncated && abnormal.foreign === 0 && abnormal.conflictReasons.size === 0, channelRecordsChecked: false }, asOf,
    responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null,
      releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
    abnormalResponsibilities: abnormal.responsibilities, responsibilitiesTruncated: abnormal.truncated,
    responsibilityTotals: { originalCents: totals.original?.toString() ?? null, allocatedCents: totals.allocated?.toString() ?? null,
      consumedCents: totals.consumed?.toString() ?? null, releasedCents: totals.released?.toString() ?? null,
      remainingCents: totals.remaining?.toString() ?? null, totalsComplete: totals.complete,
      postingOriginalCents: null, abnormalOriginalCents: totals.original?.toString() ?? null,
      abnormalConfirmationCount: abnormal.responsibilities.length },
    intents, returnedIntentCount: intents.length, intentsTruncated: abnormal.truncated,
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED", "NO_TRUSTED_CHANNEL_TERMINAL"] },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: totals.consumed?.toString() ?? null,
      releasedCents: totals.released?.toString() ?? null, bankArrival: "UNKNOWN" },
    reasonCodes: reasons,
    unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"],
  };
}

function mergeAbnormalProjection(base: PersonalRefundReadProjection, abnormal: AbnormalRead,
  extraConflictReasons: ReadonlySet<string>, actorId: string): PersonalRefundReadProjection {
  const abnormalIntents = personalIntentsOf(abnormal.intents);
  const allIntents = [...base.intents, ...abnormalIntents];
  const truncated = base.intentsTruncated || abnormal.truncated || allIntents.length > INTENT_LIMIT;
  const intents = truncated ? allIntents.slice(0, INTENT_LIMIT) : allIntents;
  const totals = abnormalTotals(abnormal);
  const baseComplete = !truncated && base.responsibility.totalsComplete && base.responsibility.originalCents !== null
    && base.responsibility.allocatedCents !== null && base.responsibility.consumedCents !== null && base.responsibility.releasedCents !== null;
  const combinedOriginal = baseComplete && totals.complete
    ? BigInt(base.responsibility.originalCents!) + totals.original! : null;
  const combinedAllocated = baseComplete && totals.complete
    ? BigInt(base.responsibility.allocatedCents!) + totals.allocated! : null;
  const combinedConsumed = baseComplete && totals.complete
    ? BigInt(base.responsibility.consumedCents!) + totals.consumed! : null;
  const combinedReleased = baseComplete && totals.complete
    ? BigInt(base.responsibility.releasedCents!) + totals.released! : null;
  const combinedRemaining = combinedOriginal !== null && combinedAllocated !== null && combinedAllocated <= combinedOriginal
    ? combinedOriginal - combinedAllocated : null;
  const conflict = abnormal.conflictReasons.size > 0 || abnormal.foreign > 0 || extraConflictReasons.size > 0 || base.outcome === "CONFLICT";
  let outcome: PersonalRefundOutcome;
  if (conflict) outcome = "CONFLICT";
  else if (truncated) outcome = "TRUNCATED";
  else if (abnormal.responsibilities.some(r => r.state === "REVIEW_REQUIRED"
    || (r.firstSubmit?.dispatch === "NEVER_DISPATCHED" && r.firstSubmit.blockedReason !== null))) outcome = "REVIEW_REQUIRED";
  else if (base.outcome === "REVIEW_REQUIRED") outcome = "REVIEW_REQUIRED";
  else if (abnormal.responsibilities.some(r => r.state === "UNKNOWN" || r.firstSubmit?.dispatch === "UNKNOWN") || base.outcome === "UNKNOWN") outcome = "UNKNOWN";
  else if (abnormal.responsibilities.some(r => r.state === "PROCESSING") || base.outcome === "PROCESSING") outcome = "PROCESSING";
  else if (combinedOriginal !== null && combinedConsumed !== null && combinedConsumed === combinedOriginal) outcome = "FULLY_CONSUMED";
  else if (combinedConsumed !== null && combinedConsumed > 0n) outcome = "PARTIALLY_CONSUMED";
  else if (combinedReleased !== null && combinedReleased > 0n && (combinedAllocated === null || combinedAllocated === 0n)) outcome = "RELEASED";
  else if (combinedAllocated !== null && combinedAllocated > 0n) outcome =
    combinedOriginal !== null && combinedAllocated === combinedOriginal ? "FULLY_ALLOCATED" : "PARTIALLY_ALLOCATED";
  else outcome = base.outcome === "NOT_DUE" ? "NOT_DUE" : "NO_INTENT";
  const reasons = unique([...base.reasonCodes, ...abnormal.reasons,
    ...abnormal.responsibilities.flatMap(r => r.reasonCodes), "ABNORMAL_REVIEW_CONFIRMATION_LOCAL_RESPONSIBILITY"]);
  return {
    ...base, outcome: conflict ? "CONFLICT" : outcome,
    abnormalResponsibilities: abnormal.responsibilities,
    responsibilitiesTruncated: abnormal.truncated,
    responsibilityTotals: { originalCents: combinedOriginal?.toString() ?? null, allocatedCents: combinedAllocated?.toString() ?? null,
      consumedCents: combinedConsumed?.toString() ?? null, releasedCents: combinedReleased?.toString() ?? null,
      remainingCents: combinedRemaining?.toString() ?? null, totalsComplete: combinedOriginal !== null && !conflict,
      postingOriginalCents: base.responsibility.originalCents, abnormalOriginalCents: totals.original?.toString() ?? null,
      abnormalConfirmationCount: abnormal.responsibilities.length },
    intents, returnedIntentCount: intents.length, intentsTruncated: truncated,
    coverage: { ...base.coverage, intentsComplete: !truncated && !conflict },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING",
      writtenOffCents: combinedConsumed?.toString() ?? null, releasedCents: combinedReleased?.toString() ?? null, bankArrival: "UNKNOWN" },
    reasonCodes: conflict ? unique([...reasons, "CONFLICT"]) : reasons,
  };
}

/** 只读本人原生订单的本地退款投影；不重验渠道原件、不读商户钥、不执行退款或资金动作。 */
export async function readPersonalNativeRefunds(client: PoolClient, actor: UserContext,
  input: { orderId: unknown }): Promise<PersonalRefundReadProjection> {
  if (!input || typeof input.orderId !== "string" || !ORDER_ID.test(input.orderId)) throw invalid("Invalid order identifier");
  await assertUserContextInTransaction(client, actor, "READ");
  const { asOf } = await preflight(client);
  const orderId = input.orderId;
  const orderRows = (await client.query<Row>(ORDER_SQL, [orderId])).rows;
  const first = orderRows[0];
  if (!first || typeof first.renter_user_id !== "string" || first.renter_user_id !== actor.userId) throw notFound();
  const order: PersonalRefundReadProjection["order"] = {
    orderId, displayNo: plainText(first.display_no, 128),
    status: known(first.status, ORDER_STATUSES) ?? "UNRECOGNIZED" };
  if (order.status === "UNRECOGNIZED") {
    return { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT", ["UNRECOGNIZED_ORDER_STATUS"]), subjectId: actor.userId };
  }
  const postingId = first.posting_id;
  const abnormal = await readAbnormalSection(client, actor.userId, orderId, asOf);
  const hasAbnormal = abnormal.responsibilities.length > 0 || abnormal.intents.length > 0 || abnormal.truncated || abnormal.conflictReasons.size > 0;
  if (order.status === "PENDING_PAYMENT" || order.status === "CANCELLED") {
    if (!hasAbnormal) return postingId === null || postingId === undefined
      ? { ...emptyProjection(order, asOf, "NOT_APPLICABLE", "RESPONSIBILITY_NOT_POSTED",
          ["LOCAL_RESPONSIBILITY_NOT_POSTED", "ORDER_STATE_DOES_NOT_PROVE_CHANNEL_PAYMENT"]), subjectId: actor.userId }
      : { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT", ["POSTING_ON_NON_COMPLETED_ORDER"]), subjectId: actor.userId };
  }
  if (order.status === "PAID" && (postingId === null || postingId === undefined)) {
    if (hasAbnormal) return abnormalOnlyProjection(order, asOf, actor.userId, abnormal);
    return { ...emptyProjection(order, asOf, "NOT_APPLICABLE", "RESPONSIBILITY_NOT_POSTED",
      ["LOCAL_RESPONSIBILITY_NOT_POSTED"]), subjectId: actor.userId };
  }
  if (order.status === "PAID") {
    return { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT", ["POSTING_BEFORE_ORDER_COMPLETION"]), subjectId: actor.userId };
  }
  if (orderRows.length > 1) {
    return { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT", ["MULTIPLE_SETTLEMENT_POSTINGS"]), subjectId: actor.userId };
  }
  const validPosting = typeof postingId === "string" && ID.test(postingId);
  if (!validPosting) {
    if (!hasAbnormal) {
      const missing = postingId === null || postingId === undefined;
      return { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT",
        [order.status === "COMPLETED" && missing ? "COMPLETED_ORDER_WITHOUT_POSTING" : "POSTING_ID_UNREADABLE"]), subjectId: actor.userId };
    }
    return abnormalOnlyProjection(order, asOf, actor.userId, abnormal,
      order.status === "PENDING_PAYMENT" || order.status === "CANCELLED"
        ? ["LOCAL_RESPONSIBILITY_NOT_POSTED", "ORDER_STATE_DOES_NOT_PROVE_CHANNEL_PAYMENT"] : []);
  }

  const aggregateReasons = new Set<string>();
  const conflictReasons = new Set<string>();
  const conflict = (reason: string) => { aggregateReasons.add(reason); conflictReasons.add(reason); };

  const postingCurrency = first.posting_currency, rawOriginal = first.refund_cents, rawDueAt = first.due_at;
  const originalCents = postingCurrency === "CNY" && typeof rawOriginal === "string" && ZERO_OR_CENTS.test(rawOriginal) ? rawOriginal : null;
  if (postingCurrency !== "CNY") conflict("RESPONSIBILITY_CURRENCY_NOT_CNY");
  if (originalCents === null) conflict("RESPONSIBILITY_AMOUNT_INVALID");
  const dueAt = timestamp(rawDueAt) ? rawDueAt : null;
  if (!dueAt) conflict("RESPONSIBILITY_DUE_AT_UNREADABLE");
  const asOfMs = Date.parse(asOf), dueMs = dueAt ? Date.parse(dueAt) : Number.NaN;
  const dueState: "DUE" | "NOT_DUE" | "UNKNOWN" = dueAt && Number.isFinite(asOfMs) && Number.isFinite(dueMs)
    ? (dueMs <= asOfMs ? "DUE" : "NOT_DUE") : "UNKNOWN";

  const rawRows = (await client.query<Row>(INTENT_SQL, [postingId])).rows;
  const truncated = rawRows.length > INTENT_LIMIT;
  if (truncated) aggregateReasons.add("INTENT_LIST_TRUNCATED");
  const drafts: IntentDraft[] = [];
  let foreignIntentCount = 0;

  for (const raw of rawRows.slice(0, INTENT_LIMIT)) {
    const draft = parseIntentRow(raw, { actorId: actor.userId, orderId, basis: "POSTING", expectedPostingId: postingId,
      responsibilityCents: null, asOf, conflict, onForeign: () => { foreignIntentCount += 1; } });
    if (draft) drafts.push(draft);
  }
  await applyWriteOffs(client, drafts, actor.userId, conflict);

  const intents: PersonalRefundIntent[] = drafts.map(draft => ({
    ...draft.intent,
    localAccounting: { disposition: draft.disposition, writeOff: draft.writeOff, release: draft.release, reasonCodes: draft.reasons },
    channelFacts: { actualAmountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED"] },
    reasonCodes: draft.reasons,
  }));

  const hasForeign = foreignIntentCount > 0;
  const complete = !truncated && conflictReasons.size === 0 && !hasForeign;
  let allocated: bigint | null = null, consumed: bigint | null = null, released: bigint | null = null, remaining: bigint | null = null;
  if (complete && originalCents !== null) {
    const allocatedParts: bigint[] = [], consumedParts: bigint[] = [], releasedParts: bigint[] = [];
    for (const draft of drafts) {
      if (draft.amountCents === null) { conflict("INTENT_AMOUNT_INVALID"); continue; }
      const amount = BigInt(draft.amountCents);
      if (draft.disposition === "RELEASED") releasedParts.push(amount);
      else if (draft.disposition === "CONSUMED") { allocatedParts.push(amount); consumedParts.push(amount); }
      else if (draft.disposition === "ALLOCATED") allocatedParts.push(amount);
    }
    const due = BigInt(originalCents);
    if (conflictReasons.size === 0) {
      allocated = sum(allocatedParts); consumed = sum(consumedParts); released = sum(releasedParts);
      if (allocated > due) { conflict("ALLOCATION_EXCEEDS_RESPONSIBILITY"); allocated = null; consumed = null; released = null; }
      else remaining = due - allocated;
    }
  }
  const intentsComplete = complete && conflictReasons.size === 0;
  const totalsComplete = intentsComplete && originalCents !== null && allocated !== null;

  const zero = originalCents === "0" && intents.length === 0 && !truncated && conflictReasons.size === 0;
  const anyReview = intents.some(intent => intent.requiresReview || intent.state === "REVIEW_REQUIRED");
  const anyUnknown = intents.some(intent => intent.state === "UNKNOWN" || intent.state === "UNRECOGNIZED");
  const anyProcessing = intents.some(intent => intent.state === "SUBMITTING" || intent.state === "PROCESSING");
  let outcome: PersonalRefundOutcome;
  if (conflictReasons.size > 0 || hasForeign) outcome = "CONFLICT";
  else if (anyReview) outcome = "REVIEW_REQUIRED";
  else if (anyUnknown) outcome = "UNKNOWN";
  else if (truncated) outcome = "TRUNCATED";
  else if (anyProcessing) outcome = "PROCESSING";
  else if (zero) outcome = "ZERO_RESPONSIBILITY";
  else if (originalCents === null) outcome = "CONFLICT";
  else if (dueState === "NOT_DUE" && consumed === 0n && released === 0n) outcome = "NOT_DUE";
  else if (intents.length === 0) outcome = "NO_INTENT";
  else if (consumed === BigInt(originalCents)) outcome = "FULLY_CONSUMED";
  else if (consumed !== null && consumed > 0n) outcome = "PARTIALLY_CONSUMED";
  else if (released !== null && released > 0n && allocated === 0n) outcome = "RELEASED";
  else if (remaining === 0n) outcome = "FULLY_ALLOCATED";
  else if (allocated !== null && allocated > 0n) outcome = "PARTIALLY_ALLOCATED";
  else outcome = "NO_INTENT";

  const baseReasons: string[] = [];
  if (zero) baseReasons.push("ZERO_FROZEN_RENTER_REFUND_RESPONSIBILITY");
  if (outcome === "NOT_DUE") baseReasons.push("REFUND_RESPONSIBILITY_NOT_DUE");
  if (outcome === "NO_INTENT") baseReasons.push("NO_LOCAL_REFUND_INTENT_RECORDED");
  if (intents.length === 0) baseReasons.push("EMPTY_INTENTS_MEANS_NO_LOCAL_INTENT_ONLY");
  if (truncated) baseReasons.push("INTENT_LIST_TRUNCATED");
  if (hasForeign) baseReasons.push("INTENT_RENTER_MISMATCH");
  if (drafts.length > 1) baseReasons.push("MULTIPLE_REFUND_INTENTS");
  if (intents.some(intent => intent.localAccounting.writeOff)) baseReasons.push("LOCAL_WRITE_OFF_RECORDED");
  if (intents.some(intent => intent.localAccounting.release)) baseReasons.push("LOCAL_ALLOCATION_RELEASED");
  const reasonCodes = unique([...baseReasons, ...aggregateReasons, ...intents.flatMap(intent => intent.reasonCodes), "LOCAL_RECORDS_ONLY"]);

  const base: PersonalRefundReadProjection = {
    contractVersion: PERSONAL_REFUND_READ_VERSION,
    subjectId: actor.userId,
    order,
    status: "AVAILABLE",
    outcome,
    coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: INTENT_LIMIT, intentsComplete, channelRecordsChecked: false },
    asOf,
    responsibility: { state: "POSTED", postingId, originalCents,
      allocatedCents: allocated?.toString() ?? null, consumedCents: consumed?.toString() ?? null,
      releasedCents: released?.toString() ?? null, remainingCents: remaining?.toString() ?? null,
      totalsComplete, dueAt, dueState },
    abnormalResponsibilities: [],
    responsibilitiesTruncated: false,
    responsibilityTotals: { originalCents: totalsComplete ? originalCents : null,
      allocatedCents: totalsComplete ? allocated?.toString() ?? null : null,
      consumedCents: totalsComplete ? consumed?.toString() ?? null : null,
      releasedCents: totalsComplete ? released?.toString() ?? null : null,
      remainingCents: totalsComplete ? remaining?.toString() ?? null : null,
      totalsComplete, postingOriginalCents: originalCents, abnormalOriginalCents: null, abnormalConfirmationCount: 0 },
    intents,
    returnedIntentCount: intents.length,
    intentsTruncated: truncated,
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED", "NO_TRUSTED_CHANNEL_TERMINAL"] },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: totalsComplete ? consumed?.toString() ?? null : null,
      releasedCents: totalsComplete ? released?.toString() ?? null : null, bankArrival: "UNKNOWN" },
    reasonCodes,
    unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"],
  };
  return hasAbnormal ? mergeAbnormalProjection(base, abnormal, conflictReasons, actor.userId) : base;
}
