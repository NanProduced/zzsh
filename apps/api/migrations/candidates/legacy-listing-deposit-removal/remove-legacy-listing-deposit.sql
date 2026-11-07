-- Candidate, UNNUMBERED. Per the Root migration ruling, new SQL is submitted without a number and
-- Root assigns the final sequence; do not add this to meta/_journal.json here.
--
-- Retires the old platform's listing deposit (上架保证金). The owner confirmed the old platform has
-- no outstanding listing deposit, so the new platform keeps neither its data nor its runtime logic.
-- This only removes the two legacy tables and their own guard functions; the new platform's own
-- guarantee tables (owner_guarantee_requirement / _payment / _refund / _reconciliation) and
-- zzsh_supply.account_guarantee_proof are a different business and must stay untouched.
--
-- Forward only, replayable, and safe on an already-migrated database: every step is guarded, and the
-- whole file refuses to run if anything unexpected depends on the tables.

DO $legacy_listing_deposit_preflight$
DECLARE
  dependent_views text;
  dependent_functions text;
  unexpected_columns text;
BEGIN
  -- Any view over the retired tables means someone still reads them: stop instead of guessing.
  SELECT string_agg(DISTINCT v.relname, ', ') INTO dependent_views
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_class t ON t.oid = d.refobjid
  WHERE t.relname IN ('legacy_owner_guarantee_observation','legacy_owner_guarantee_coverage')
    AND v.oid <> t.oid;
  IF dependent_views IS NOT NULL THEN
    RAISE EXCEPTION 'legacy listing deposit still has dependent views: %', dependent_views USING ERRCODE='23514';
  END IF;

  -- A function that references them may be part of another feature; do not cascade blindly.
  SELECT string_agg(DISTINCT p.proname, ', ') INTO dependent_functions
  FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.objid
  JOIN pg_class t ON t.oid = d.refobjid
  WHERE t.relname IN ('legacy_owner_guarantee_observation','legacy_owner_guarantee_coverage');
  IF dependent_functions IS NOT NULL THEN
    RAISE EXCEPTION 'legacy listing deposit still has dependent functions: %', dependent_functions USING ERRCODE='23514';
  END IF;

  -- If a future change adds columns to these tables, this removal was written against a different
  -- shape and must be reviewed again.
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO unexpected_columns
  FROM information_schema.columns
  WHERE table_schema='zzsh_order' AND table_name='legacy_owner_guarantee_observation'
    AND column_name NOT IN ('id','user_id','legacy_user_id','account_id','legacy_account_id','source_cutoff','input_sha256','identity_digest','source_canonical','source_digest','imported_at','created_at','created_xid');
  IF unexpected_columns IS NOT NULL THEN
    RAISE EXCEPTION 'legacy_owner_guarantee_observation has unreviewed columns: %', unexpected_columns USING ERRCODE='23514';
  END IF;

  -- The new platform's guarantee must still be present: this migration removes the old domain, it
  -- must never be used as a way to disable the new one.
  IF to_regclass('zzsh_order.owner_guarantee_requirement') IS NULL THEN
    RAISE EXCEPTION 'new platform guarantee requirement table is missing; refusing to retire the old deposit' USING ERRCODE='23514';
  END IF;
END $legacy_listing_deposit_preflight$;

--> statement-breakpoint
-- Triggers and their functions belong to the retired tables; drop them explicitly so the removal is
-- visible rather than implied by the table drop.
DROP TRIGGER IF EXISTS legacy_guarantee_observation_guard ON zzsh_order.legacy_owner_guarantee_observation;
DROP TRIGGER IF EXISTS legacy_guarantee_observation_immutable ON zzsh_order.legacy_owner_guarantee_observation;
DROP TRIGGER IF EXISTS legacy_guarantee_coverage_guard ON zzsh_order.legacy_owner_guarantee_coverage;
DROP TRIGGER IF EXISTS legacy_guarantee_coverage_immutable ON zzsh_order.legacy_owner_guarantee_coverage;

--> statement-breakpoint
DROP FUNCTION IF EXISTS zzsh_order.guard_legacy_guarantee_observation();
DROP FUNCTION IF EXISTS zzsh_order.guard_legacy_guarantee_coverage();

--> statement-breakpoint
DROP TABLE IF EXISTS zzsh_order.legacy_owner_guarantee_observation;
DROP TABLE IF EXISTS zzsh_order.legacy_owner_guarantee_coverage;

--> statement-breakpoint
-- Post-condition: the retired objects are gone and the new platform guarantee survived.
DO $legacy_listing_deposit_postcheck$
BEGIN
  IF to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL
    OR to_regclass('zzsh_order.legacy_owner_guarantee_coverage') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy listing deposit tables still present' USING ERRCODE='23514';
  END IF;
  IF to_regclass('zzsh_order.owner_guarantee_requirement') IS NULL
    OR to_regclass('zzsh_order.owner_guarantee_payment') IS NULL
    OR to_regclass('zzsh_order.owner_guarantee_refund') IS NULL THEN
    RAISE EXCEPTION 'new platform guarantee tables were removed by this migration' USING ERRCODE='23514';
  END IF;
  IF to_regclass('zzsh_supply.account_guarantee_proof') IS NULL THEN
    RAISE EXCEPTION 'funding policy guarantee proof table was removed by this migration' USING ERRCODE='23514';
  END IF;
END $legacy_listing_deposit_postcheck$;
