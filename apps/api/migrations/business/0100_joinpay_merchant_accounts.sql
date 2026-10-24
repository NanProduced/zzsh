-- Formal source migration 0100_joinpay_merchant_accounts; execution and channels require separate authorization.
-- Fixed source main e1ea0b9f8e4c37b86f7408ffd3923d78d53b18bf; runtime DCL moves to the maintained helper.

DO $payment_schema_before$
DECLARE relation_name text; x record;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['zzsh_order.joinpay_account_observation'] LOOP
  IF to_regclass(relation_name) IS NOT NULL THEN RAISE EXCEPTION 'payment schema already exists; explicit adoption required: %',relation_name USING ERRCODE='55000';END IF;
 END LOOP;
END $payment_schema_before$;

--> statement-breakpoint
-- source joinpay-account-schema #0
CREATE TABLE zzsh_order.joinpay_account_observation (
  attempt_id text PRIMARY KEY CHECK (attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  merchant_identity_id text NOT NULL CHECK (merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation text NOT NULL CHECK (operation IN ('AVAILABLE','COLLECTION')),
  profile_id text NOT NULL, profile_sha256 text NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  rules_sha256 text NOT NULL CHECK (rules_sha256 ~ '^[a-f0-9]{64}$'), key_version_ref text NOT NULL,
  review_ref text NOT NULL, review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  http_status integer CHECK (http_status BETWEEN 100 AND 599), response_complete boolean NOT NULL,
  received_bytes bigint NOT NULL CHECK (received_bytes >= 0), transport_failure text,
  raw_body bytea, raw_sha256 text,
  evidence_level text NOT NULL CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','PROVIDER_RESPONSE')),
  decision text NOT NULL CHECK (decision IN ('SUCCESS','SIGNED_PROVIDER_ERROR','UNKNOWN')),
  schema_status text NOT NULL CHECK (schema_status IN ('VALID','INVALID')),
  signature_status text NOT NULL CHECK (signature_status IN ('MATCH','MISMATCH','NOT_CHECKED')),
  binding_status text NOT NULL CHECK (binding_status IN ('MATCH','MISMATCH','NOT_CHECKED')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 128), status_code text, error_code text, amounts jsonb,
  CHECK (received_at >= requested_at),
  CHECK ((raw_body IS NULL AND raw_sha256 IS NULL AND NOT response_complete AND received_bytes=0)
    OR (raw_body IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_sha256=encode(sha256(raw_body),'hex')
      AND octet_length(raw_body)<=65536 AND received_bytes>=octet_length(raw_body)
      AND (NOT response_complete OR received_bytes=octet_length(raw_body)))),
  CHECK (decision='UNKNOWN' OR (response_complete AND http_status=200 AND transport_failure IS NULL
    AND schema_status='VALID' AND signature_status='MATCH' AND binding_status='MATCH')),
  CHECK ((decision='SUCCESS' AND status_code='2001' AND error_code IS NULL AND amounts IS NOT NULL AND jsonb_typeof(amounts)='object')
    OR (decision<>'SUCCESS' AND amounts IS NULL))
);

--> statement-breakpoint
-- source joinpay-account-schema #1
CREATE INDEX joinpay_account_observation_scope_time ON zzsh_order.joinpay_account_observation(merchant_identity_id,operation,recorded_at DESC,attempt_id);

--> statement-breakpoint
-- source joinpay-account-schema #2
CREATE FUNCTION zzsh_order.guard_joinpay_account_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; expected integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Account observations are append only' USING ERRCODE='23514'; END IF;
  NEW.recorded_at := clock_timestamp();
  IF NEW.decision='SUCCESS' THEN
    expected := CASE NEW.operation WHEN 'AVAILABLE' THEN 2 ELSE 4 END;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.amounts))<>expected THEN RAISE EXCEPTION 'Balance fields differ' USING ERRCODE='23514'; END IF;
    FOR item IN SELECT key,value FROM jsonb_each(NEW.amounts) LOOP
      IF NOT (item.key=ANY(CASE NEW.operation WHEN 'AVAILABLE' THEN ARRAY['useAbleSettAmount','availableSettAmountFrozen']
        ELSE ARRAY['useAbleAdvanceAmount','currentAdvanceAmount','usedAdvanceAmount','advanceFrozenAmount'] END))
        OR jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR jsonb_typeof(item.value->'rawDecimal') IS DISTINCT FROM 'string'
        OR length(item.value->>'rawDecimal')>128 OR (item.value->>'rawDecimal') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        OR NOT (item.value ? 'unitKnowledge' AND item.value ? 'cents')
        OR NOT COALESCE(((item.value->>'unitKnowledge'='UNKNOWN' AND item.value->'cents'='null'::jsonb)
          OR (item.value->>'unitKnowledge'='CNY_YUAN' AND jsonb_typeof(item.value->'cents')='string' AND (item.value->>'cents') ~ '^-?(0|[1-9][0-9]*)$')),false)
      THEN RAISE EXCEPTION 'Invalid precise balance' USING ERRCODE='23514'; END IF;
      IF item.value->>'unitKnowledge'='CNY_YUAN' AND
        ((item.value->>'rawDecimal') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
          OR (item.value->>'rawDecimal')::numeric*100<>(item.value->>'cents')::numeric)
      THEN RAISE EXCEPTION 'Balance cents mismatch' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-account-schema #3
CREATE TRIGGER joinpay_account_observation_insert BEFORE INSERT ON zzsh_order.joinpay_account_observation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_account_observation();

--> statement-breakpoint
-- source joinpay-account-schema #4
CREATE TRIGGER joinpay_account_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_account_observation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_account_observation();

--> statement-breakpoint
-- source joinpay-account-schema #5
REVOKE ALL ON zzsh_order.joinpay_account_observation FROM PUBLIC;

--> statement-breakpoint
-- source joinpay-account-schema #6
REVOKE ALL ON FUNCTION zzsh_order.guard_joinpay_account_observation() FROM PUBLIC;
