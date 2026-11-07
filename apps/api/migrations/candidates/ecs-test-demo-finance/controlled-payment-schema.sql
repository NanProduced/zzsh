-- The production baseline omits local-controlled declarations. Install only
-- this narrow source table on a verified demo copy; it never records JOINPAY evidence.
DO $guard$
DECLARE d record;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(db.oid,'pg_database') AS marker INTO d
   FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test-demo-finance:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE OR d.owner<>current_user
   OR to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL THEN
   RAISE EXCEPTION 'Exact registered demo database owner required';
 END IF;
END
$guard$;
CREATE TABLE zzsh_order.controlled_payment_declaration (
 id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
 mode text NOT NULL CHECK (mode='LOCAL_CONTROLLED_DECLARED_PAYMENT'),
 source_event_key text NOT NULL UNIQUE,
 resource_oid oid NOT NULL,
 app_id text NOT NULL CHECK (app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 merchant_scope_id text NOT NULL CHECK (merchant_scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 admission_id text NOT NULL,
 admission_revision bigint NOT NULL,
 order_id text NOT NULL,
 merchant_order_no text NOT NULL,
 provider_transaction_id text NOT NULL,
 canonical_payment text NOT NULL CHECK (jsonb_typeof(canonical_payment::jsonb)='object'),
 payment_digest text NOT NULL CHECK (payment_digest=encode(sha256(convert_to(canonical_payment,'UTF8')),'hex')),
 approval_digest text NOT NULL CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
 declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(merchant_scope_id,provider_transaction_id),
 FOREIGN KEY(admission_id,order_id,admission_revision) REFERENCES zzsh_order.distribution_order_admission(id,order_id,revision)
);
COMMENT ON TABLE zzsh_order.controlled_payment_declaration IS '测试环境的模拟付款声明；不是第三方渠道付款或银行到账凭据。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.id IS '模拟付款声明的内部标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.mode IS '声明来源类型，限定为受控测试。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.source_event_key IS '模拟付款事件的幂等标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.resource_oid IS '声明所属测试数据库 OID。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.app_id IS '订单履约使用的云信应用标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.merchant_scope_id IS '模拟付款的测试命名空间，不是商户号。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.admission_id IS '绑定的测试订单准入标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.admission_revision IS '绑定的测试订单准入修订号。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.order_id IS '模拟付款对应的新平台订单标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.merchant_order_no IS '订单原编号，仅作订单关联。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.provider_transaction_id IS '模拟事件编号，不是渠道流水号。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.canonical_payment IS '冻结的测试付款字段规范化内容。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.payment_digest IS '冻结测试付款内容的 SHA-256 摘要。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.approval_digest IS '对应测试环境登记内容的摘要。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.created_by_admin_id IS '测试环境登记关联的管理员标识。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.reason IS '该模拟事件的来源说明。';
COMMENT ON COLUMN zzsh_order.controlled_payment_declaration.declared_at IS '数据库记录该模拟声明的时间。';
CREATE TRIGGER controlled_payment_declaration_immutable BEFORE UPDATE OR DELETE
 ON zzsh_order.controlled_payment_declaration FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER controlled_payment_declaration_no_truncate BEFORE TRUNCATE
 ON zzsh_order.controlled_payment_declaration EXECUTE FUNCTION zzsh_order.finance_immutable();
REVOKE ALL ON TABLE zzsh_order.controlled_payment_declaration FROM PUBLIC;
