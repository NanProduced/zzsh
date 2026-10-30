-- Candidate migration for AGREEMENTS-ACCEPTANCE-CLOSURE-1.
-- Numbering and meta/_journal.json are assigned by Root; this file is not journaled here.
-- Platform legal documents are intentionally not game-scoped and do not reuse
-- zzsh_supply.agreement_version (which is bound to a rule release).

CREATE TABLE "zzsh_content"."legal_document_version" (
  "id" text PRIMARY KEY,
  "doc_type" text NOT NULL CHECK ("doc_type" IN ('PLATFORM_TERMS', 'PLATFORM_PRIVACY')),
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 160),
  "body" text NOT NULL CHECK (octet_length("body") BETWEEN 1 AND 20000),
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'SEALED')),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "effective_at" timestamptz,
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "legal_document_sealed_shape" CHECK (
    "status" = 'DRAFT'
    OR ("sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL AND "effective_at" IS NOT NULL)
  )
);

CREATE INDEX "legal_document_current_idx"
  ON "zzsh_content"."legal_document_version" ("doc_type", "status", "effective_at" DESC, "sealed_at" DESC);

CREATE OR REPLACE FUNCTION "zzsh_content"."guard_legal_document_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."doc_type", NEW."title", NEW."body", NEW."digest", NEW."status", NEW."revision",
        NEW."effective_at", NEW."created_by_admin_id", NEW."sealed_by_admin_id", NEW."sealed_at", NEW."created_at")
       IS DISTINCT FROM
       (OLD."doc_type", OLD."title", OLD."body", OLD."digest", OLD."status", OLD."revision",
        OLD."effective_at", OLD."created_by_admin_id", OLD."sealed_by_admin_id", OLD."sealed_at", OLD."created_at") THEN
      RAISE EXCEPTION 'sealed legal document is immutable';
    END IF;
  ELSIF NEW."status" NOT IN ('DRAFT', 'SEALED') THEN
    RAISE EXCEPTION 'legal document status transition is invalid';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "legal_document_version_guard" ON "zzsh_content"."legal_document_version";
CREATE TRIGGER "legal_document_version_guard"
  BEFORE UPDATE ON "zzsh_content"."legal_document_version"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_content"."guard_legal_document_version"();

-- One immutable acceptance ledger for platform documents and order/settlement
-- disclosures. Listing-owner acceptance remains in zzsh_supply.rule_acceptance;
-- this table covers documents that are not tied to a listing release.
CREATE TABLE "zzsh_content"."document_acceptance" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "document_type" text NOT NULL CHECK ("document_type" IN (
    'PLATFORM_TERMS', 'PLATFORM_PRIVACY', 'RENTAL_AGREEMENT',
    'FULL_PAYOUT_TERMS', 'EARLY_SETTLEMENT_OWNER', 'EARLY_SETTLEMENT_RENTER'
  )),
  "document_version_id" text NOT NULL CHECK (length("document_version_id") BETWEEN 1 AND 160),
  "document_digest" text NOT NULL CHECK ("document_digest" ~ '^[0-9a-f]{64}$'),
  "subject_type" text NOT NULL CHECK ("subject_type" IN ('USER', 'ACCOUNT', 'ORDER')),
  "subject_id" text NOT NULL CHECK (length("subject_id") BETWEEN 1 AND 128),
  "source" text NOT NULL CHECK ("source" IN (
    'REGISTRATION', 'LOGIN', 'ACCOUNT_READ', 'ORDER_CREATE',
    'SETTLEMENT_SUBMIT', 'SETTLEMENT_DECISION'
  )),
  "accepted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "request_id" text,
  CONSTRAINT "document_acceptance_identity_unique" UNIQUE (
    "user_id", "document_type", "document_version_id", "document_digest", "subject_type", "subject_id"
  )
);

CREATE INDEX "document_acceptance_subject_idx"
  ON "zzsh_content"."document_acceptance" ("subject_type", "subject_id", "document_type", "accepted_at" DESC);

CREATE OR REPLACE FUNCTION "zzsh_content"."guard_document_acceptance_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document acceptance is immutable';
END $$;

DROP TRIGGER IF EXISTS "document_acceptance_immutable" ON "zzsh_content"."document_acceptance";
CREATE TRIGGER "document_acceptance_immutable"
  BEFORE UPDATE OR DELETE ON "zzsh_content"."document_acceptance"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_content"."guard_document_acceptance_mutation"();
