-- Historical read facts only. Native reservations/payments/openings stay intact.
CREATE TABLE zzsh_order.legacy_order_read_snapshot (
  id text PRIMARY KEY,
  source_system text NOT NULL CHECK (source_system='legacy_mysql_restore'),
  source_entity text NOT NULL CHECK (source_entity='la_order'),
  legacy_id text NOT NULL CHECK (length(legacy_id) BETWEEN 1 AND 128),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  original_order_no text NOT NULL CHECK (length(original_order_no) BETWEEN 1 AND 255),
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  renter_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  legacy_account_id text NOT NULL,
  legacy_account_entity text NOT NULL CHECK (legacy_account_entity='la_rental_accounts'),
  legacy_account_source_digest text NOT NULL CHECK (legacy_account_source_digest ~ '^[a-f0-9]{64}$'),
  legacy_account_no text,
  legacy_owner_id text NOT NULL,
  legacy_owner_no text,
  owner_source_digest text NOT NULL CHECK (owner_source_digest ~ '^[a-f0-9]{64}$'),
  legacy_renter_id text NOT NULL,
  legacy_renter_no text,
  renter_source_digest text NOT NULL CHECK (renter_source_digest ~ '^[a-f0-9]{64}$'),
  source_order_status integer NOT NULL,
  source_pay_status integer NOT NULL,
  source_created_at timestamptz,
  source_paid_at timestamptz,
  source_cancelled_at timestamptz,
  source_completed_at timestamptz,
  due_amount_cents numeric CHECK (due_amount_cents=trunc(due_amount_cents) AND abs(due_amount_cents)<1e25),
  recorded_paid_amount_cents numeric CHECK (recorded_paid_amount_cents=trunc(recorded_paid_amount_cents) AND abs(recorded_paid_amount_cents)<1e25),
  deposit_amount_cents numeric CHECK (deposit_amount_cents=trunc(deposit_amount_cents) AND abs(deposit_amount_cents)<1e25),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  snapshot_schema_version integer NOT NULL CHECK (snapshot_schema_version=1),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_system,source_entity,legacy_id),
  FOREIGN KEY(source_system,legacy_account_entity,legacy_account_id)
    REFERENCES zzsh_supply.legacy_supply_map(source_system,source_entity,legacy_id)
);
CREATE INDEX legacy_order_read_no ON zzsh_order.legacy_order_read_snapshot(original_order_no);
CREATE INDEX legacy_order_read_scope ON zzsh_order.legacy_order_read_snapshot(game_id,source_created_at DESC NULLS LAST,id DESC);
CREATE INDEX legacy_order_read_renter ON zzsh_order.legacy_order_read_snapshot(renter_user_id,source_created_at DESC NULLS LAST,id DESC);
CREATE INDEX legacy_order_read_owner ON zzsh_order.legacy_order_read_snapshot(owner_user_id,source_created_at DESC NULLS LAST,id DESC);
CREATE INDEX legacy_order_read_account ON zzsh_order.legacy_order_read_snapshot(account_id);

CREATE FUNCTION zzsh_order.guard_legacy_order_read_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE party record; field_name text; field_value text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id
    WHERE a.id=NEW.account_id AND a.game_id=NEW.game_id
      AND m.source_system=NEW.source_system AND m.source_entity=NEW.legacy_account_entity
      AND m.legacy_id=NEW.legacy_account_id AND m.source_digest=NEW.legacy_account_source_digest
  ) THEN RAISE EXCEPTION 'Legacy account/game/source binding is invalid' USING ERRCODE='23514'; END IF;
  FOR party IN SELECT * FROM (VALUES
    (NEW.owner_user_id,NEW.legacy_owner_id,NEW.owner_source_digest),
    (NEW.renter_user_id,NEW.legacy_renter_id,NEW.renter_source_digest)
  ) AS p(user_id,legacy_id,source_digest)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM zzsh_iam.user_identity_state i JOIN zzsh_iam.audit_event e ON e.object_id=i.user_id
      WHERE i.user_id=party.user_id AND i.provider='legacy_mysql_restore'
        AND i.provider_reference='la_user:'||party.legacy_id
        AND e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS'
        AND e.details->>'sourceSystem'=NEW.source_system AND e.details->>'sourceEntity'='la_user'
        AND e.details->>'legacyId'=party.legacy_id AND e.details->>'sourceDigest'=party.source_digest
    ) THEN RAISE EXCEPTION 'Legacy party/source binding is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Historical ownership is separate from the account's current owner.
  IF NEW.source_snapshot->>'id' IS DISTINCT FROM NEW.legacy_id
    OR NEW.source_snapshot->>'order_sn' IS DISTINCT FROM NEW.original_order_no
    OR NEW.source_snapshot->>'accounts_id' IS DISTINCT FROM NEW.legacy_account_id
    OR NEW.source_snapshot->>'user_id' IS DISTINCT FROM NEW.legacy_renter_id
    OR NEW.source_snapshot->>'sale_user_id' IS DISTINCT FROM NEW.legacy_owner_id
    OR NEW.source_snapshot->>'order_status' IS DISTINCT FROM NEW.source_order_status::text
    OR NEW.source_snapshot->>'pay_is' IS DISTINCT FROM NEW.source_pay_status::text
  THEN RAISE EXCEPTION 'Legacy source snapshot does not match its binding' USING ERRCODE='23514'; END IF;
  FOREACH field_name IN ARRAY ARRAY['money','goods_money','expend_pay_money','need_pay_money','pay_money','deposit_amount','return_order_money','sale_earnings','commission_money','full_payout_money']
  LOOP
    field_value:=NEW.source_snapshot->>field_name;
    IF field_value IS NOT NULL AND field_value !~ '^-?(0|[1-9][0-9]{0,22})\.[0-9]{2}$'
    THEN RAISE EXCEPTION 'Legacy money shape is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH field_name IN ARRAY ARRAY['awm_bullet_num','level6_bullet_num','level6_helmet_num','level6_armor_num','top_insure_card_num','barrett_bullet_num','coffee_num']
  LOOP
    field_value:=NEW.source_snapshot->>field_name;
    IF field_value IS NOT NULL AND field_value !~ '^(0|[1-9][0-9]{0,23})$'
    THEN RAISE EXCEPTION 'Legacy quantity shape is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF NEW.due_amount_cents IS DISTINCT FROM (NEW.source_snapshot->>'need_pay_money')::numeric*100
    OR NEW.deposit_amount_cents IS DISTINCT FROM (NEW.source_snapshot->>'deposit_amount')::numeric*100
    OR NEW.recorded_paid_amount_cents IS DISTINCT FROM (CASE WHEN NEW.source_pay_status=1 THEN (NEW.source_snapshot->>'pay_money')::numeric*100 ELSE NULL END)
  THEN RAISE EXCEPTION 'Legacy amount/source binding is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_order_read_binding BEFORE INSERT ON zzsh_order.legacy_order_read_snapshot
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_order_read_binding();
CREATE TRIGGER legacy_order_read_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_order_read_snapshot
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();

CREATE FUNCTION zzsh_order.check_legacy_order_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event e
    WHERE e.action='order.legacy.read_imported' AND e.object_id=NEW.id AND e.actor_id=NEW.created_by_admin_id
      AND e.outcome='SUCCESS' AND e.details->>'sourceSystem'=NEW.source_system
      AND e.details->>'sourceEntity'=NEW.source_entity AND e.details->>'legacyId'=NEW.legacy_id
      AND e.details->>'sourceDigest'=NEW.source_digest AND e.details->>'bindingDigest'=NEW.binding_digest)
  THEN RAISE EXCEPTION 'Legacy order import audit is missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_order_read_audit AFTER INSERT ON zzsh_order.legacy_order_read_snapshot
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_order_read_audit();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM zzsh_iam.admin_permission WHERE
    (code='user.directory.read' AND (name<>'用户目录读取' OR description<>'读取受权用户目录及基础关联')) OR
    (code='supply.rental_account.read' AND (name<>'资源账号读取' OR description<>'读取受权资源账号和归属关联')))
  THEN RAISE EXCEPTION 'Existing read permission definition requires review'; END IF;
END $$;
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('user.directory.read','用户目录读取','读取受权用户目录及基础关联'),
 ('supply.rental_account.read','资源账号读取','读取受权资源账号和归属关联')
ON CONFLICT(code) DO NOTHING;
