-- P3a fixed documents (provisional number, Master to finalize). Additive only:
-- 0112_legal_documents.sql bytes are untouched. Two 0112 gaps are repaired here:
-- legal_document_sealed_shape and the guard trigger both rejected PENDING, and
-- the SEALED per-column comparison did not cover columns added after 0112.
-- Existing rows keep every stored value: body_format defaults to 'text' and the
-- two new nullable columns stay NULL, so no sealed body/digest/effective_at moves.
ALTER TABLE "zzsh_content"."legal_document_version"
  ADD COLUMN "body_format" text NOT NULL DEFAULT 'text' CHECK ("body_format" IN ('text', 'plate')),
  ADD COLUMN "body_document" jsonb,
  ADD COLUMN "approval_request_id" text;

--> statement-breakpoint
ALTER TABLE "zzsh_content"."legal_document_version"
  DROP CONSTRAINT IF EXISTS "legal_document_version_doc_type_check",
  DROP CONSTRAINT IF EXISTS "legal_document_version_status_check",
  DROP CONSTRAINT IF EXISTS "legal_document_sealed_shape";

--> statement-breakpoint
ALTER TABLE "zzsh_content"."legal_document_version"
  ADD CONSTRAINT "legal_document_version_doc_type_check"
    CHECK ("doc_type" IN ('PLATFORM_TERMS', 'PLATFORM_PRIVACY', 'EARLY_SETTLEMENT')),
  ADD CONSTRAINT "legal_document_version_status_check"
    CHECK ("status" IN ('DRAFT', 'PENDING', 'SEALED')),
  ADD CONSTRAINT "legal_document_sealed_shape" CHECK (
    ("status" = 'SEALED' AND "sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL AND "effective_at" IS NOT NULL)
    OR ("status" = 'PENDING' AND "approval_request_id" IS NOT NULL AND "sealed_at" IS NULL AND "sealed_by_admin_id" IS NULL)
    OR ("status" = 'DRAFT' AND "approval_request_id" IS NULL AND "sealed_at" IS NULL AND "sealed_by_admin_id" IS NULL)
  ),
  ADD CONSTRAINT "legal_document_body_format_shape" CHECK (
    ("body_format" = 'text' AND "body_document" IS NULL)
    OR ("body_format" = 'plate' AND "body_document" IS NOT NULL AND "doc_type" <> 'EARLY_SETTLEMENT')
  );

--> statement-breakpoint
-- State machine: DRAFT -> PENDING -> SEALED, plus PENDING -> DRAFT (退回).
-- SEALED rows are immutable column by column, including the three new columns and
-- updated_at; PENDING content is frozen until it is sealed or returned to draft.
CREATE OR REPLACE FUNCTION "zzsh_content"."guard_legal_document_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'sealed legal document is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."id", NEW."doc_type", NEW."title", NEW."body", NEW."body_format", NEW."body_document", NEW."digest",
        NEW."status", NEW."revision", NEW."effective_at", NEW."created_by_admin_id", NEW."sealed_by_admin_id",
        NEW."sealed_at", NEW."approval_request_id", NEW."created_at", NEW."updated_at")
       IS DISTINCT FROM
       (OLD."id", OLD."doc_type", OLD."title", OLD."body", OLD."body_format", OLD."body_document", OLD."digest",
        OLD."status", OLD."revision", OLD."effective_at", OLD."created_by_admin_id", OLD."sealed_by_admin_id",
        OLD."sealed_at", OLD."approval_request_id", OLD."created_at", OLD."updated_at") THEN
      RAISE EXCEPTION 'sealed legal document is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN RETURN NEW; END IF;
    IF NEW."status" = 'PENDING' AND NEW."approval_request_id" IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'legal document status transition is invalid';
  END IF;
  IF OLD."status" = 'PENDING' THEN
    IF NEW."status" = 'SEALED' THEN
      IF NEW."approval_request_id" IS DISTINCT FROM OLD."approval_request_id" THEN
        RAISE EXCEPTION 'legal document status transition is invalid';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."status" = 'DRAFT' THEN
      IF (NEW."title", NEW."body", NEW."body_format", NEW."body_document", NEW."digest")
         IS DISTINCT FROM
         (OLD."title", OLD."body", OLD."body_format", OLD."body_document", OLD."digest") THEN
        RAISE EXCEPTION 'pending legal document content is frozen';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'legal document status transition is invalid';
END $$;

--> statement-breakpoint
-- 固定文书发布审批：运营 / BOSS 提交与批准（含自批），客服只读。Boss 是 is_boss
-- 旁路，不在这里授予；两个码都不是 Boss 专属，也不进动态码名单。
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('content.fixed.submit', '提交固定文书发布', '提交平台服务协议、隐私政策、场景说明与提前结算告知的发布审批'),
  ('content.fixed.publish', '批准固定文书发布', '批准固定文书发布审批；批准即在同一事务生效')
ON CONFLICT ("code") DO NOTHING;

--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_role_permission" ("role_id", "permission_code")
SELECT v."role_id", v."code"
  FROM (VALUES ('role_preset_ops', 'content.fixed.submit'), ('role_preset_ops', 'content.fixed.publish')) AS v("role_id", "code")
  JOIN "zzsh_iam"."admin_role" r ON r."id" = v."role_id"
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "zzsh_iam"."approval_template" ("id", "operation_code", "trigger_condition", "version")
VALUES ('approval_tpl_fixed_document', 'content.fixed_document.publish', 'content.fixed_document.publish.requested', 1)
ON CONFLICT ("operation_code", "trigger_condition") DO NOTHING;