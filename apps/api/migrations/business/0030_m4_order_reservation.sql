-- M4-A order reservation foundation: pending-payment orders and atomic account
-- occupancy. Additive only; no writes to existing tables.
CREATE SCHEMA IF NOT EXISTS "zzsh_order";

CREATE SEQUENCE "zzsh_order"."display_no_seq";

-- Display number: at least six digits, never truncated (B6).
CREATE FUNCTION "zzsh_order"."next_display_no"() RETURNS text LANGUAGE sql AS $$
  SELECT 'ZZ' || to_char(clock_timestamp(), 'YYMMDD-') ||
         CASE WHEN v < 1000000 THEN lpad(v::text, 6, '0') ELSE v::text END
    FROM (SELECT nextval('zzsh_order.display_no_seq') AS v) s
$$;

CREATE TABLE "zzsh_order"."rental_order" (
  "id" text PRIMARY KEY,
  "display_no" text NOT NULL UNIQUE,
  "account_id" text NOT NULL,
  "listing_version_id" text NOT NULL,
  "owner_user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "renter_user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "rule_release_id" text NOT NULL REFERENCES "zzsh_supply"."rule_release"("id"),
  "content_hash" text NOT NULL CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "term_option_code" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('PENDING_PAYMENT','CANCELLED')),
  "rental_amount_cents" numeric(24,0) NOT NULL CHECK ("rental_amount_cents" >= 0),
  "deposit_amount_cents" numeric(24,0) NOT NULL CHECK ("deposit_amount_cents" >= 0),
  "currency" text NOT NULL DEFAULT 'CNY' CHECK ("currency" = 'CNY'),
  "term_seconds" bigint NOT NULL CHECK ("term_seconds" > 0),
  "quote_snapshot" jsonb NOT NULL,
  "title" text NOT NULL,
  "hold_until" timestamptz NOT NULL,
  "cancel_reason" text CHECK ("cancel_reason" IN ('USER','TIMEOUT')),
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  CONSTRAINT "rental_order_account_owner_fk" FOREIGN KEY ("account_id","owner_user_id") REFERENCES "zzsh_supply"."rental_account"("id","owner_user_id"),
  CONSTRAINT "rental_order_listing_account_fk" FOREIGN KEY ("listing_version_id","account_id") REFERENCES "zzsh_supply"."listing_version"("id","account_id"),
  CONSTRAINT "rental_order_renter_not_owner" CHECK ("renter_user_id" <> "owner_user_id"),
  CONSTRAINT "rental_order_cancel_shape" CHECK (
    ("status" = 'CANCELLED' AND "cancel_reason" IS NOT NULL AND "cancelled_at" IS NOT NULL)
    OR ("status" = 'PENDING_PAYMENT' AND "cancel_reason" IS NULL AND "cancelled_at" IS NULL)
  )
);

-- Atomic occupancy: at most one occupying order per rental account.
CREATE UNIQUE INDEX "rental_order_single_occupancy" ON "zzsh_order"."rental_order" ("account_id") WHERE "status" = 'PENDING_PAYMENT';
-- Expiry scan for the sweeper.
CREATE INDEX "rental_order_expiry_scan" ON "zzsh_order"."rental_order" ("hold_until", "id") WHERE "status" = 'PENDING_PAYMENT';
CREATE INDEX "rental_order_renter_list" ON "zzsh_order"."rental_order" ("renter_user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "rental_order_owner_list" ON "zzsh_order"."rental_order" ("owner_user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "rental_order_admin_list" ON "zzsh_order"."rental_order" ("game_id", "status", "id");

CREATE FUNCTION "zzsh_order"."guard_rental_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap_currency text;
  snap_deposit_policy text;
  snap_rental text;
  snap_deposit text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_PAYMENT' THEN
      RAISE EXCEPTION 'rental order must start as PENDING_PAYMENT' USING ERRCODE = '40001';
    END IF;
    snap_currency := NEW.quote_snapshot ->> 'currency';
    snap_deposit_policy := NEW.quote_snapshot #>> '{pricingInputs,depositPolicy}';
    snap_rental := NEW.quote_snapshot #>> '{resourceTotal,amount}';
    snap_deposit := NEW.quote_snapshot #>> '{tenantDeposit,amount}';
    IF snap_currency IS DISTINCT FROM 'CNY' OR NEW.currency <> 'CNY' THEN
      RAISE EXCEPTION 'rental order snapshot currency is not CNY' USING ERRCODE = '40001';
    END IF;
    IF snap_deposit_policy IS DISTINCT FROM 'CONFIGURED' THEN
      RAISE EXCEPTION 'rental order snapshot deposit policy is not CONFIGURED' USING ERRCODE = '40001';
    END IF;
    -- Strict textual validation first; the standard numeric cast is only applied
    -- to values that already match the checked shape.
    IF snap_rental IS NULL OR snap_deposit IS NULL
       OR snap_rental !~ '^(0|[1-9]\d*)\.\d{2}$' OR snap_deposit !~ '^(0|[1-9]\d*)\.\d{2}$' THEN
      RAISE EXCEPTION 'rental order snapshot amounts are incomplete' USING ERRCODE = '40001';
    END IF;
    IF NEW.rental_amount_cents <> CAST(replace(snap_rental, '.', '') AS numeric)
       OR NEW.deposit_amount_cents <> CAST(replace(snap_deposit, '.', '') AS numeric) THEN
      RAISE EXCEPTION 'rental order amounts do not match the snapshot' USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.display_no, NEW.account_id, NEW.listing_version_id, NEW.owner_user_id,
      NEW.renter_user_id, NEW.game_id, NEW.rule_release_id, NEW.content_hash, NEW.term_option_code,
      NEW.rental_amount_cents, NEW.deposit_amount_cents, NEW.currency, NEW.term_seconds,
      NEW.quote_snapshot, NEW.title, NEW.hold_until)
     IS DISTINCT FROM
     (OLD.id, OLD.display_no, OLD.account_id, OLD.listing_version_id, OLD.owner_user_id,
      OLD.renter_user_id, OLD.game_id, OLD.rule_release_id, OLD.content_hash, OLD.term_option_code,
      OLD.rental_amount_cents, OLD.deposit_amount_cents, OLD.currency, OLD.term_seconds,
      OLD.quote_snapshot, OLD.title, OLD.hold_until) THEN
    RAISE EXCEPTION 'rental order snapshot is immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status = 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rental_order_guard BEFORE INSERT OR UPDATE ON "zzsh_order"."rental_order"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_order"."guard_rental_order"();

-- order.read is registered only; no preset role receives it. Boss gets every
-- registered permission through the existing mechanism. Regular customer-service
-- admins get no default order visibility (assignment/collaboration come later).
INSERT INTO zzsh_iam.admin_permission(code, name, description) VALUES
  ('order.read', '订单查询', '按授权范围查询订单')
ON CONFLICT(code) DO NOTHING;
