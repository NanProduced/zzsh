-- Persist whether the original operation required the publish permission so
-- idempotent replays cannot be downgraded after mutable state changes (for
-- example a successful carousel disable followed by a permission revocation).
ALTER TABLE "zzsh_supply"."idempotency_record" ADD COLUMN "publish_required" boolean NOT NULL DEFAULT false;
