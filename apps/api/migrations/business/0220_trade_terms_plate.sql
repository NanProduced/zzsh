-- Append after the existing legal documents and scheduled rule release migrations.
ALTER TABLE zzsh_supply.agreement_version
  ADD COLUMN body_document jsonb CHECK (body_document IS NULL OR jsonb_typeof(body_document) = 'object');

ALTER TABLE zzsh_supply.full_payout_terms_version
  ADD COLUMN body_document jsonb CHECK (body_document IS NULL OR jsonb_typeof(body_document) = 'object'),
  DROP CONSTRAINT IF EXISTS full_payout_terms_version_check,
  DROP CONSTRAINT IF EXISTS full_payout_terms_version_digest_check,
  ADD CONSTRAINT full_payout_terms_version_digest_check CHECK (
    (body_document IS NULL AND digest = encode(sha256(convert_to(body, 'UTF8')), 'hex'))
    OR (body_document IS NOT NULL AND digest ~ '^[0-9a-f]{64}$')
  );

--> statement-breakpoint
ALTER TABLE zzsh_content.legal_document_version
  DROP CONSTRAINT legal_document_body_format_shape,
  ADD CONSTRAINT legal_document_body_format_shape CHECK (
    (body_format = 'text' AND body_document IS NULL)
    OR (body_format = 'plate' AND jsonb_typeof(body_document) IS NOT DISTINCT FROM 'object')
  );

--> statement-breakpoint
ALTER TABLE zzsh_supply.rule_release
  ADD COLUMN early_settlement_version_id text REFERENCES zzsh_content.legal_document_version(id),
  ADD COLUMN early_settlement_digest text,
  ADD CONSTRAINT rule_release_early_settlement_shape CHECK (
    (early_settlement_version_id IS NULL AND early_settlement_digest IS NULL)
    OR (early_settlement_version_id IS NOT NULL AND early_settlement_digest IS NOT NULL
        AND early_settlement_digest ~ '^[0-9a-f]{64}$')
  );

--> statement-breakpoint
-- Legacy reference imports may retain a missing binding. The scheduling API
-- requires a binding, and any supplied binding must refer to the sealed text.
CREATE FUNCTION zzsh_supply.guard_release_early_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.early_settlement_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM zzsh_content.legal_document_version d
     WHERE d.id = NEW.early_settlement_version_id AND d.digest = NEW.early_settlement_digest
       AND d.doc_type = 'EARLY_SETTLEMENT' AND d.status = 'SEALED'
       AND d.effective_at <= statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'rule release early settlement disclosure is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE TRIGGER rule_release_early_settlement_guard
BEFORE INSERT ON zzsh_supply.rule_release
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_early_settlement();
