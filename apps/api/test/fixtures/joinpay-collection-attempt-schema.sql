-- 未编号前向测试候选：以已接受的三关系fixture为前置，不安装、不登记journal、不启渠道。
-- 三张表分别保存原始wire绑定、已提交发送尝试和完整响应原件；均不是正式付款确认。
ALTER TABLE zzsh_order.payment_request DROP CONSTRAINT payment_request_evidence_level_check;
ALTER TABLE zzsh_order.payment_request ADD CONSTRAINT payment_request_evidence_level_check
  CHECK (evidence_level IN ('SYNTHETIC_PROTOCOL','CONTROLLED_TEST','JOINPAY_CANDIDATE'));

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

CREATE TRIGGER joinpay_collection_binding_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();
CREATE TRIGGER joinpay_collection_attempt_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();
CREATE TRIGGER joinpay_collection_observation_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

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
CREATE TRIGGER joinpay_collection_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();
CREATE TRIGGER joinpay_collection_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_collection_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();

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
CREATE TRIGGER joinpay_collection_request_guard BEFORE UPDATE ON zzsh_order.payment_request
 FOR EACH ROW WHEN (OLD.evidence_level='JOINPAY_CANDIDATE') EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_request();

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
CREATE CONSTRAINT TRIGGER joinpay_collection_request_closure AFTER INSERT OR UPDATE ON zzsh_order.payment_request
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_collection_closure();

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
CREATE TRIGGER joinpay_collection_observation_guard BEFORE INSERT ON zzsh_order.joinpay_collection_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_observation();

-- 精确ACL提案；后续共同宽GRANT后也须收敛。此DO块只在新授权窗口内使用，不是默认启动动作。
DO $$
DECLARE runtime_role text:=current_setting('zzsh.collection_runtime_role',false); table_name text; columns text;
BEGIN
 IF runtime_role !~ '^[a-z][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'collection runtime role required' USING ERRCODE='22023'; END IF;
 FOREACH table_name IN ARRAY ARRAY['joinpay_collection_binding','joinpay_collection_attempt','joinpay_collection_observation'] LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid=('zzsh_order.'||table_name)::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL ON TABLE zzsh_order.%I FROM %I',table_name,runtime_role);
  EXECUTE format('REVOKE ALL (%s) ON TABLE zzsh_order.%I FROM %I',columns,table_name,runtime_role);
  EXECUTE format('GRANT SELECT ON TABLE zzsh_order.%I TO %I',table_name,runtime_role);
 END LOOP;
 EXECUTE format('GRANT INSERT(request_id,wire_merchant_no,trade_merchant_no,product_name,notify_url,initial_profile_sha256,evidence_mode) ON zzsh_order.joinpay_collection_binding TO %I',runtime_role);
 EXECUTE format('GRANT INSERT(id,request_id,lease_version,lease_owner,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,evidence_mode,request_body,request_sha256) ON zzsh_order.joinpay_collection_attempt TO %I',runtime_role);
 EXECUTE format('GRANT INSERT(id,attempt_id,request_id,raw_body,raw_sha256,http_status,response_complete,received_bytes,transport_failure,event,result,schema_outcome,signature_outcome,binding_outcome,verified,state_before,state_after,channel_status,provider_paid_at_raw,channel_trx_no) ON zzsh_order.joinpay_collection_observation TO %I',runtime_role);
END $$;
