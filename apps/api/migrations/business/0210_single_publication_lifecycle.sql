-- A delisted account remains a historical record; a new listing needs a new account.
ALTER TABLE zzsh_supply.rental_account
  DROP CONSTRAINT rental_account_lifecycle_check,
  ADD CONSTRAINT rental_account_lifecycle_check CHECK (lifecycle IN ('ACTIVE','ARCHIVED','DELISTED'));

ALTER TABLE zzsh_order.rental_order
  DROP CONSTRAINT rental_order_cancel_reason_check,
  ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN
    ('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND','SUPPORT_UNPAID','SUPPORT_AFTER_START_CANCELLED','OWNER_DELISTED')),
  DROP CONSTRAINT rental_order_payment_shape,
  ADD CONSTRAINT rental_order_payment_shape CHECK(
    (status IN('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR (status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
    OR (status='CANCELLED' AND (
      (cancel_reason IN('PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND','SUPPORT_AFTER_START_CANCELLED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
      OR (cancel_reason IN('USER','TIMEOUT','SUPPORT_UNPAID','OWNER_DELISTED') AND paid_confirmation_id IS NULL AND paid_at IS NULL))));

-- One actual publication per account; rejected and withdrawn drafts remain editable.
CREATE UNIQUE INDEX listing_publication_one_per_account ON zzsh_supply.listing_publication(account_id);
CREATE INDEX legacy_supply_map_account_source_idx ON zzsh_supply.legacy_supply_map(account_id,source_system,source_entity);

CREATE FUNCTION zzsh_supply.guard_legacy_delta_republication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.game g ON g.id=a.game_id
    JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id
    WHERE a.id=NEW.account_id AND g.code='delta' AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts') THEN
    RAISE EXCEPTION 'migrated delta account requires a new listing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_legacy_delta_republication_guard BEFORE INSERT ON zzsh_supply.listing_publication
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_delta_republication();
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_delta_republication() FROM PUBLIC;

CREATE FUNCTION zzsh_supply.guard_delisted_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle='DELISTED' AND NEW.lifecycle IS DISTINCT FROM 'DELISTED' THEN
    RAISE EXCEPTION 'delisted account cannot be republished' USING ERRCODE='23514';
  END IF;
  IF NEW.lifecycle='DELISTED' AND OLD.lifecycle IS DISTINCT FROM 'DELISTED'
    AND EXISTS (SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=NEW.id AND o.status IN ('PENDING_PAYMENT','PAID')) THEN
    RAISE EXCEPTION 'delisted account has an active order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_account_delisted_guard BEFORE UPDATE OF lifecycle ON zzsh_supply.rental_account
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_delisted_account();
REVOKE ALL ON FUNCTION zzsh_supply.guard_delisted_account() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_supply.guard_delisted_account() IS '下架账号保留历史，禁止恢复或带有效订单下架。';
COMMENT ON INDEX zzsh_supply.listing_publication_one_per_account IS '每条出租账号记录只能形成一次正式上架。';
COMMENT ON INDEX zzsh_supply.legacy_supply_map_account_source_idx IS '按目标账号和来源识别迁入供给。';
COMMENT ON FUNCTION zzsh_supply.guard_legacy_delta_republication() IS '迁入的三角洲账号保留历史，重新出租需创建新账号。';
COMMENT ON CONSTRAINT rental_account_lifecycle_check ON zzsh_supply.rental_account IS 'ACTIVE可接单；ARCHIVED租约完结；DELISTED号主主动下架。';
COMMENT ON CONSTRAINT rental_order_cancel_reason_check ON zzsh_order.rental_order IS '取消原因包括号主下架导致的待付款订单关闭。';
COMMENT ON CONSTRAINT rental_order_payment_shape ON zzsh_order.rental_order IS '已付款及取消订单的付款引用与取消原因一致。';
COMMENT ON TRIGGER listing_legacy_delta_republication_guard ON zzsh_supply.listing_publication IS '迁入的三角洲账号不得再次发布。';
COMMENT ON TRIGGER rental_account_delisted_guard ON zzsh_supply.rental_account IS '主动下架后不可恢复，且不能保留活跃订单。';

-- Retire the dedicated duplicate-hint capability, while retaining historical records and audit facts.
DELETE FROM zzsh_iam.admin_user_permission WHERE permission_code='supply.duplicate.review';
DELETE FROM zzsh_iam.admin_role_permission WHERE permission_code='supply.duplicate.review';
DELETE FROM zzsh_iam.admin_permission WHERE code='supply.duplicate.review';
