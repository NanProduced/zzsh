-- Approved edits are a separate immutable decision; the original request stays unchanged.
ALTER TABLE "zzsh_iam"."approval_decision"
  ADD COLUMN "final_payload" jsonb,
  ADD COLUMN "final_payload_hash" text;

ALTER TABLE "zzsh_iam"."approval_decision"
  ADD CONSTRAINT "approval_decision_final_payload_check" CHECK (
    ("final_payload" IS NULL AND "final_payload_hash" IS NULL)
    OR (
      "decision" = 'APPROVED'
      AND "final_payload" IS NOT NULL
      AND jsonb_typeof("final_payload") = 'object'
      AND "final_payload_hash" IS NOT NULL
      AND "final_payload_hash" ~ '^[a-f0-9]{64}$'
    )
  );
