-- CREDIT-ADMIN-BATCH2: final reviewed structure, preserving migrations 0000..0066.
-- New schema seeds existing users at 100 and appends one INITIALIZED event each.
-- Runtime provider dispatch remains disabled; migration execution requires a separate window.
CREATE SCHEMA IF NOT EXISTS zzsh_credit;

CREATE TABLE zzsh_credit.user_credit_state (
  user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  initialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE zzsh_credit.credit_event (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  event_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('INITIALIZED','BREACH_CONFIRMED','BREACH_REVERSED','RECOVERY_APPROVED')),
  source_type text NOT NULL,
  source_id text NOT NULL,
  subject_role text CHECK (subject_role IS NULL OR subject_role IN ('OWNER','RENTER')),
  delta_score smallint NOT NULL CHECK (delta_score BETWEEN -100 AND 100),
  applied_delta_score smallint NOT NULL CHECK (applied_delta_score BETWEEN -100 AND 100),
  score_before smallint NOT NULL CHECK (score_before BETWEEN 0 AND 100),
  score_after smallint NOT NULL CHECK (score_after BETWEEN 0 AND 100),
  visible_reason text NOT NULL CHECK (length(btrim(visible_reason)) BETWEEN 2 AND 500),
  internal_basis text NOT NULL CHECK (length(btrim(internal_basis)) BETWEEN 2 AND 500),
  actor_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  reversal_of_id text REFERENCES zzsh_credit.credit_event(id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id,event_key),
  UNIQUE (reversal_of_id)
);

CREATE OR REPLACE FUNCTION zzsh_credit.guard_credit_state_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('zzsh.credit_mutation', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'credit state is changed only by the credit mutation path' USING ERRCODE='42501';
  END IF;
  IF NEW.score < 0 OR NEW.score > 100 OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'credit state transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_credit.guard_credit_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_row record; original record;
BEGIN
  IF NEW.applied_delta_score IS DISTINCT FROM NEW.score_after - NEW.score_before THEN
    RAISE EXCEPTION 'credit event applied delta is inconsistent' USING ERRCODE='23514';
  END IF;
  SELECT score INTO state_row FROM zzsh_credit.user_credit_state WHERE user_id=NEW.user_id;
  IF state_row.score IS NULL OR NEW.score_before IS DISTINCT FROM state_row.score THEN
    RAISE EXCEPTION 'credit event does not bind the current score' USING ERRCODE='23514';
  END IF;
  IF NEW.event_type='INITIALIZED' THEN
    IF NEW.delta_score<>0 OR NEW.score_before<>100 OR NEW.score_after<>100 OR NEW.actor_admin_id IS NOT NULL THEN
      RAISE EXCEPTION 'credit initialization is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='BREACH_CONFIRMED' THEN
    IF NEW.delta_score<>-10 OR NEW.subject_role IS NULL OR NEW.reversal_of_id IS NOT NULL OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit breach is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='BREACH_REVERSED' THEN
    SELECT * INTO original FROM zzsh_credit.credit_event WHERE id=NEW.reversal_of_id AND user_id=NEW.user_id;
    IF original.id IS NULL OR original.event_type<>'BREACH_CONFIRMED' OR NEW.delta_score<>-original.applied_delta_score OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit reversal is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='RECOVERY_APPROVED' THEN
    IF NEW.delta_score<>10 OR NEW.source_type<>'RECOVERY_REQUEST' OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit recovery event is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_credit_state_guard
BEFORE UPDATE OR DELETE ON zzsh_credit.user_credit_state
FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_state_update();
CREATE TRIGGER credit_event_guard
BEFORE INSERT ON zzsh_credit.credit_event
FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_event_insert();
CREATE TRIGGER credit_event_immutable
BEFORE UPDATE OR DELETE ON zzsh_credit.credit_event
FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_state_update();

INSERT INTO zzsh_credit.user_credit_state(user_id,score,revision)
SELECT id,100,1 FROM zzsh_auth_user."user"
ON CONFLICT(user_id) DO NOTHING;
INSERT INTO zzsh_credit.credit_event(id,user_id,event_key,event_type,source_type,source_id,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,payload_hash)
SELECT 'credit_init_'||md5(u.id),u.id,'initial:'||u.id,'INITIALIZED','SYSTEM',u.id,0,0,100,100,'新制度建立初始信用分','credit-policy-v1:user-initial-score-100',md5('INITIALIZED:'||u.id||':100')||md5('credit-policy-v1')
FROM zzsh_auth_user."user" u
WHERE NOT EXISTS (SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=u.id AND e.event_key='initial:'||u.id);

CREATE TABLE zzsh_credit.credit_recovery_request (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  request_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  eligibility_snapshot jsonb NOT NULL,
  score_before smallint NOT NULL CHECK (score_before BETWEEN 0 AND 100),
  completed_orders bigint NOT NULL CHECK (completed_orders >= 0),
  decision text CHECK (decision IN ('APPROVE','REJECT')),
  decision_fingerprint text CHECK (decision_fingerprint IS NULL OR decision_fingerprint ~ '^[0-9a-f]{64}$'),
  decision_reason text,
  decided_by text REFERENCES zzsh_auth_admin."user"(id),
  event_id text REFERENCES zzsh_credit.credit_event(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  UNIQUE(user_id,request_key),
  CONSTRAINT credit_recovery_request_decision_shape CHECK (((status='PENDING' AND decision IS NULL AND decision_fingerprint IS NULL AND decided_by IS NULL AND decided_at IS NULL AND event_id IS NULL)
      OR (status='REJECTED' AND decision IS NOT NULL AND decision='REJECT' AND decision_fingerprint IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND event_id IS NULL)
      OR (status='APPROVED' AND decision IS NOT NULL AND decision='APPROVE' AND decision_fingerprint IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND event_id IS NOT NULL)) IS TRUE)
);

CREATE TABLE zzsh_order.owner_guarantee_requirement (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  account_id text NOT NULL,
  game_id text NOT NULL,
  listing_version_id text,
  price_version_id text NOT NULL,
  rule_release_id text NOT NULL,
  policy_version text NOT NULL,
  base_cents numeric(24,0) NOT NULL CHECK (base_cents >= 0),
  required_cents numeric(24,0) NOT NULL CHECK (required_cents BETWEEN 0 AND 10000),
  score_snapshot smallint NOT NULL CHECK (score_snapshot BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('OPEN','COVERED','REFUND_REQUESTED','REFUND_PROCESSING','REFUNDED','RESTRICTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id,owner_user_id) REFERENCES zzsh_supply.rental_account(id,owner_user_id)
);
CREATE UNIQUE INDEX owner_guarantee_requirement_binding_uq
  ON zzsh_order.owner_guarantee_requirement(owner_user_id,account_id,price_version_id,COALESCE(listing_version_id,''));

CREATE TABLE zzsh_order.owner_guarantee_payment (
  id text PRIMARY KEY,
  requirement_id text NOT NULL REFERENCES zzsh_order.owner_guarantee_requirement(id),
  owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  request_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  merchant_order_no text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider='HUIJU'),
  provider_request_state text NOT NULL CHECK (provider_request_state IN ('NOT_AUTHORIZED','SUBMITTED','UNKNOWN','CONFIRMED','FAILED')),
  provider_transaction_id text,
  amount_cents numeric(24,0) NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000),
  observed_amount_cents numeric(24,0) CHECK (observed_amount_cents IS NULL OR (observed_amount_cents > 0 AND observed_amount_cents <= amount_cents)),
  status text NOT NULL CHECK (status IN ('REQUESTED','ACCEPTED','PROCESSING','CONFIRMED','FAILED','UNKNOWN')),
  original_receipt jsonb,
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
  finance_event_id text REFERENCES zzsh_order.finance_event(id),
  ledger_entry_ref text REFERENCES zzsh_order.settlement_ledger_entry(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(requirement_id,request_key),
  UNIQUE(provider,provider_transaction_id)
);

CREATE TABLE zzsh_order.owner_guarantee_refund (
  id text PRIMARY KEY,
  requirement_id text NOT NULL REFERENCES zzsh_order.owner_guarantee_requirement(id),
  payment_id text NOT NULL REFERENCES zzsh_order.owner_guarantee_payment(id),
  owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  request_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider='HUIJU'),
  provider_request_state text NOT NULL CHECK (provider_request_state IN ('NOT_AUTHORIZED','SUBMITTED','UNKNOWN','SUCCEEDED','FAILED')),
  provider_refund_id text,
  amount_cents numeric(24,0) NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000),
  status text NOT NULL CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED','UNKNOWN')),
  release_policy_state text NOT NULL CHECK (release_policy_state IN ('OWNER_DECISION_REQUIRED','APPROVED','REJECTED')),
  release_decision_reason text,
  release_decision_fingerprint text CHECK (release_decision_fingerprint IS NULL OR release_decision_fingerprint ~ '^[0-9a-f]{64}$'),
  release_decided_by text REFERENCES zzsh_auth_admin."user"(id),
  release_decided_at timestamptz,
  original_receipt jsonb,
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
  finance_event_id text REFERENCES zzsh_order.finance_event(id),
  ledger_entry_ref text REFERENCES zzsh_order.settlement_ledger_entry(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(requirement_id,request_key),
  UNIQUE(provider,provider_refund_id),
  CONSTRAINT owner_guarantee_refund_release_decision_shape CHECK ((release_policy_state='OWNER_DECISION_REQUIRED' AND release_decision_fingerprint IS NULL AND release_decided_by IS NULL AND release_decided_at IS NULL)
      OR (release_policy_state IN ('APPROVED','REJECTED') AND release_decision_fingerprint IS NOT NULL AND release_decided_by IS NOT NULL AND release_decided_at IS NOT NULL))
);

CREATE TABLE zzsh_order.owner_guarantee_reconciliation (
  id text PRIMARY KEY,
  payment_id text REFERENCES zzsh_order.owner_guarantee_payment(id),
  refund_id text REFERENCES zzsh_order.owner_guarantee_refund(id),
  observed_state text NOT NULL,
  observed_amount_cents numeric(24,0),
  provider_reference text,
  canonical_payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((payment_id IS NOT NULL) <> (refund_id IS NOT NULL)),
  UNIQUE(payment_id,payload_digest),
  UNIQUE(refund_id,payload_digest)
);


--> statement-breakpoint
ALTER TABLE zzsh_order.finance_economic_root
  DROP CONSTRAINT finance_root_enabled_source_shape,
  ADD CONSTRAINT finance_root_enabled_source_shape CHECK (
    (source_kind IN ('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
    OR (source_kind IN ('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE') AND basis_id IS NULL));

ALTER TABLE zzsh_order.finance_event
  DROP CONSTRAINT finance_event_kind_check,
  ADD CONSTRAINT finance_event_kind_check CHECK (
    kind IN ('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED',
      'EARNING_REVOKED','GUARANTEE_CAPTURE','GUARANTEE_REFUND'));

-- Repair F1: keep the original wallet revision behavior for withdrawal and
-- distribution events, but exclude guarantee capture/refund from wallet
-- coverage and wallet_revision side effects.
DROP TRIGGER withdrawal_revision ON zzsh_order.finance_event;
CREATE TRIGGER withdrawal_revision AFTER INSERT ON zzsh_order.finance_event
  FOR EACH ROW WHEN (NEW.kind IN ('RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED'))
  EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

ALTER TABLE zzsh_order.settlement_ledger_entry
  DROP CONSTRAINT settlement_ledger_accounts,
  DROP CONSTRAINT settlement_ledger_counterparty,
  ADD CONSTRAINT settlement_ledger_accounts CHECK (
    (posting_id IS NOT NULL AND account_code IN ('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE',
      'RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP',
      'PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
    OR (finance_event_id IS NOT NULL AND account_code IN ('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE',
      'WALLET_RESERVED','PAYOUT_CLEARING','WITHDRAW_FEE','WALLET_PENDING_EARNINGS',
      'DISTRIBUTION_EXPENSE','GUARANTEE_CASH','GUARANTEE_HELD'))),
  ADD CONSTRAINT settlement_ledger_counterparty CHECK (
    (account_code IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED',
      'WALLET_PENDING_EARNINGS','GUARANTEE_HELD') AND counterparty_user_id IS NOT NULL)
    OR (account_code NOT IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED',
      'WALLET_PENDING_EARNINGS','GUARANTEE_HELD') AND counterparty_user_id IS NULL));

-- New guarantee-specific root/event/entry guards. These are the exact bodies
-- from the bound schema draft; no second ledger is introduced.
CREATE FUNCTION zzsh_order.guard_guarantee_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; f record;
BEGIN
  IF NEW.source_kind<>'NATIVE_GUARANTEE' OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-credit-guarantee'
    OR NEW.beneficiary_role<>'OWNER' OR NEW.policy_version<>'credit-guarantee-v1' THEN
    RAISE EXCEPTION 'unbound guarantee economic root' USING ERRCODE='23514';
  END IF;
  IF NEW.source_entity='owner_guarantee_payment' THEN
    SELECT id,requirement_id,owner_user_id,source_digest,provider_request_state,status INTO p FROM zzsh_order.owner_guarantee_payment WHERE id=NEW.source_id;
    IF p.id IS NULL OR p.owner_user_id<>NEW.subject_user_id OR p.source_digest IS NULL OR p.source_digest<>NEW.source_digest OR p.status<>'CONFIRMED' OR p.provider_request_state<>'CONFIRMED' THEN
      RAISE EXCEPTION 'guarantee payment root is not an admitted confirmed receipt' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.source_entity='owner_guarantee_refund' THEN
    SELECT id,requirement_id,owner_user_id,source_digest,provider_request_state,status INTO f FROM zzsh_order.owner_guarantee_refund WHERE id=NEW.source_id;
    IF f.id IS NULL OR f.owner_user_id<>NEW.subject_user_id OR f.source_digest IS NULL OR f.source_digest<>NEW.source_digest OR f.status<>'SUCCEEDED' OR f.provider_request_state<>'SUCCEEDED' THEN
      RAISE EXCEPTION 'guarantee refund root is not an admitted successful receipt' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown guarantee root source' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER guarantee_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root
  FOR EACH ROW WHEN (NEW.source_kind='NATIVE_GUARANTEE') EXECUTE FUNCTION zzsh_order.guard_guarantee_root();

CREATE FUNCTION zzsh_order.guard_guarantee_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root zzsh_order.finance_economic_root; p record; f record;
BEGIN
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
  IF root.id IS NULL OR root.source_kind<>'NATIVE_GUARANTEE' OR NEW.subject_user_id<>root.subject_user_id OR NEW.expected_ledger_revision<>0
    OR (NEW.kind='GUARANTEE_CAPTURE' AND root.source_entity<>'owner_guarantee_payment')
    OR (NEW.kind='GUARANTEE_REFUND' AND root.source_entity<>'owner_guarantee_refund') THEN
    RAISE EXCEPTION 'guarantee event source/action mismatch' USING ERRCODE='23514';
  END IF;
  IF root.source_entity='owner_guarantee_payment' THEN
    SELECT status,provider_request_state,finance_event_id INTO p FROM zzsh_order.owner_guarantee_payment WHERE id=root.source_id;
    IF p.status<>'CONFIRMED' OR p.provider_request_state<>'CONFIRMED' OR p.finance_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'guarantee capture event requires one unposted confirmed receipt' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT status,provider_request_state,finance_event_id INTO f FROM zzsh_order.owner_guarantee_refund WHERE id=root.source_id;
    IF f.status<>'SUCCEEDED' OR f.provider_request_state<>'SUCCEEDED' OR f.finance_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'guarantee refund event requires one unposted successful receipt' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.created_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER guarantee_event_guard BEFORE INSERT ON zzsh_order.finance_event
  FOR EACH ROW WHEN (NEW.kind IN ('GUARANTEE_CAPTURE','GUARANTEE_REFUND')) EXECUTE FUNCTION zzsh_order.guard_guarantee_event();

CREATE FUNCTION zzsh_order.guard_guarantee_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e zzsh_order.finance_event; root zzsh_order.finance_economic_root; amount numeric; expected jsonb; p record; f record;
BEGIN
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=e.economic_root_id;
  IF e.id IS NULL OR e.kind NOT IN ('GUARANTEE_CAPTURE','GUARANTEE_REFUND') OR e.created_xid<>pg_current_xact_id() OR root.source_kind<>'NATIVE_GUARANTEE' OR NEW.source_payment_confirmation_id IS NOT NULL THEN
    RAISE EXCEPTION 'guarantee ledger entry is unadmitted' USING ERRCODE='23514';
  END IF;
  IF root.source_entity='owner_guarantee_payment' THEN
    SELECT g.requirement_id AS requirement_id,g.owner_user_id AS owner_user_id,COALESCE(g.observed_amount_cents,g.amount_cents) AS amount_cents INTO p FROM zzsh_order.owner_guarantee_payment AS g WHERE g.id=root.source_id;
    amount:=p.amount_cents;
    expected:=jsonb_build_object('guaranteeId',root.source_id,'requirementId',p.requirement_id,'economicRootId',root.id,'sourceDigest',root.source_digest);
  ELSE
    SELECT g.requirement_id AS requirement_id,g.owner_user_id AS owner_user_id,g.amount_cents AS amount_cents INTO f FROM zzsh_order.owner_guarantee_refund AS g WHERE g.id=root.source_id;
    amount:=f.amount_cents;
    expected:=jsonb_build_object('guaranteeId',root.source_id,'requirementId',f.requirement_id,'economicRootId',root.id,'sourceDigest',root.source_digest);
  END IF;
  IF NEW.details IS DISTINCT FROM expected THEN RAISE EXCEPTION 'guarantee ledger provenance mismatch' USING ERRCODE='23514'; END IF;
  IF e.kind='GUARANTEE_CAPTURE' AND NOT((NEW.line_no=1 AND NEW.account_code='GUARANTEE_CASH' AND NEW.debit_cents=amount AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
    OR (NEW.line_no=2 AND NEW.account_code='GUARANTEE_HELD' AND NEW.debit_cents=0 AND NEW.credit_cents=amount AND NEW.counterparty_user_id=(SELECT owner_user_id FROM zzsh_order.owner_guarantee_payment WHERE id=root.source_id))) THEN
    RAISE EXCEPTION 'guarantee capture ledger line differs from exact template' USING ERRCODE='23514';
  END IF;
  IF e.kind='GUARANTEE_REFUND' AND NOT((NEW.line_no=1 AND NEW.account_code='GUARANTEE_CASH' AND NEW.debit_cents=0 AND NEW.credit_cents=amount AND NEW.counterparty_user_id IS NULL)
    OR (NEW.line_no=2 AND NEW.account_code='GUARANTEE_HELD' AND NEW.debit_cents=amount AND NEW.credit_cents=0 AND NEW.counterparty_user_id=(SELECT owner_user_id FROM zzsh_order.owner_guarantee_refund WHERE id=root.source_id))) THEN
    RAISE EXCEPTION 'guarantee refund ledger line differs from exact template' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
  WHEN (NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')) EXECUTE FUNCTION zzsh_order.check_finance_batch();
CREATE TRIGGER guarantee_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
  WHEN (NEW.finance_event_id IS NOT NULL AND NEW.details?'guaranteeId') EXECUTE FUNCTION zzsh_order.guard_guarantee_entry();

CREATE OR REPLACE FUNCTION zzsh_order.check_guarantee_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target text;
  e zzsh_order.finance_event;
  root zzsh_order.finance_economic_root;
  amount numeric;
  count_lines bigint;
  debits numeric;
  credits numeric;
BEGIN
  -- The trigger is shared by two relations. Keep NEW field lookup inside the
  -- relation-specific branch; the runtime role must not gain UPDATE merely to
  -- acquire a row lock on immutable finance_event rows.
  IF TG_TABLE_NAME = 'finance_event' THEN
    target := NEW.id;
  ELSE
    target := NEW.finance_event_id;
  END IF;
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id = target;
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id = e.economic_root_id;
  IF root.source_entity = 'owner_guarantee_payment' THEN
    SELECT COALESCE(observed_amount_cents, amount_cents) INTO amount
      FROM zzsh_order.owner_guarantee_payment WHERE id = root.source_id;
  ELSE
    SELECT amount_cents INTO amount
      FROM zzsh_order.owner_guarantee_refund WHERE id = root.source_id;
  END IF;
  SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
    INTO count_lines, debits, credits
    FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id = target;
  IF e.kind NOT IN ('GUARANTEE_CAPTURE', 'GUARANTEE_REFUND')
     OR count_lines <> 2 OR debits <> amount OR credits <> amount THEN
    RAISE EXCEPTION 'guarantee ledger batch incomplete or unbalanced' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER guarantee_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind IN ('GUARANTEE_CAPTURE','GUARANTEE_REFUND')) EXECUTE FUNCTION zzsh_order.check_guarantee_batch();
CREATE CONSTRAINT TRIGGER guarantee_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.finance_event_id IS NOT NULL AND NEW.details?'guaranteeId') EXECUTE FUNCTION zzsh_order.check_guarantee_batch();


--> statement-breakpoint
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('credit.read','读取用户信用处置','读取用户信用当前分数、事件和恢复申请'),
 ('credit.decide','处置用户信用','确认违约、撤销误判和审核信用恢复'),
 ('credit.guarantee.read','读取号主保证金','按用户和出租账号读取保证金收退款及对账依据'),
 ('credit.guarantee.manage','管理号主保证金','受权处理保证金状态和渠道对账，不代表渠道到账')
ON CONFLICT(code) DO NOTHING;


CREATE FUNCTION zzsh_credit.runtime_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1';
REVOKE ALL ON SCHEMA zzsh_credit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA zzsh_credit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA zzsh_credit FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_guarantee_root(),zzsh_order.guard_guarantee_event(),zzsh_order.guard_guarantee_entry(),zzsh_order.check_guarantee_batch() FROM PUBLIC;
