import type { PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { SecurityApiError } from "../auth/security-core";
import { invalid, notFound } from "../supply/supply-util";
import {assertLocalFinancialSandboxResource,localFinancialSandboxRegistration,type LocalFinancialSandbox} from './local-financial-sandbox-resource';
import {assertEcsTestDemoResource,readEcsTestDemoRegistration,type DemoFinanceResource} from './ecs-test-demo-resource';
import { readPrestartRefundProgress } from '../order/prestart-refund-store';
import type { PrestartPaymentBasis } from '../order/prestart-termination';
import { verifyPrestartRefundLiability } from './prestart-refund-liability';

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

export type PersonalRefundBasis = "POSTING";
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
  prestartRefund?: Readonly<{ state: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; amountCents: string | null;
    source: "SIMULATED" | "JOINPAY" | "UNKNOWN"; bankArrival: "UNKNOWN" }>;
  cancellationRefund?: Readonly<{ state: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; amountCents: string | null;
    source: "SIMULATED" | "JOINPAY" | "UNKNOWN"; bankArrival: "UNKNOWN" }>;
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
  { table: "zzsh_order.rental_order", columns: ["id", "display_no", "status", "renter_user_id", "cancel_reason", "paid_confirmation_id"] },
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

const ORDER_SQL = `SELECT o.id,o.display_no,o.status,o.renter_user_id,o.cancel_reason,o.paid_confirmation_id,
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
    COALESCE(i.terminal_evidence_id,to_jsonb(i)->>'demo_terminal_evidence_id') AS terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,i.provider_refund_trx_no,to_char(i.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
    to_char(i.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
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
  WHERE i.posting_id=$1 AND i.basis_kind='POSTING'
  ORDER BY i.created_at,i.id COLLATE "C" LIMIT ${INTENT_LIMIT + 1}`;

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
  reasons: string[];
  writeOff: PersonalRefundIntent["localAccounting"]["writeOff"];
  release: PersonalRefundIntent["localAccounting"]["release"];
  localRegisteredTerminal:boolean;
};

function parseIntentRow(raw: Row, ctx: { actorId: string; orderId: string;
  expectedPostingId: string; asOf: string;
  conflict: (reason: string) => void; onForeign: () => void;localRegisteredTerminal?:boolean }): IntentDraft | null {
  const { conflict, expectedPostingId } = ctx;
  const reasons = new Set<string>();
  const intentId = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  if (!intentId) { conflict("INTENT_ID_UNREADABLE"); return null; }
  if (raw.renter_user_id !== ctx.actorId) { conflict("INTENT_RENTER_MISMATCH"); ctx.onForeign(); return null; }
  if (raw.order_id !== ctx.orderId) conflict("INTENT_ORDER_MISMATCH");
  if (raw.basis_kind !== "POSTING") { conflict("INTENT_BASIS_MISMATCH"); reasons.add("INTENT_BASIS_MISMATCH"); }
  const paymentConfirmationId = typeof raw.payment_confirmation_id === "string" && ID.test(raw.payment_confirmation_id)
    ? raw.payment_confirmation_id : null;
  if (!paymentConfirmationId) { conflict("INTENT_CONFIRMATION_UNREADABLE"); reasons.add("INTENT_CONFIRMATION_UNREADABLE"); }
  if (raw.posting_id !== expectedPostingId) conflict("INTENT_POSTING_MISMATCH");

  const paymentSource = raw.payment_source, evidenceLevel = plainText(raw.evidence_level, 64);
  let source: PersonalRefundSource = "UNRECOGNIZED";
  if (paymentSource === "CONTROLLED" && evidenceLevel === "CONTROLLED_TEST") source = "LOCAL_CONTROLLED";
  else if (paymentSource === "JOINPAY" && evidenceLevel === "JOINPAY_FORMAL") source = "JOINPAY_FORMAL";
  else { conflict("UNRECOGNIZED_REFUND_SOURCE"); reasons.add("UNRECOGNIZED_REFUND_SOURCE"); }

  const currency = raw.currency, rawAmount = raw.amount_cents;
  const amountCents = typeof rawAmount === "string" && POSITIVE_CENTS.test(rawAmount) ? rawAmount : null;
  if (currency !== "CNY") { conflict("INTENT_CURRENCY_NOT_CNY"); reasons.add("INTENT_CURRENCY_NOT_CNY"); }
  if (amountCents === null) { conflict("INTENT_AMOUNT_INVALID"); reasons.add("INTENT_AMOUNT_INVALID"); }
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
  const localRegisteredTerminal=source==='LOCAL_CONTROLLED'&&ctx.localRegisteredTerminal===true&&state==='SUCCEEDED'&&disposition==='CONSUMED';
  if (terminalState) {
    if (state === "SUCCEEDED" && disposition !== "CONSUMED") { conflict("SUCCEEDED_WITHOUT_CONSUMED_BUDGET"); reasons.add("SUCCEEDED_WITHOUT_CONSUMED_BUDGET"); }
    if (state === "FAILED" && disposition !== "RELEASED") { conflict("FAILED_WITHOUT_RELEASED_BUDGET"); reasons.add("FAILED_WITHOUT_RELEASED_BUDGET"); }
    if (terminalEvidenceId === null || terminalEvidenceId === undefined) {
      conflict("TERMINAL_EVIDENCE_MISSING"); reasons.add("TERMINAL_EVIDENCE_MISSING");
    } else if(localRegisteredTerminal){
      // A proved local accounting close is never presented as saved evidence from a real channel.
      if(!completedAt||!intentTrxNo){conflict('LOCAL_TERMINAL_INCOMPLETE');reasons.add('LOCAL_TERMINAL_INCOMPLETE');}
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
  if (source === "LOCAL_CONTROLLED" && (requiresReview || terminalEvidenceId !== null && terminalEvidenceId !== undefined&&!localRegisteredTerminal)) {
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
  return { intent: { intentId, refundOrderNo, source, evidenceLevel, basisKind: "POSTING", paymentConfirmationId, amount, state,
    budgetDisposition: disposition, requiresReview, dueAt: intentDueAt, createdAt, updatedAt, latestObservation, latestFailure,
    savedChannelEvidence }, disposition, amountCents, terminalEventId, terminalRootId,
    reasons: [...reasons], writeOff: null, release,localRegisteredTerminal };
}

function emptyProjection(order: PersonalRefundReadProjection["order"], asOf: string, status: "AVAILABLE" | "NOT_APPLICABLE",
  outcome: PersonalRefundOutcome, reasonCodes: readonly string[]): PersonalRefundReadProjection {
  return { contractVersion: PERSONAL_REFUND_READ_VERSION, subjectId: "", order, status, outcome,
    coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: INTENT_LIMIT, intentsComplete: true, channelRecordsChecked: false }, asOf,
    responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null,
      releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
    intents: [], returnedIntentCount: 0, intentsTruncated: false,
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN",
      reasonCodes: ["CHANNEL_EVIDENCE_NOT_REVALIDATED", "REFUND_DESTINATION_NOT_PROJECTED", "NO_TRUSTED_CHANNEL_TERMINAL"] },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
    reasonCodes: unique([...reasonCodes, "LOCAL_RECORDS_ONLY"]),
    unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"] };
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
    const line2Debit = row?.clearing_debit, line2Credit = row?.clearing_credit, line2Lines = row?.clearing_lines;
    const bindingValid = row && row.economic_root_id === draft.terminalRootId && row.root_id === draft.terminalRootId
      && row.root_source_kind === (draft.localRegisteredTerminal?'LOCAL_CONTROLLED_RENTAL_REFUND':"NATIVE_RENTAL_REFUND") && row.root_source_id === draft.intent.intentId && row.root_subject_user_id === actorId;
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


type PrestartSummary = NonNullable<PersonalRefundReadProjection["prestartRefund"]>;
const unknownPrestart = (): PrestartSummary => ({ state: "UNKNOWN", amountCents: null, source: "UNKNOWN", bankArrival: "UNKNOWN" });

/** The same recorded responsibility drives both the cancellation and refund views. */
export function projectPrestartRefundSummary(source: "JOINPAY" | "CONTROLLED", amountCents: string,
  progress: Awaited<ReturnType<typeof readPrestartRefundProgress>>): PrestartSummary {
  if (!POSITIVE_CENTS.test(amountCents)) return unknownPrestart();
  const origin: PrestartSummary["source"] = source === "JOINPAY" ? "JOINPAY" : "dataOrigin" in progress && progress.dataOrigin === "LOCAL_CONTROLLED" ? "SIMULATED" : "UNKNOWN";
  const base = { amountCents, source: origin, bankArrival: "UNKNOWN" as const };
  const intents = progress.intents;
  if (origin === "UNKNOWN" || progress.integration !== "INTEGRATED" || progress.truncated || !progress.totals || !intents
    || progress.totals.originalCents !== amountCents || intents.some(i => i.requiresReview || ["UNKNOWN", "REVIEW_REQUIRED", "CONFLICT"].includes(i.state)))
    return { ...base, state: "UNKNOWN" };
  if (intents.some(i => ["READY", "SUBMITTING", "PROCESSING"].includes(i.state)) || !intents.length)
    return { ...base, state: "PROCESSING" };
  const succeeded = intents.filter(i => i.state === "SUCCEEDED" && i.localWriteOff === "RECORDED");
  if (progress.totals.consumedCents === amountCents && progress.totals.allocatedCents === amountCents
    && succeeded.length === 1 && (origin === "SIMULATED" || succeeded[0]?.savedChannelEvidence?.terminal === "SUCCEEDED"))
    return { ...base, state: "SUCCEEDED" };
  if (intents.some(i => i.state === "FAILED") && progress.totals.allocatedCents === "0") return { ...base, state: "FAILED" };
  return { ...base, state: "UNKNOWN" };
}

export async function readPersonalPrestartRefund(client: PoolClient, orderId: string, userId: string, confirmationId: unknown,
  reason: unknown, resource?: LocalFinancialSandbox | DemoFinanceResource): Promise<PrestartSummary> {
  const ready = (await client.query(`SELECT COALESCE(
    has_table_privilege(current_user,to_regclass('zzsh_order.prestart_termination'),'SELECT') AND
    has_function_privilege(current_user,to_regprocedure('zzsh_order.prestart_liability_complete(text)'),'EXECUTE'),false) AS ready`)).rows[0]?.ready === true;
  if (!ready) return unknownPrestart();
  const rows = (await client.query<{id:string;requested_by_party:string;payment_basis:PrestartPaymentBasis;basis_digest:string;liability_root_id:string|null;liability_event_id:string|null}>(
    `SELECT id,requested_by_party,payment_basis,basis_digest,liability_root_id,liability_event_id FROM zzsh_order.prestart_termination
     WHERE order_id=$1 AND state='APPROVED' ORDER BY created_at DESC,id DESC LIMIT 2`, [orderId])).rows;
  const term = rows[0], basis = term?.payment_basis;
  if (rows.length !== 1 || !term || !basis || basis.orderId !== orderId || basis.renterUserId !== userId
    || basis.paymentConfirmationId !== confirmationId || basis.digest !== term.basis_digest
    || reason === "SUPPORT_CANCELLED_REFUND" && term.requested_by_party !== "SUPPORT"
    || reason === "PRESTART_TERMINATED" && !["RENTER", "OWNER"].includes(term.requested_by_party)) return unknownPrestart();
  try { await verifyPrestartRefundLiability(client, term.id, basis, term.liability_root_id, term.liability_event_id); }
  catch (error) { if (error instanceof SecurityApiError && error.code === "EVIDENCE_UNAVAILABLE") return unknownPrestart(); throw error; }
  const sandbox = resource?.kind === "REGISTERED_LOCAL_FINANCIAL_SANDBOX" ? resource : undefined;
  const demo = resource && resource.kind !== "REGISTERED_LOCAL_FINANCIAL_SANDBOX" ? resource : undefined;
  const progress = await readPrestartRefundProgress(client, term.id, basis, true, sandbox, demo);
  return projectPrestartRefundSummary(basis.source, basis.amountCents, progress);
}

/** Read the same original-payment liability used by a support cancellation, never infer channel arrival. */
export async function readPersonalSupportCancellationRefund(client: PoolClient, orderId: string, userId: string, confirmationId: unknown,
  resource?: LocalFinancialSandbox | DemoFinanceResource): Promise<PrestartSummary | undefined> {
  const ready = (await client.query(`SELECT COALESCE(
    has_table_privilege(current_user,to_regclass('zzsh_order.support_poststart_cancellation'),'SELECT') AND
    has_function_privilege(current_user,to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS ready`)).rows[0]?.ready === true;
  if (!ready) return unknownPrestart();
  const rows = (await client.query(`SELECT p.id,p.order_id,p.renter_user_id,p.owner_user_id,p.payment_confirmation_id,p.source_digest,
    p.refund_cents::text AS refund_cents,c.source,c.disposition,c.currency,c.merchant_scope_id,c.merchant_order_no,c.provider_transaction_id,
    zzsh_order.support_poststart_cancellation_complete(p.id) AS complete
    FROM zzsh_order.support_poststart_cancellation p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=p.order_id
    WHERE p.order_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 2`, [orderId])).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.order_id !== orderId || row.renter_user_id !== userId || row.payment_confirmation_id !== confirmationId
    || row.complete !== true || row.disposition !== "APPLIED" || row.currency !== "CNY" || !["JOINPAY", "CONTROLLED"].includes(row.source)
    || typeof row.refund_cents !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(row.refund_cents)
    || ![row.id,row.owner_user_id,row.payment_confirmation_id,row.merchant_scope_id,row.merchant_order_no,row.provider_transaction_id].every(v => typeof v === "string" && ID.test(v))
    || typeof row.source_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.source_digest)) return unknownPrestart();
  if (row.refund_cents === "0") return undefined;
  const basis: PrestartPaymentBasis = { orderId, renterUserId: userId, ownerUserId: row.owner_user_id,
    paymentConfirmationId: row.payment_confirmation_id, source: row.source, merchantIdentityId: row.merchant_scope_id,
    merchantOrderNo: row.merchant_order_no, channelTrxNo: row.provider_transaction_id, amountCents: row.refund_cents,
    currency: "CNY", digest: row.source_digest };
  const sandbox = resource?.kind === "REGISTERED_LOCAL_FINANCIAL_SANDBOX" ? resource : undefined;
  const demo = resource && resource.kind !== "REGISTERED_LOCAL_FINANCIAL_SANDBOX" ? resource : undefined;
  const progress = await readPrestartRefundProgress(client, row.id, basis, true, sandbox, demo, "SUPPORT_CANCELLATION");
  return projectPrestartRefundSummary(basis.source, basis.amountCents, progress);
}

/** 只读本人原生订单的本地退款投影；不重验渠道原件、不读商户钥、不执行退款或资金动作。 */
export async function readPersonalNativeRefunds(client: PoolClient, actor: UserContext,
  input: { orderId: unknown },sandbox?:LocalFinancialSandbox|DemoFinanceResource): Promise<PersonalRefundReadProjection> {
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
  const prestartRefund = order.status === "CANCELLED" && (postingId === null || postingId === undefined)
    && ["PRESTART_TERMINATED", "SUPPORT_CANCELLED_REFUND"].includes(String(first.cancel_reason))
    ? await readPersonalPrestartRefund(client, orderId, actor.userId, first.paid_confirmation_id, first.cancel_reason, sandbox) : undefined;
  const cancellationRefund = order.status === "CANCELLED" && (postingId === null || postingId === undefined)
    && first.cancel_reason === "SUPPORT_AFTER_START_CANCELLED"
    ? await readPersonalSupportCancellationRefund(client, orderId, actor.userId, first.paid_confirmation_id, sandbox) : undefined;
  if (order.status === "PENDING_PAYMENT" || order.status === "CANCELLED") {
    return postingId === null || postingId === undefined
      ? { ...emptyProjection(order, asOf, "NOT_APPLICABLE", "RESPONSIBILITY_NOT_POSTED",
          ["LOCAL_RESPONSIBILITY_NOT_POSTED", "ORDER_STATE_DOES_NOT_PROVE_CHANNEL_PAYMENT"]), subjectId: actor.userId,
          ...(prestartRefund ? { prestartRefund } : {}), ...(cancellationRefund ? { cancellationRefund } : {}) }
      : { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT", ["POSTING_ON_NON_COMPLETED_ORDER"]), subjectId: actor.userId };
  }
  if (order.status === "PAID" && (postingId === null || postingId === undefined)) {
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
    const missing = postingId === null || postingId === undefined;
    return { ...emptyProjection(order, asOf, "AVAILABLE", "CONFLICT",
      [order.status === "COMPLETED" && missing ? "COMPLETED_ORDER_WITHOUT_POSTING" : "POSTING_ID_UNREADABLE"]), subjectId: actor.userId };
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
  const localTerminals=new Set<string>();
  if(sandbox){
    const reference=sandbox.kind!=='REGISTERED_LOCAL_FINANCIAL_SANDBOX'
      ? (await assertEcsTestDemoResource(client,sandbox,'READ_ORIGINAL'),readEcsTestDemoRegistration(sandbox).registration.reference)
      : (await assertLocalFinancialSandboxResource(client,sandbox,'READ_ORIGINAL'),localFinancialSandboxRegistration(sandbox).registration.reference);
    const local=(await client.query<{id:string;complete:boolean}>(`SELECT i.id,zzsh_order.local_controlled_refund_terminal_complete(i.id) AS complete
      FROM zzsh_order.channel_refund_intent i WHERE i.order_id=$1 AND i.renter_user_id=$2 AND i.sandbox_registration_ref=$3
       AND i.payment_source='CONTROLLED' AND i.evidence_level='CONTROLLED_TEST' AND i.state='SUCCEEDED' LIMIT 51`,[orderId,actor.userId,reference])).rows;
    for(const row of local)if(row.complete===true)localTerminals.add(row.id);
  }
  const truncated = rawRows.length > INTENT_LIMIT;
  if (truncated) aggregateReasons.add("INTENT_LIST_TRUNCATED");
  const drafts: IntentDraft[] = [];
  let foreignIntentCount = 0;

  for (const raw of rawRows.slice(0, INTENT_LIMIT)) {
    const draft = parseIntentRow(raw, { actorId: actor.userId, orderId, expectedPostingId: postingId,
      asOf, conflict, onForeign: () => { foreignIntentCount += 1; },localRegisteredTerminal:localTerminals.has(String(raw.id)) });
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
  return base;
}
