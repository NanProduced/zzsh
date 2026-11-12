-- Candidate: install after posting, cancellation, compensation and distribution guards.
-- Application publication, scheduling and order switches remain closed.
CREATE OR REPLACE FUNCTION zzsh_order.poststart_full_payout_selected(quote_value jsonb,renter_value text,owner_value text,account_value text,listing_value text,hash_value text,release_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN quote_value#>>'{personal,userId}' IS DISTINCT FROM renter_value
   OR quote_value#>>'{personal,listingHash}' IS DISTINCT FROM hash_value
   OR quote_value#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM release_value
   OR quote_value->>'ruleReleaseId' IS DISTINCT FROM release_value THEN NULL
  WHEN quote_value#>>'{personal,schema}'='personal-quote-v1'
   AND quote_value#>'{personal,funding,fullPayoutSelected}'='false'::jsonb
   AND quote_value#>>'{personal,funding,fullPayoutFeeCents}'='0'
   AND NOT ((quote_value->'personal') ? 'fullPayoutDeclaration') THEN false
  WHEN (quote_value#>>'{personal,schema}' IN('personal-quote-v2','personal-quote-v3','personal-quote-v4')
    OR (quote_value#>>'{personal,schema}'='personal-quote-v6' AND quote_value->>'schemaVersion'='2'
      AND quote_value->>'mode'='SPREAD' AND quote_value#>>'{personal,pricingPolicy,pricingModel}'='SPREAD'
      AND quote_value#>>'{settlementPricing,schema}'='settlement-pricing-v1'
      AND quote_value#>>'{settlementPricing,priceVersionId}'=quote_value->>'priceVersionId'
      AND quote_value#>>'{personal,pricingPolicy,priceVersionId}'=quote_value->>'priceVersionId'))
   AND quote_value#>>'{personal,ownerUserId}'=owner_value
   AND quote_value#>>'{personal,accountId}'=account_value
   AND quote_value#>>'{personal,listingVersionId}'=listing_value
   AND quote_value#>>'{personal,fullPayoutDeclaration,schema}'='full-payout-declaration-v1'
   AND jsonb_typeof(quote_value#>'{personal,fullPayoutDeclaration,selected}')='boolean'
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutSelected')
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutFeeCents')
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,fullPayoutPolicyVersion}','')))>0
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,disclosureVersion}','')))>0
  THEN (quote_value#>>'{personal,fullPayoutDeclaration,selected}')::boolean
  ELSE NULL END
$$;
--> statement-breakpoint
DROP TRIGGER rental_order_personal_guard ON zzsh_order.rental_order;
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW WHEN (NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
    AND NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v6')
  EXECUTE FUNCTION zzsh_order.guard_personal_order();
CREATE TRIGGER rental_order_scheduled_spread_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_scheduled_spread_personal_order();
