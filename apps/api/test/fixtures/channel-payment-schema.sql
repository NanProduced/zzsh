-- PAY-03A 测试专用 fixture（DRAFT）：三关系 DDL 与约束。
-- 仅可在支付 Master 签发窗口内、由隔离库迁移角色在固定 91 份迁移之后执行；
-- 不是正式迁移，不占编号，不进 journal，不得成为默认启动迁移。
-- 执行前须由调用方以 set_config('zzsh.pay03a_runtime_role', <运行角色>, true) 指定授权对象。

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

-- 观察与归属锚点只追加；请求只允许状态/租约/修订变化
CREATE FUNCTION zzsh_order.guard_channel_payment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'channel payment observation/anchor is append-only' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER payment_channel_observation_append_only BEFORE UPDATE OR DELETE ON zzsh_order.payment_channel_observation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();
CREATE TRIGGER payment_channel_transaction_append_only BEFORE UPDATE OR DELETE ON zzsh_order.payment_channel_transaction
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

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
CREATE TRIGGER payment_request_guard BEFORE UPDATE OR DELETE ON zzsh_order.payment_request
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request();

-- 新请求必须从 SUBMITTING、修订 1、无租约开始
CREATE FUNCTION zzsh_order.guard_payment_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'SUBMITTING' OR NEW.revision <> 1 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL THEN
    RAISE EXCEPTION 'payment request must start as SUBMITTING' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_request_insert_guard BEFORE INSERT ON zzsh_order.payment_request
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request_insert();

-- 锚点关联 confirmation 时，来源/商户/流水/订单必须与 0036 原件完全一致
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
CREATE CONSTRAINT TRIGGER payment_channel_transaction_confirmation_guard
  AFTER INSERT ON zzsh_order.payment_channel_transaction DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_channel_transaction_confirmation();

-- 运行角色：请求可插入/更新（受触发器约束），观察与锚点仅插入；无 DELETE/TRUNCATE
DO $$
DECLARE runtime_role text := current_setting('zzsh.pay03a_runtime_role', false);
BEGIN
  IF runtime_role !~ '^zzsh_order_[a-z][a-z0-9_]{0,20}_r$' THEN
    RAISE EXCEPTION 'pay03a runtime role not set to an isolated order role' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON zzsh_order.payment_request TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON zzsh_order.payment_channel_observation TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON zzsh_order.payment_channel_transaction TO %I', runtime_role);
END $$;
