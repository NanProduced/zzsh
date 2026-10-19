-- Candidate shared hunk for Root: MEMBER-10 total-discount entitlement grants.
-- Source adaptation only; numbering/journal/ACL/application are Root-owned.
-- Reason: new manual entitlements carry a TOTAL_DISCOUNT contract instead of a haff-ratio schema;
-- the 0068 inline CHECK only admits the two legacy haff schemas, so the INSERT would fail closed.
-- Legacy rows keep their existing values; no data rewrite.
ALTER TABLE zzsh_iam.membership_entitlement
  DROP CONSTRAINT IF EXISTS membership_entitlement_pricing_schema_check;
ALTER TABLE zzsh_iam.membership_entitlement
  ADD CONSTRAINT membership_entitlement_pricing_schema_check
  CHECK (pricing_schema IN ('haff-ratio-v1', 'haff-ratio-v2', 'total-discount-v1'));
