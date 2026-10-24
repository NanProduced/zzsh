-- Formal source migration 0097_joinpay_collection_core; execution and channels require separate authorization.
-- Fixed source main e1ea0b9f8e4c37b86f7408ffd3923d78d53b18bf; runtime DCL moves to the maintained helper.

DO $payment_schema_before$
DECLARE relation_name text; x record;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['zzsh_order.joinpay_collection_attempt','zzsh_order.joinpay_collection_binding','zzsh_order.joinpay_collection_evidence','zzsh_order.joinpay_collection_observation','zzsh_order.payment_channel_observation','zzsh_order.payment_channel_transaction','zzsh_order.payment_request'] LOOP
  IF to_regclass(relation_name) IS NOT NULL THEN RAISE EXCEPTION 'payment schema already exists; explicit adoption required: %',relation_name USING ERRCODE='55000';END IF;
 END LOOP;
 FOR x IN SELECT * FROM(VALUES ('zzsh_order.check_applied_payment()','5099d89e9200e3537ad81c4ca7fb04859578df5b960487fb51ffad84c264e794'),('zzsh_order.derive_payment_referral_inputs(text)','8999ba0b231e9753992b714678a753eed875cd6cc1304dbbd081e61f51a0d709'),('zzsh_order.guard_distribution_order_admission()','56578c13204bd669d71faa4189963806fdfaf0d36d97fce8f375af8c8c7b0ad2')) AS expected(signature,digest) LOOP
  IF to_regprocedure(x.signature) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(x.signature) AND encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=x.digest) THEN
   RAISE EXCEPTION 'payment shared parent function differs: %',x.signature USING ERRCODE='55000';END IF;
 END LOOP;
END $payment_schema_before$;

--> statement-breakpoint
-- source channel-payment-schema #0

CREATE TABLE zzsh_order.payment_request (
  id text PRIMARY KEY CHECK (id ~ '^payreq_[0-9a-f]{32}$'),
  -- 首期一个原生订单最多一个请求
  order_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_order(id),
  channel text NOT NULL CHECK (channel IN ('JOINPAY','CONTROLLED')),
  merchant_identity_id text NOT NULL CHECK (merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  config_profile_id text NOT NULL CHECK (config_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  protocol_version text NOT NULL CHECK (protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$'),
  key_version_ref text NOT NULL CHECK (key_version_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  platform_order_no text NOT NULL CHECK (length(platform_order_no) BETWEEN 1 AND 128),
  channel_order_no text NOT NULL,
  amount_cents numeric(25,0) NOT NULL CHECK (amount_cents >= 1 AND amount_cents <= 9999999999999999),
  currency text NOT NULL CHECK (currency = 'CNY'),
  wire_amount_yuan text NOT NULL CHECK (wire_amount_yuan ~ '^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'),
  method text NOT NULL CHECK (method IN ('ALIPAY_NATIVE','WEIXIN_NATIVE')),
  evidence_level text NOT NULL CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','CONTROLLED_TEST')),
  idempotency_scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'SUBMITTING' CHECK (state IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED',
    'REJECTED_BY_CHANNEL','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','ACCEPTED','REVIEW_REQUIRED')),
  -- 并发/恢复所需的最少列：revision 防丢更新，lease 三列做条件领取与写回比较
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_owner text CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel, merchant_identity_id, channel_order_no),
  UNIQUE (id, order_id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  -- wire 金额必须与整数分逐位一致
  CHECK (replace(wire_amount_yuan, '.', '')::numeric = amount_cents),
  -- JOINPAY 原号仅字母数字下划线 1..50；CONTROLLED 保持 display_no
  CHECK ((channel = 'JOINPAY' AND channel_order_no ~ '^[A-Za-z0-9_]{1,50}$' AND channel_order_no = replace(platform_order_no, '-', '_'))
      OR (channel = 'CONTROLLED' AND channel_order_no = platform_order_no)),
  CHECK ((channel = 'CONTROLLED') = (evidence_level = 'CONTROLLED_TEST'))
);

--> statement-breakpoint
-- source channel-payment-schema #1
CREATE TABLE zzsh_order.payment_channel_observation (
  id text PRIMARY KEY CHECK (id ~ '^payobs_[0-9a-f]{32}$'),
  -- 无主/错绑通知也必须留存，故可空
  request_id text REFERENCES zzsh_order.payment_request(id),
  channel text NOT NULL CHECK (channel IN ('JOINPAY','CONTROLLED')),
  merchant_identity_id text CHECK (merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  channel_order_no text CHECK (length(channel_order_no) BETWEEN 1 AND 128),
  channel_trx_no text CHECK (length(channel_trx_no) BETWEEN 1 AND 128),
  config_profile_id text,
  protocol_version text,
  key_version_ref text,
  operation text NOT NULL CHECK (operation IN ('SYNC_RESPONSE','ASYNC_NOTIFY','QUERY_RESPONSE','ACCEPTANCE')),
  source text NOT NULL CHECK (source IN ('EXECUTOR','PROVIDER_INBOUND','ACCEPTANCE_GATE')),
  evidence_level text NOT NULL CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','UNVERIFIED','CONTROLLED_TEST')),
  event text NOT NULL CHECK (event IN ('E1','E1P','E2','E3','E4','E5','E6','E6X','E7','E8','E9','E11')),
  result text NOT NULL CHECK (result ~ '^[A-Z0-9_-]{1,64}$'),
  reason text CHECK (reason ~ '^[A-Z0-9_-]{1,64}$'),
  channel_status text CHECK (length(channel_status) <= 32),
  -- 渠道时间只存原文；时区未核（U-03），不派生正式 providerPaidAt
  provider_paid_at_raw text CHECK (length(provider_paid_at_raw) <= 64),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_ref text NOT NULL CHECK (length(raw_ref) BETWEEN 1 AND 256),
  -- 仅缓存，不是可信依据；可信依据为绑定 + 原件可重验
  verify_outcome text CHECK (length(verify_outcome) <= 64),
  lease_version bigint,
  state_before text,
  state_after text,
  stale boolean NOT NULL DEFAULT false,
  late boolean NOT NULL DEFAULT false,
  conflict boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT stale OR event = 'E9'),
  CHECK (request_id IS NOT NULL OR (state_before IS NULL AND state_after IS NULL))
);

--> statement-breakpoint
-- source channel-payment-schema #2
CREATE TABLE zzsh_order.payment_channel_transaction (
  id text PRIMARY KEY CHECK (id ~ '^paytrx_[0-9a-f]{32}$'),
  channel text NOT NULL CHECK (channel IN ('JOINPAY','CONTROLLED')),
  merchant_identity_id text NOT NULL CHECK (merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  channel_trx_no text NOT NULL CHECK (length(channel_trx_no) BETWEEN 1 AND 128),
  -- LEGACY 写入/导入本期关闭；原生与旧来源字段不混 FK
  order_origin text NOT NULL CHECK (order_origin = 'NATIVE'),
  native_order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  request_id text,
  confirmation_id text REFERENCES zzsh_order.payment_confirmation(id),
  evidence_level text NOT NULL CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','CONTROLLED_TEST')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 资金键不含 profile、钥版本、协议或 origin：轮换不产生第二笔资金
  UNIQUE (channel, merchant_identity_id, channel_trx_no),
  FOREIGN KEY (request_id, native_order_id) REFERENCES zzsh_order.payment_request(id, order_id),
  -- 0036 只有 CONTROLLED 来源，JOINPAY 锚点不得关联 confirmation
  CHECK (channel = 'CONTROLLED' OR confirmation_id IS NULL),
  CHECK ((channel = 'CONTROLLED') = (evidence_level = 'CONTROLLED_TEST'))
);

--> statement-breakpoint
-- source channel-payment-schema #3
CREATE FUNCTION zzsh_order.guard_channel_payment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'channel payment observation/anchor is append-only' USING ERRCODE = '40001';
END $$;

--> statement-breakpoint
-- source channel-payment-schema #4
CREATE TRIGGER payment_channel_observation_append_only BEFORE UPDATE OR DELETE ON zzsh_order.payment_channel_observation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source channel-payment-schema #5
CREATE TRIGGER payment_channel_transaction_append_only BEFORE UPDATE OR DELETE ON zzsh_order.payment_channel_transaction
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source channel-payment-schema #6
CREATE FUNCTION zzsh_order.guard_payment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment request is immutable' USING ERRCODE = '40001';
  END IF;
  IF (NEW.id, NEW.order_id, NEW.channel, NEW.merchant_identity_id, NEW.config_profile_id, NEW.protocol_version,
      NEW.key_version_ref, NEW.platform_order_no, NEW.channel_order_no, NEW.amount_cents, NEW.currency,
      NEW.wire_amount_yuan, NEW.method, NEW.evidence_level, NEW.idempotency_scope_key, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.order_id, OLD.channel, OLD.merchant_identity_id, OLD.config_profile_id, OLD.protocol_version,
      OLD.key_version_ref, OLD.platform_order_no, OLD.channel_order_no, OLD.amount_cents, OLD.currency,
      OLD.wire_amount_yuan, OLD.method, OLD.evidence_level, OLD.idempotency_scope_key, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'payment request binding is immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.state IN ('ACCEPTED','REVIEW_REQUIRED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'payment request terminal state is immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.lease_version < OLD.lease_version THEN
    RAISE EXCEPTION 'payment request revision/lease must advance' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- source channel-payment-schema #7
CREATE TRIGGER payment_request_guard BEFORE UPDATE OR DELETE ON zzsh_order.payment_request
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request();

--> statement-breakpoint
-- source channel-payment-schema #8
CREATE FUNCTION zzsh_order.guard_payment_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'SUBMITTING' OR NEW.revision <> 1 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL THEN
    RAISE EXCEPTION 'payment request must start as SUBMITTING' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- source channel-payment-schema #9
CREATE TRIGGER payment_request_insert_guard BEFORE INSERT ON zzsh_order.payment_request
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request_insert();

--> statement-breakpoint
-- source channel-payment-schema #10
CREATE FUNCTION zzsh_order.check_channel_transaction_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.payment_confirmation p
     WHERE p.id = NEW.confirmation_id AND p.order_id = NEW.native_order_id AND p.source = NEW.channel
       AND p.merchant_scope_id = NEW.merchant_identity_id AND p.provider_transaction_id = NEW.channel_trx_no) THEN
    RAISE EXCEPTION 'channel transaction anchor must match its confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

--> statement-breakpoint
-- source channel-payment-schema #11
CREATE CONSTRAINT TRIGGER payment_channel_transaction_confirmation_guard
  AFTER INSERT ON zzsh_order.payment_channel_transaction DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_channel_transaction_confirmation();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #0
ALTER TABLE zzsh_order.payment_request DROP CONSTRAINT payment_request_evidence_level_check;

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #1
ALTER TABLE zzsh_order.payment_request ADD CONSTRAINT payment_request_evidence_level_check
  CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','CONTROLLED_TEST','JOINPAY_CANDIDATE'));

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #2
CREATE TABLE zzsh_order.joinpay_collection_binding (
 request_id text PRIMARY KEY REFERENCES zzsh_order.payment_request(id),
 wire_merchant_no text NOT NULL CHECK (wire_merchant_no ~ '^[0-9]{1,15}$' AND wire_merchant_no<>'888100000002340'),
 trade_merchant_no text NOT NULL CHECK (length(trade_merchant_no) BETWEEN 1 AND 50),
 product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 30),
 notify_url text NOT NULL CHECK (notify_url LIKE 'https://%' AND length(notify_url)<=300),
 initial_profile_sha256 text NOT NULL CHECK (initial_profile_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_mode text NOT NULL CHECK (evidence_mode='OFFICIAL'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #3
CREATE TABLE zzsh_order.joinpay_collection_attempt (
 id text PRIMARY KEY CHECK (id ~ '^jpat_[0-9a-f]{32}$'),
 request_id text NOT NULL REFERENCES zzsh_order.joinpay_collection_binding(request_id),
 lease_version bigint NOT NULL CHECK (lease_version>0),
 lease_owner text NOT NULL CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 operation text NOT NULL CHECK (operation IN ('SUBMIT','QUERY')),
 profile_id text NOT NULL CHECK (profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 profile_canonical text NOT NULL CHECK (octet_length(profile_canonical)<=131072),
 profile_sha256 text NOT NULL CHECK (profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 key_version_ref text NOT NULL CHECK (key_version_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 evidence_mode text NOT NULL CHECK (evidence_mode='OFFICIAL'),
 request_body bytea NOT NULL CHECK (octet_length(request_body) BETWEEN 1 AND 16384),
 request_sha256 text NOT NULL CHECK (request_sha256=encode(sha256(request_body),'hex')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,lease_version),UNIQUE(id,request_id)
);

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #4
CREATE TABLE zzsh_order.joinpay_collection_observation (
 id text PRIMARY KEY CHECK (id ~ '^jpobs_[0-9a-f]{32}$'),
 attempt_id text NOT NULL UNIQUE,
 request_id text NOT NULL,
 raw_body bytea CHECK (octet_length(raw_body)<=65536),
 raw_sha256 text,
 http_status integer CHECK (http_status BETWEEN 100 AND 599),
 response_complete boolean NOT NULL,
 received_bytes bigint NOT NULL CHECK (received_bytes>=0),
 transport_failure text CHECK (transport_failure IN ('TIMEOUT','ABORTED','HTTP_STATUS','BODY_TOO_LARGE','NETWORK_ERROR')),
 event text NOT NULL CHECK (event IN ('E1','E1P','E2','E3','E4','E5','E6','E6X','E9','E11')),
 result text NOT NULL CHECK (result ~ '^[A-Z0-9_-]{1,64}$'),
 schema_outcome text NOT NULL CHECK (schema_outcome IN ('VALID','INVALID','NOT_CHECKED')),
 signature_outcome text NOT NULL CHECK (signature_outcome IN ('MATCH','MISMATCH','NOT_CHECKED')),
 binding_outcome text NOT NULL CHECK (binding_outcome IN ('MATCH','MISMATCH','NOT_CHECKED')),
 verified boolean NOT NULL,
 state_before text NOT NULL CHECK (state_before IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED','REJECTED_BY_CHANNEL','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','ACCEPTED','REVIEW_REQUIRED')),
 state_after text NOT NULL CHECK (state_after IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED','REJECTED_BY_CHANNEL','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','REVIEW_REQUIRED')),
 channel_status text CHECK (length(channel_status)<=32),
 provider_paid_at_raw text CHECK (length(provider_paid_at_raw)<=64),
 channel_trx_no text CHECK (length(channel_trx_no) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,request_id) REFERENCES zzsh_order.joinpay_collection_attempt(id,request_id),
 CHECK ((raw_body IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_sha256=encode(sha256(raw_body),'hex')) OR (raw_body IS NULL AND raw_sha256 IS NULL AND NOT response_complete)),
 CHECK (received_bytes>=COALESCE(octet_length(raw_body),0)),
 CHECK (NOT response_complete OR (raw_body IS NOT NULL AND http_status IS NOT NULL AND received_bytes=octet_length(raw_body))),
 CHECK (transport_failure IS NOT NULL OR (response_complete AND http_status=200)),
 CHECK (NOT verified OR (response_complete AND http_status=200 AND schema_outcome='VALID' AND signature_outcome='MATCH' AND binding_outcome='MATCH')),
 CHECK (transport_failure IS NULL OR NOT verified),
 CHECK (event<>'E4' OR verified),
 CHECK (event<>'E9' OR (NOT verified AND state_before=state_after))
);

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #5
CREATE TRIGGER joinpay_collection_binding_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #6
CREATE TRIGGER joinpay_collection_attempt_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #7
CREATE TRIGGER joinpay_collection_observation_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #8
CREATE FUNCTION zzsh_order.guard_joinpay_collection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; canonical jsonb;
BEGIN
 IF TG_TABLE_NAME='joinpay_collection_binding' THEN
  SELECT channel,evidence_level INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id;
  IF NOT FOUND OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' THEN
   RAISE EXCEPTION 'collection cannot promote a synthetic or controlled request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 SELECT p.*,b.wire_merchant_no,b.trade_merchant_no,b.notify_url,b.initial_profile_sha256,b.evidence_mode AS original_mode INTO r
 FROM zzsh_order.payment_request p JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=p.id WHERE p.id=NEW.request_id;
 IF NOT FOUND OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR NEW.evidence_mode<>r.original_mode
  OR NEW.lease_version<>r.lease_version OR NEW.lease_owner<>r.lease_owner OR r.lease_until<=clock_timestamp()
  OR NEW.operation IS DISTINCT FROM (CASE WHEN r.lease_version=1 AND r.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END) THEN
  RAISE EXCEPTION 'collection attempt must bind its current lease' USING ERRCODE='23514';
 END IF;
 IF NEW.operation='SUBMIT' AND (NEW.profile_id<>r.config_profile_id OR NEW.key_version_ref<>r.key_version_ref OR NEW.profile_sha256<>r.initial_profile_sha256) THEN
  RAISE EXCEPTION 'first submit must use its original profile' USING ERRCODE='23514';
 END IF;
 canonical:=NEW.profile_canonical::jsonb;
 IF canonical->>'profileId' IS DISTINCT FROM NEW.profile_id OR canonical->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id
  OR canonical->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no
  OR (NEW.operation='SUBMIT' AND (canonical->>'tradeMerchantNo' IS DISTINCT FROM r.trade_merchant_no OR canonical->>'notifyUrl' IS DISTINCT FROM r.notify_url))
  OR canonical->>'purpose' IS DISTINCT FROM 'COLLECTION'
  OR canonical->>'evidenceMode' IS DISTINCT FROM 'OFFICIAL' OR canonical#>>ARRAY['operations',NEW.operation,'keyVersionRef'] IS DISTINCT FROM NEW.key_version_ref THEN
  RAISE EXCEPTION 'collection profile must preserve the original merchant and wire binding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #9
CREATE TRIGGER joinpay_collection_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #10
CREATE TRIGGER joinpay_collection_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_collection_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #11
CREATE FUNCTION zzsh_order.guard_joinpay_collection_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='ACCEPTED' THEN RAISE EXCEPTION 'collection evidence cannot accept payment' USING ERRCODE='23514'; END IF;
 IF NEW.lease_version=OLD.lease_version+1 THEN
  IF NEW.state<>OLD.state OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
   OR OLD.state NOT IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED')
   OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
   OR NEW.lease_until>clock_timestamp()+interval '3600 seconds' THEN
   RAISE EXCEPTION 'collection lease is not claimable' USING ERRCODE='40001';
  END IF;
 ELSIF NEW.lease_version=OLD.lease_version THEN
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   OR OLD.lease_until IS NULL THEN
   RAISE EXCEPTION 'collection result lease binding changed' USING ERRCODE='40001';
  END IF;
  IF OLD.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='40001',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
 ELSE RAISE EXCEPTION 'collection lease must advance once' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #12
CREATE TRIGGER joinpay_collection_request_guard BEFORE UPDATE ON zzsh_order.payment_request
 FOR EACH ROW WHEN (OLD.evidence_level='JOINPAY_CANDIDATE') EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_request();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #13
CREATE FUNCTION zzsh_order.check_joinpay_collection_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_CANDIDATE' AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_binding WHERE request_id=NEW.id) THEN
  RAISE EXCEPTION 'collection request requires immutable wire evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.evidence_level='JOINPAY_CANDIDATE' THEN
  IF NEW.lease_version>OLD.lease_version AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_attempt WHERE request_id=NEW.id AND lease_version=NEW.lease_version AND lease_owner=NEW.lease_owner) THEN
   RAISE EXCEPTION 'collection lease requires a committed attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS(
   SELECT 1 FROM zzsh_order.joinpay_collection_observation o JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id
   WHERE o.request_id=NEW.id AND a.lease_version=NEW.lease_version AND o.state_before=OLD.state AND o.state_after=NEW.state AND o.event<>'E9') THEN
   RAISE EXCEPTION 'collection transition requires its raw observation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #14
CREATE CONSTRAINT TRIGGER joinpay_collection_request_closure AFTER INSERT OR UPDATE ON zzsh_order.payment_request
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_collection_closure();

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #15
CREATE FUNCTION zzsh_order.guard_joinpay_collection_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; current_lease boolean;
BEGIN
 SELECT p.state,p.lease_version,p.lease_owner,p.lease_until,t.lease_version AS attempt_version,t.lease_owner AS attempt_owner INTO a
 FROM zzsh_order.payment_request p JOIN zzsh_order.joinpay_collection_attempt t ON t.request_id=p.id WHERE t.id=NEW.attempt_id AND p.id=NEW.request_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'collection observation attempt missing' USING ERRCODE='23514'; END IF;
 current_lease:=a.lease_version=a.attempt_version AND a.lease_owner=a.attempt_owner AND a.lease_until>clock_timestamp();
 IF NEW.event='E9' THEN
  IF current_lease OR NEW.state_before<>a.state OR NEW.state_after<>a.state THEN
   RAISE EXCEPTION 'stale collection evidence cannot change the request' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT current_lease THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
  IF NEW.state_after<>a.state THEN
   RAISE EXCEPTION 'collection observation state differs' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-attempt-schema #16
CREATE TRIGGER joinpay_collection_observation_guard BEFORE INSERT ON zzsh_order.joinpay_collection_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_observation();

--> statement-breakpoint
-- source joinpay-collection-source-schema #0
ALTER TABLE zzsh_order.joinpay_collection_binding
 ADD COLUMN formal_admission_ref text,
 ADD COLUMN formal_admission_sha256 text,
 ADD COLUMN formal_admission_canonical text,
 ADD CONSTRAINT joinpay_formal_initial_shape CHECK (
  (formal_admission_ref IS NULL AND formal_admission_sha256 IS NULL AND formal_admission_canonical IS NULL)
  OR (formal_admission_ref IS NOT NULL AND formal_admission_sha256 IS NOT NULL AND formal_admission_canonical IS NOT NULL
   AND formal_admission_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND octet_length(formal_admission_canonical)<=262144
   AND formal_admission_sha256=encode(sha256(convert_to(formal_admission_canonical,'UTF8')),'hex')));

--> statement-breakpoint
-- source joinpay-collection-source-schema #1

ALTER TABLE zzsh_order.distribution_order_admission
 ADD COLUMN mode text NOT NULL DEFAULT 'LOCAL_CONTROLLED' CHECK(mode IN('LOCAL_CONTROLLED','NATIVE')),
 ADD COLUMN source_admission_ref text,
 ALTER COLUMN created_by_admin_id DROP NOT NULL,
 DROP CONSTRAINT distribution_order_admission_resource_marker_check,
 ADD CONSTRAINT distribution_admission_mode_shape CHECK (
  (mode='LOCAL_CONTROLLED' AND resource_marker='zzsh:order-reservation-test:v1' AND created_by_admin_id IS NOT NULL AND source_admission_ref IS NULL)
  OR(mode='NATIVE' AND resource_marker='NATIVE_CREATED_ORDER_V1' AND created_by_admin_id IS NULL AND source_admission_ref IS NOT NULL));

--> statement-breakpoint
-- source joinpay-collection-source-schema #2
ALTER TABLE zzsh_order.distribution_policy_version DROP CONSTRAINT distribution_policy_version_scope_check,
 ADD CONSTRAINT distribution_policy_version_scope_check CHECK(scope IN('LOCAL_CONTROLLED','NATIVE'));

--> statement-breakpoint
-- source joinpay-collection-source-schema #3
ALTER TABLE zzsh_order.distribution_policy_head DROP CONSTRAINT distribution_policy_head_scope_check,
 ADD CONSTRAINT distribution_policy_head_scope_check CHECK(scope IN('LOCAL_CONTROLLED','NATIVE'));

--> statement-breakpoint
-- source joinpay-collection-source-schema #4
CREATE TABLE zzsh_order.joinpay_collection_evidence (
 id text PRIMARY KEY CHECK(id ~ '^jpe_[0-9a-f]{32}$'),
 request_id text NOT NULL REFERENCES zzsh_order.payment_request(id),
 operation text NOT NULL CHECK(operation IN('NOTIFY','QUERY')),
 origin_observation_id text REFERENCES zzsh_order.joinpay_collection_observation(id),
 raw_query bytea CHECK(octet_length(raw_query)<=65536),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
 profile_id text NOT NULL,profile_sha256 text NOT NULL,profile_canonical text NOT NULL CHECK(octet_length(profile_canonical)<=131072),
 key_version_ref text NOT NULL,
 initial_admission_ref text NOT NULL,initial_admission_sha256 text NOT NULL,
 admission_ref text NOT NULL,admission_sha256 text NOT NULL,admission_canonical text NOT NULL CHECK(octet_length(admission_canonical)<=262144),
 event text NOT NULL CHECK(event IN('E4','E5','E6','E6X','E11')),
 result text NOT NULL CHECK(result ~ '^[A-Z0-9_-]{1,64}$'),
 schema_outcome text NOT NULL CHECK(schema_outcome IN('VALID','INVALID')),
 signature_outcome text NOT NULL CHECK(signature_outcome IN('MATCH','MISMATCH','NOT_CHECKED')),
 binding_outcome text NOT NULL CHECK(binding_outcome IN('MATCH','MISMATCH','NOT_CHECKED')),
 channel_trx_no text CHECK(channel_trx_no ~ '^[A-Za-z0-9_-]{1,64}$'),
 provider_paid_at_raw text CHECK(length(provider_paid_at_raw)<=64),provider_paid_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,request_id),UNIQUE(request_id,operation,raw_sha256,profile_sha256,key_version_ref),
 CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 CHECK(admission_sha256=encode(sha256(convert_to(admission_canonical,'UTF8')),'hex')),
 CHECK((operation='NOTIFY' AND raw_query IS NOT NULL AND origin_observation_id IS NULL AND raw_sha256=encode(sha256(raw_query),'hex'))
    OR(operation='QUERY' AND raw_query IS NULL AND origin_observation_id IS NOT NULL)),
 CHECK(event<>'E4' OR(schema_outcome='VALID' AND signature_outcome='MATCH' AND binding_outcome='MATCH'
   AND channel_trx_no IS NOT NULL AND provider_paid_at_raw IS NOT NULL AND provider_paid_at IS NOT NULL))
);

--> statement-breakpoint
-- source joinpay-collection-source-schema #5
CREATE TRIGGER joinpay_collection_evidence_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

--> statement-breakpoint
-- source joinpay-collection-source-schema #6
CREATE FUNCTION zzsh_order.guard_joinpay_formal_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; doc jsonb;
BEGIN
 IF NEW.formal_admission_ref IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 doc:=NEW.formal_admission_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.state<>'SUBMITTING' OR r.revision<>1 OR r.lease_version<>0
  OR NEW.evidence_mode<>'OFFICIAL' OR NEW.wire_merchant_no='888100000002340'
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.formal_admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NEW.formal_admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=r.config_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=r.key_version_ref)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['SUBMIT','QUERY','NOTIFY']) required(operation) WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=required.operation))
 THEN RAISE EXCEPTION 'initial formal binding is not admitted' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #7
CREATE TRIGGER joinpay_formal_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_binding();

--> statement-breakpoint
-- source joinpay-collection-source-schema #8
CREATE FUNCTION zzsh_order.check_joinpay_native_admission_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;a record;r record;order_id_value text;
BEGIN
 IF TG_TABLE_NAME='joinpay_collection_binding' THEN
  IF NEW.formal_admission_ref IS NULL THEN RETURN NULL;END IF;
  SELECT order_id INTO order_id_value FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 ELSE
  IF NEW.mode<>'NATIVE' THEN RETURN NULL;END IF;order_id_value:=NEW.order_id;
 END IF;
 SELECT p.*,x.formal_admission_ref,x.formal_admission_sha256 INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding x ON x.request_id=p.id WHERE p.order_id=order_id_value;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=order_id_value;
 IF r.id IS NULL OR r.formal_admission_ref IS NULL OR a.id IS NULL OR a.mode<>'NATIVE'
  OR a.source_admission_ref IS DISTINCT FROM r.formal_admission_ref OR a.approval_digest IS DISTINCT FROM r.formal_admission_sha256
 THEN RAISE EXCEPTION 'formal initial binding and native admission must co-commit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #9
CREATE CONSTRAINT TRIGGER joinpay_formal_binding_admission_pair AFTER INSERT ON zzsh_order.joinpay_collection_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();

--> statement-breakpoint
-- source joinpay-collection-source-schema #10
CREATE CONSTRAINT TRIGGER native_admission_formal_binding_pair AFTER INSERT ON zzsh_order.distribution_order_admission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();

--> statement-breakpoint
-- source joinpay-collection-source-schema #11
CREATE FUNCTION zzsh_order.guard_joinpay_collection_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;o record;doc jsonb;pdoc jsonb;offset_text text;offset_minutes integer;
BEGIN
 SELECT p.*,b.formal_admission_ref,b.formal_admission_sha256,b.wire_merchant_no INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=p.id WHERE p.id=NEW.request_id;
 doc:=NEW.admission_canonical::jsonb;pdoc:=NEW.profile_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.formal_admission_ref IS NULL
  OR NEW.initial_admission_ref IS DISTINCT FROM r.formal_admission_ref OR NEW.initial_admission_sha256 IS DISTINCT FROM r.formal_admission_sha256
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no
  OR (NEW.admission_sha256<>r.formal_admission_sha256 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedInitialAdmissions') h
   WHERE h->>'reference'=r.formal_admission_ref AND h->>'sha256'=r.formal_admission_sha256))
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=NEW.operation
   AND p->>'profileId'=NEW.profile_id AND p->>'profileSha256'=NEW.profile_sha256 AND p->>'keyVersionRef'=NEW.key_version_ref)
  OR pdoc->>'profileId' IS DISTINCT FROM NEW.profile_id OR pdoc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id
  OR pdoc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no OR pdoc->>'purpose' IS DISTINCT FROM 'COLLECTION'
  OR pdoc->>'evidenceMode' IS DISTINCT FROM 'OFFICIAL' OR pdoc#>>ARRAY['operations',NEW.operation,'keyVersionRef'] IS DISTINCT FROM NEW.key_version_ref
  OR NEW.admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
 THEN RAISE EXCEPTION 'collection evidence original admission/profile binding differs' USING ERRCODE='23514';END IF;
 IF NEW.operation='QUERY' THEN
  SELECT x.*,a.operation,a.profile_id,a.profile_sha256,a.key_version_ref INTO o FROM zzsh_order.joinpay_collection_observation x
   JOIN zzsh_order.joinpay_collection_attempt a ON a.id=x.attempt_id AND a.request_id=x.request_id WHERE x.id=NEW.origin_observation_id;
  IF o.id IS NULL OR o.request_id<>NEW.request_id OR o.operation<>'QUERY' OR o.event<>'E4' OR NOT o.response_complete OR o.http_status<>200
   OR o.transport_failure IS NOT NULL OR o.raw_sha256 IS DISTINCT FROM NEW.raw_sha256 OR o.profile_id IS DISTINCT FROM NEW.profile_id
   OR o.profile_sha256 IS DISTINCT FROM NEW.profile_sha256 OR o.key_version_ref IS DISTINCT FROM NEW.key_version_ref
  THEN RAISE EXCEPTION 'query evidence must reference its exact complete attempt' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.event='E4' THEN
  offset_text:=pdoc#>>ARRAY['operations',NEW.operation,'timeOffsetMinutes'];
  IF offset_text IS NULL OR offset_text!~'^-?[0-9]{1,3}$' THEN RAISE EXCEPTION 'formal provider timezone required' USING ERRCODE='23514';END IF;
  offset_minutes:=offset_text::integer;
  IF abs(offset_minutes)>840 OR NEW.provider_paid_at IS DISTINCT FROM (NEW.provider_paid_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>offset_minutes)
  THEN RAISE EXCEPTION 'formal provider time differs from explicit offset' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #12
CREATE TRIGGER joinpay_collection_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_collection_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_evidence();

--> statement-breakpoint
-- source joinpay-collection-source-schema #13
ALTER TABLE zzsh_order.payment_channel_transaction DROP CONSTRAINT payment_channel_transaction_evidence_level_check,
 ADD CONSTRAINT payment_channel_transaction_evidence_level_check CHECK(evidence_level IN('SYNTHETIC_PROTOCOL','CONTROLLED_TEST','JOINPAY_VERIFIED'));

--> statement-breakpoint
-- source joinpay-collection-source-schema #14
ALTER TABLE zzsh_order.payment_channel_transaction
 ALTER CONSTRAINT payment_channel_transaction_native_order_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

--> statement-breakpoint
-- source joinpay-collection-source-schema #15
CREATE FUNCTION zzsh_order.guard_joinpay_formal_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_VERIFIED' AND (NEW.channel<>'JOINPAY' OR NEW.confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id
  WHERE r.id=NEW.request_id AND r.order_id=NEW.native_order_id AND r.merchant_identity_id=NEW.merchant_identity_id
   AND b.formal_admission_ref IS NOT NULL AND e.event='E4' AND e.channel_trx_no=NEW.channel_trx_no))
 THEN RAISE EXCEPTION 'formal anchor requires admitted original successful evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #16
CREATE TRIGGER joinpay_formal_anchor_guard BEFORE INSERT ON zzsh_order.payment_channel_transaction
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_anchor();

--> statement-breakpoint
-- source joinpay-collection-source-schema #17
ALTER TABLE zzsh_order.payment_confirmation DROP CONSTRAINT payment_confirmation_source_check,
 ADD CONSTRAINT payment_confirmation_source_check CHECK(source IN('CONTROLLED','JOINPAY')),
 ADD COLUMN joinpay_request_id text,ADD COLUMN joinpay_evidence_id text,ADD COLUMN joinpay_anchor_id text REFERENCES zzsh_order.payment_channel_transaction(id),
 ADD CONSTRAINT payment_confirmation_joinpay_request_fk FOREIGN KEY(joinpay_request_id,order_id) REFERENCES zzsh_order.payment_request(id,order_id),
 ADD CONSTRAINT payment_confirmation_joinpay_evidence_fk FOREIGN KEY(joinpay_evidence_id,joinpay_request_id) REFERENCES zzsh_order.joinpay_collection_evidence(id,request_id),
 ADD CONSTRAINT payment_confirmation_source_shape CHECK(
  (source='CONTROLLED' AND joinpay_request_id IS NULL AND joinpay_evidence_id IS NULL AND joinpay_anchor_id IS NULL)
  OR(source='JOINPAY' AND currency='CNY' AND joinpay_request_id IS NOT NULL AND joinpay_evidence_id IS NOT NULL AND joinpay_anchor_id IS NOT NULL));

--> statement-breakpoint
-- source joinpay-collection-source-schema #18
CREATE FUNCTION zzsh_order.guard_joinpay_formal_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.id=NEW.joinpay_evidence_id
   JOIN zzsh_order.payment_channel_transaction a ON a.id=NEW.joinpay_anchor_id
  WHERE r.id=NEW.joinpay_request_id AND r.order_id=NEW.order_id AND r.channel='JOINPAY' AND b.formal_admission_ref IS NOT NULL
   AND r.channel_order_no=NEW.merchant_order_no AND r.amount_cents=NEW.amount_cents AND r.currency=NEW.currency
   AND r.merchant_identity_id=NEW.merchant_scope_id AND e.event='E4' AND e.channel_trx_no=NEW.provider_transaction_id
   AND e.provider_paid_at=NEW.provider_paid_at AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED'
   AND a.native_order_id=r.order_id AND a.request_id=r.id AND a.merchant_identity_id=NEW.merchant_scope_id AND a.channel_trx_no=NEW.provider_transaction_id)
 THEN RAISE EXCEPTION 'formal confirmation original evidence/funds mapping differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #19
CREATE TRIGGER joinpay_formal_confirmation_guard BEFORE INSERT ON zzsh_order.payment_confirmation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_confirmation();

--> statement-breakpoint
-- source joinpay-collection-source-schema #20
ALTER TABLE zzsh_order.joinpay_collection_observation DROP CONSTRAINT joinpay_collection_observation_state_after_check,
 ADD CONSTRAINT joinpay_collection_observation_state_after_check CHECK(state_after IN('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED',
  'REJECTED_BY_CHANNEL','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','ACCEPTED','REVIEW_REQUIRED'));

--> statement-breakpoint
-- source joinpay-collection-source-schema #21
CREATE FUNCTION zzsh_order.joinpay_formal_request_effect(request_id_value text,state_value text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
  JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.event='E4'
  WHERE r.id=request_id_value AND b.formal_admission_ref IS NOT NULL AND (
   state_value='ACCEPTED' AND EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='APPLIED')
   OR state_value='REVIEW_REQUIRED' AND (EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='REVIEW_REQUIRED')
    OR EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction a WHERE a.channel='JOINPAY' AND a.merchant_identity_id=r.merchant_identity_id
      AND a.channel_trx_no=e.channel_trx_no AND (a.native_order_id<>r.order_id OR a.request_id IS DISTINCT FROM r.id)))))
$$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #22
REVOKE ALL ON FUNCTION zzsh_order.joinpay_formal_request_effect(text,text) FROM PUBLIC;

--> statement-breakpoint
-- source joinpay-collection-source-schema #23
CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_order_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_row zzsh_order.rental_order;
BEGIN
 IF NEW.mode='NATIVE' THEN
  IF NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
   OR NEW.resource_marker<>'NATIVE_CREATED_ORDER_V1' OR NEW.created_by_admin_id IS NOT NULL
   OR NEW.source_admission_ref IS NULL OR NEW.revision<>1 OR NOT NEW.active OR NEW.admitted_at>clock_timestamp() OR NEW.expires_at<>'infinity'::timestamptz
   OR NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
    AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.oid<>d.datdba AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))
  THEN RAISE EXCEPTION 'native admission requires exact application runtime source' USING ERRCODE='23514';END IF;
  SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM zzsh_order.payment_request p WHERE p.order_id=NEW.order_id AND p.channel='JOINPAY' AND p.evidence_level='JOINPAY_CANDIDATE'
    AND p.state='SUBMITTING' AND p.revision=1 AND p.lease_version=0)
   OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.id=NEW.native_creation_audit_id AND a.action='order.reservation.created'
    AND a.object_type='rental_order' AND a.object_id=NEW.order_id AND a.actor_type='user' AND a.actor_id=order_row.renter_user_id AND a.outcome='SUCCESS')
  THEN RAISE EXCEPTION 'native admission requires original unpaid request creation' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$' OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.resource_marker IS DISTINCT FROM (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'order admission requires exact maintained order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event WHERE id=NEW.native_creation_audit_id AND action='order.reservation.created'
   AND object_type='rental_order' AND object_id=NEW.order_id AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'new native order origin/payment state is not proved' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #24
CREATE OR REPLACE FUNCTION zzsh_order.derive_payment_referral_inputs(order_id_value text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;v zzsh_order.distribution_policy_version;cfg jsonb;mode text;base numeric;minimum numeric;
 role_name text;party text;own zzsh_order.distribution_participant;relation zzsh_order.invitation_relation;
 parent_row record;graph_closed boolean;level jsonb;status text;pct text;n numeric;d numeric;scale integer;
 item jsonb;items jsonb[]:=ARRAY[]::jsonb[];raw_amounts numeric[]:=ARRAY[0::numeric,0::numeric];i integer;
 uncertain boolean;total numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_id_value;
 IF o.id IS NULL OR o.currency<>'CNY' THEN RAISE EXCEPTION 'original native CNY order required' USING ERRCODE='23514';END IF;
 SELECT p.* INTO v FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version p
  ON p.id=h.current_version_id AND p.scope=h.scope AND p.revision=h.revision WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.source='JOINPAY') THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;
 cfg:=v.canonical_config::jsonb;
 IF o.quote_snapshot->'schemaVersion'='2'::jsonb THEN mode:=o.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}';END IF;
 IF mode IS NULL OR mode NOT IN('ordinary','custom','fast') THEN mode:=NULL;END IF;
 IF o.quote_snapshot#>>'{platformFullProfit,currency}'='CNY'
  AND o.quote_snapshot#>>'{platformFullProfit,unit}'='yuan'
  AND o.quote_snapshot#>'{platformFullProfit,scale}'='2'::jsonb
  AND jsonb_typeof(o.quote_snapshot#>'{platformFullProfit,amount}')='string'
  AND COALESCE(o.quote_snapshot#>>'{platformFullProfit,amount}','')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$'
 THEN base:=(o.quote_snapshot#>>'{platformFullProfit,amount}')::numeric*100;END IF;
 FOREACH role_name IN ARRAY ARRAY['OWNER_REFERRAL','RENTER_REFERRAL'] LOOP
  party:=CASE WHEN role_name='OWNER_REFERRAL' THEN o.owner_user_id ELSE o.renter_user_id END;
  SELECT * INTO own FROM zzsh_order.distribution_participant WHERE user_id=party;
  SELECT * INTO relation FROM zzsh_order.invitation_relation WHERE child_user_id=party AND type='DISTRIBUTION_LEADER';
  SELECT p.*,CASE WHEN s.account_status IS NULL THEN NULL ELSE NOT u.suspended AND s.account_status='ACTIVE' END AS owner_active
   INTO parent_row FROM zzsh_order.distribution_participant p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
   LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id WHERE p.user_id=relation.parent_user_id;
  graph_closed:=false;
  IF relation.parent_user_id IS NOT NULL THEN
   WITH RECURSIVE chain(user_id,path,cyclic) AS (
    SELECT relation.parent_user_id,ARRAY[relation.parent_user_id],false UNION ALL
    SELECT r.parent_user_id,c.path||r.parent_user_id,r.parent_user_id=ANY(c.path)
     FROM chain c JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER' WHERE NOT c.cyclic
   ) SELECT COALESCE(bool_and(NOT c.cyclic AND COALESCE(
      p.leader_knowledge='KNOWN_NONE' AND r.parent_user_id IS NULL
      OR p.leader_knowledge='KNOWN_PARENT' AND r.parent_user_id IS NOT NULL,false)),false)
    INTO graph_closed FROM chain c LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=c.user_id
    LEFT JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER';
  END IF;
  pct:=NULL;n:=NULL;d:=NULL;level:=NULL;
  IF v.id IS NULL THEN status:='UNKNOWN_POLICY';
  ELSIF cfg->'enabled'<>'true'::jsonb THEN status:='SKIPPED_DISABLED';
  ELSIF mode IS NULL THEN status:='UNKNOWN_MODE';
  ELSIF mode='fast' THEN status:='SKIPPED_FAST';
  ELSIF NOT(cfg->'accountModes' ? mode) THEN status:='SKIPPED_MODE';
  ELSIF own.leader_knowledge='KNOWN_NONE' AND relation.id IS NULL THEN status:='SKIPPED_NO_PARENT';
  ELSIF own.leader_knowledge IS DISTINCT FROM 'KNOWN_PARENT' OR relation.id IS NULL OR NOT graph_closed
    OR relation.parent_user_id=party OR relation.source_digest IS NULL THEN status:='UNKNOWN_RELATION';
  ELSIF parent_row.user_id IS NULL OR parent_row.owner_active IS NULL OR parent_row.eligibility='UNKNOWN'
    OR parent_row.commission_frozen IS NULL THEN status:='UNKNOWN_PARTICIPANT';
  ELSIF NOT parent_row.owner_active OR parent_row.eligibility='INELIGIBLE' OR parent_row.commission_frozen THEN status:='SKIPPED_INELIGIBLE';
  ELSE
   SELECT value INTO level FROM jsonb_array_elements(cfg->'levels') WHERE value->>'code'=parent_row.level_code;
   IF level IS NULL THEN status:='UNKNOWN_LEVEL';
   ELSE
    pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN level->>'ownerPercent' ELSE level->>'renterPercent' END;
    scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
    n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
    status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
   END IF;
  END IF;
  item:=jsonb_build_object('role',role_name,'partyUserId',party,'status',status,
   'beneficiaryUserId',parent_row.user_id,'relationId',relation.id,'relationDigest',relation.source_digest,
   'levelCode',parent_row.level_code,'percent',pct,'ratio',CASE WHEN pct IS NULL THEN NULL ELSE jsonb_build_object('numerator',n::numeric(24,0)::text,'denominator',d::numeric(24,0)::text) END,'estimatedCents',NULL);
  items:=array_append(items,item);
 END LOOP;
 IF v.id IS NOT NULL AND base IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM unnest(items) r WHERE r->>'status' LIKE 'UNKNOWN%') INTO uncertain;
  IF NOT uncertain THEN
   FOR i IN 1..2 LOOP
    IF items[i]->>'status'='ELIGIBLE' THEN raw_amounts[i]:=floor(base*(items[i]#>>'{ratio,numerator}')::numeric/(items[i]#>>'{ratio,denominator}')::numeric+0.5);END IF;
   END LOOP;
  END IF;
  total:=raw_amounts[1]+raw_amounts[2];minimum:=(cfg->>'minimumAccrualCents')::numeric;
  FOR i IN 1..2 LOOP
   IF items[i]->>'status'='ELIGIBLE' THEN
    IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);
    ELSE items[i]:=jsonb_set(items[i],'{estimatedCents}',to_jsonb(raw_amounts[i]::numeric(24,0)::text));END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('policyVersion',v.id,'policyDigest',v.config_digest,'policyConfig',cfg,'accountMode',mode,
  'estimateBaseCents',CASE WHEN base IS NULL THEN NULL ELSE base::numeric(24,0)::text END,'roles',to_jsonb(items));
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #25
CREATE OR REPLACE FUNCTION zzsh_order.check_applied_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disposition = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.rental_order o
      JOIN zzsh_order.im_order_group g ON g.order_id=o.id AND g.payment_confirmation_id=NEW.id
     WHERE o.id=NEW.order_id AND o.paid_confirmation_id=NEW.id AND o.status='PAID'
       AND ((NEW.source='CONTROLLED' AND o.display_no=NEW.merchant_order_no)
        OR(NEW.source='JOINPAY' AND EXISTS(SELECT 1 FROM zzsh_order.payment_request r WHERE r.id=NEW.joinpay_request_id AND r.order_id=o.id AND r.channel_order_no=NEW.merchant_order_no))) AND o.currency=NEW.currency
       AND o.rental_amount_cents+o.deposit_amount_cents=NEW.amount_cents
       AND o.paid_at=NEW.accepted_at AND o.paid_at < o.hold_until
  ) THEN
    RAISE EXCEPTION 'applied payment must match paid order and waiting intent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #26
CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_collection_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN('ACCEPTED','REVIEW_REQUIRED')
  AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.id=current_setting('zzsh.joinpay_evidence',true) AND e.request_id=NEW.id AND e.event='E4')
  AND zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) THEN
  IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal acceptance cannot change worker lease' USING ERRCODE='40001';END IF;
  RETURN NEW;
 END IF;
 IF NEW.state='ACCEPTED' THEN RAISE EXCEPTION 'collection evidence cannot accept payment' USING ERRCODE='23514'; END IF;
 IF NEW.lease_version=OLD.lease_version+1 THEN
  IF NEW.state<>OLD.state OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
   OR OLD.state NOT IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED')
   OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
   OR NEW.lease_until>clock_timestamp()+interval '3600 seconds' THEN
   RAISE EXCEPTION 'collection lease is not claimable' USING ERRCODE='40001';
  END IF;
 ELSIF NEW.lease_version=OLD.lease_version THEN
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   OR OLD.lease_until IS NULL THEN
   RAISE EXCEPTION 'collection result lease binding changed' USING ERRCODE='40001';
  END IF;
  IF OLD.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='40001',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
 ELSE RAISE EXCEPTION 'collection lease must advance once' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #27
CREATE OR REPLACE FUNCTION zzsh_order.check_joinpay_collection_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_CANDIDATE' AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_binding WHERE request_id=NEW.id) THEN
  RAISE EXCEPTION 'collection request requires immutable wire evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.evidence_level='JOINPAY_CANDIDATE' THEN
  IF NEW.lease_version>OLD.lease_version AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_attempt WHERE request_id=NEW.id AND lease_version=NEW.lease_version AND lease_owner=NEW.lease_owner) THEN
   RAISE EXCEPTION 'collection lease requires a committed attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) AND NOT EXISTS(
   SELECT 1 FROM zzsh_order.joinpay_collection_observation o JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id
   WHERE o.request_id=NEW.id AND a.lease_version=NEW.lease_version AND o.state_before=OLD.state AND o.state_after=NEW.state AND o.event<>'E9') THEN
   RAISE EXCEPTION 'collection transition requires its raw observation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #28
CREATE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NEW.disposition='APPLIED' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.payment_distribution_basis b ON b.order_id=r.order_id AND b.payment_confirmation_id=NEW.id
   JOIN zzsh_order.distribution_order_admission a ON a.id=b.admission_id AND a.order_id=b.order_id AND a.revision=b.admission_revision
  WHERE r.id=NEW.joinpay_request_id AND r.state='ACCEPTED' AND a.mode='NATIVE' AND a.active)
 THEN RAISE EXCEPTION 'formal APPLIED requires same-transaction accepted request and complete native basis' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- source joinpay-collection-source-schema #29
CREATE CONSTRAINT TRIGGER joinpay_formal_confirmation_closure AFTER INSERT ON zzsh_order.payment_confirmation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure();
