ALTER TABLE zzsh_iam.membership_entitlement
  ADD COLUMN deposit_allowance_cents numeric(24,0),
  ADD CONSTRAINT membership_entitlement_deposit_allowance_check
    CHECK (deposit_allowance_cents IS NULL OR
      (deposit_allowance_cents >= 0 AND deposit_allowance_cents <= 999999999999999999999999
        AND (NOT deposit_waived OR deposit_allowance_cents = 0)));
--> statement-breakpoint
COMMENT ON COLUMN zzsh_iam.membership_entitlement.deposit_allowance_cents IS
  'Per-order tenant deposit reduction in integer cents. NULL preserves legacy boolean semantics; valid sources take max, never sum.';
