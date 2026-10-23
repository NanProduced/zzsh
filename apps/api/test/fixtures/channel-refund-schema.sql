-- 候选测试DDL；不登记迁移号、不启用正式退款。额度占用不是渠道冻结或退款到账。
CREATE TABLE zzsh_order.channel_refund_intent (
  id text PRIMARY KEY,
  posting_id text NOT NULL REFERENCES zzsh_order.settlement_posting(id),
  order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  payment_confirmation_id text NOT NULL REFERENCES zzsh_order.payment_confirmation(id),
  renter_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  payment_source text NOT NULL CHECK (payment_source = 'CONTROLLED'),
  merchant_identity_id text NOT NULL CHECK (length(merchant_identity_id) BETWEEN 1 AND 128),
  original_payment_trx_no text NOT NULL CHECK (length(original_payment_trx_no) BETWEEN 1 AND 128),
  original_payment_order_no text NOT NULL CHECK (length(original_payment_order_no) BETWEEN 1 AND 128),
  responsibility_version_hash text NOT NULL CHECK (responsibility_version_hash ~ '^[0-9a-f]{64}$'),
  refund_order_no text NOT NULL CHECK (refund_order_no ~ '^RF[0-9a-f]{28}$'),
  amount_cents numeric NOT NULL CHECK (amount_cents = trunc(amount_cents) AND amount_cents > 0 AND amount_cents <= 9999999999999999),
  currency text NOT NULL CHECK (currency = 'CNY'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','SUBMITTING','UNKNOWN')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_owner text CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  lease_until timestamptz,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (posting_id,idempotency_key),
  UNIQUE (payment_source,merchant_identity_id,refund_order_no),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'READY' AND lease_version = 0 AND lease_owner IS NULL)
      OR (state IN ('SUBMITTING','UNKNOWN') AND lease_version > 0 AND lease_owner IS NOT NULL))
);
CREATE INDEX channel_refund_funds_budget ON zzsh_order.channel_refund_intent
  (payment_source,merchant_identity_id,original_payment_trx_no);

CREATE TABLE zzsh_order.channel_refund_observation (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES zzsh_order.channel_refund_intent(id),
  event text NOT NULL CHECK (event IN ('UNKNOWN','STALE')),
  failure_reason text NOT NULL CHECK (failure_reason IN ('TIMEOUT','HTTP_NON_200','CONNECTION_LOST','RESPONSE_TRUNCATED','LOCAL_FAILURE')),
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  lease_owner text NOT NULL CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  state_before text NOT NULL CHECK (state_before IN ('READY','SUBMITTING','UNKNOWN')),
  state_after text NOT NULL CHECK (state_after IN ('READY','SUBMITTING','UNKNOWN')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((event = 'UNKNOWN' AND state_before IN ('SUBMITTING','UNKNOWN') AND state_after = 'UNKNOWN')
      OR (event = 'STALE' AND state_after = state_before))
);

CREATE FUNCTION zzsh_order.guard_channel_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  basis record;
  paid_allocated numeric;
  responsibility_allocated numeric;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'refund intent requires READ COMMITTED' USING ERRCODE = '25001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund allocations cannot be deleted or released' USING ERRCODE = '40001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at'])
       OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'refund original binding and amount are immutable' USING ERRCODE = '40001';
    END IF;
    IF NEW.lease_version = OLD.lease_version + 1 THEN
      IF (OLD.lease_until IS NOT NULL AND OLD.lease_until > clock_timestamp()) OR OLD.due_at > clock_timestamp()
         OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until <= clock_timestamp()
         OR NEW.lease_until > clock_timestamp() + interval '3600 seconds'
         OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state = 'READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END) THEN
        RAISE EXCEPTION 'refund lease is not claimable' USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.lease_version = OLD.lease_version THEN
      IF OLD.state NOT IN ('SUBMITTING','UNKNOWN') OR NEW.state <> 'UNKNOWN'
         OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
         OR OLD.lease_until IS NULL OR OLD.lease_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'refund result requires the live lease' USING ERRCODE = '40001';
      END IF;
    ELSE
      RAISE EXCEPTION 'refund lease must advance exactly once' USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  SELECT p.order_id, p.payment_confirmation_id, p.version_hash, p.refund_due_at, p.renter_refund_cents,
         o.renter_user_id, c.source, c.merchant_scope_id, c.provider_transaction_id, c.merchant_order_no, c.amount_cents
    INTO basis FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
    JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
    WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED'
      AND c.source='CONTROLLED' AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents;
  IF NOT FOUND OR NEW.order_id IS DISTINCT FROM basis.order_id
     OR NEW.payment_confirmation_id IS DISTINCT FROM basis.payment_confirmation_id
     OR NEW.renter_user_id IS DISTINCT FROM basis.renter_user_id
     OR NEW.responsibility_version_hash IS DISTINCT FROM basis.version_hash
     OR NEW.payment_source IS DISTINCT FROM basis.source OR NEW.merchant_identity_id IS DISTINCT FROM basis.merchant_scope_id
     OR NEW.original_payment_trx_no IS DISTINCT FROM basis.provider_transaction_id
     OR NEW.original_payment_order_no IS DISTINCT FROM basis.merchant_order_no OR NEW.currency <> 'CNY'
     OR NEW.due_at IS DISTINCT FROM basis.refund_due_at THEN
    RAISE EXCEPTION 'refund must bind the immutable native responsibility and payment' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-funds:v1',NEW.payment_source,NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  -- VOLATILE + READ COMMITTED：锁等待结束后下一条查询取新快照；真实并发仍须PG用例验证。
  SELECT COALESCE(sum(amount_cents),0), COALESCE(sum(amount_cents) FILTER (WHERE posting_id=NEW.posting_id),0)
    INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent
    WHERE payment_source=NEW.payment_source AND merchant_identity_id=NEW.merchant_identity_id
      AND original_payment_trx_no=NEW.original_payment_trx_no;
  IF paid_allocated + NEW.amount_cents > basis.amount_cents
     OR responsibility_allocated + NEW.amount_cents > basis.renter_refund_cents THEN
    RAISE EXCEPTION 'refund allocation exceeds paid or responsibility budget' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> 'READY' OR NEW.revision <> 1 OR NEW.lease_version <> 0
     OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
    RAISE EXCEPTION 'refund intent must start unclaimed' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_refund_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.channel_refund_intent
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_refund_intent();

CREATE FUNCTION zzsh_order.guard_channel_refund_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'refund observations are append only' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER channel_refund_observation_guard BEFORE UPDATE OR DELETE ON zzsh_order.channel_refund_observation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_refund_observation();
