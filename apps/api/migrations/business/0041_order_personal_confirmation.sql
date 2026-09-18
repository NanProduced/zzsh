-- Unique lifetime consumption lives on the existing order, including cancelled orders.
ALTER TABLE zzsh_order.rental_order ADD COLUMN confirmation_id uuid;
ALTER TABLE zzsh_order.rental_order ADD CONSTRAINT rental_order_confirmation_unique UNIQUE(confirmation_id);
--> statement-breakpoint
-- Add to (never replace) the final OIM-2A guard: its PAID/payment/occupancy rules stay intact.
CREATE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expires_text text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
      RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quote_snapshot->>'quoteKind'='ORDER_CONFIRMATION' THEN
    IF NEW.confirmation_id IS NULL
      OR NEW.quote_snapshot->>'confirmationId' IS DISTINCT FROM NEW.confirmation_id::text
      OR NEW.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1'
      OR COALESCE(NEW.quote_snapshot->>'confirmationDigest','') !~ '^[0-9a-f]{64}$'
      OR NEW.quote_snapshot->>'listingHash' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM NEW.renter_user_id
      OR NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v1'
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
      OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,tier}','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,version}','') !~ '^[1-9][0-9]{0,18}$'
      OR NEW.quote_snapshot ? 'confirmationToken' OR NEW.quote_snapshot ? 'signature' THEN
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM zzsh_supply.listing_version v WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id AND v.content_hash=NEW.content_hash AND v.rule_release_id=NEW.rule_release_id) THEN
      RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
    END IF;
    expires_text:=NEW.quote_snapshot->>'confirmationExpiresAt';
    IF expires_text IS NULL OR expires_text !~ '^[1-9][0-9]{0,11}$' THEN
      RAISE EXCEPTION 'invalid confirmation expiry' USING ERRCODE='40001';
    END IF;
    IF extract(epoch FROM clock_timestamp()) >= expires_text::numeric THEN
      RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';
    END IF;
  ELSIF NEW.confirmation_id IS NOT NULL OR NEW.quote_snapshot ? 'quoteKind' OR NEW.quote_snapshot->>'schemaVersion'='2' THEN
    RAISE EXCEPTION 'personal quote requires confirmation consumption' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_personal_order();
