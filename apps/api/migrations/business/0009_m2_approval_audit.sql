CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_template" (
  "id" text PRIMARY KEY,
  "operation_code" text NOT NULL,
  "trigger_condition" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("operation_code", "trigger_condition")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_template_candidate" (
  "template_id" text NOT NULL REFERENCES "zzsh_iam"."approval_template"("id"),
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  PRIMARY KEY ("template_id", "admin_user_id")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_request" (
  "id" text PRIMARY KEY,
  "template_id" text NOT NULL REFERENCES "zzsh_iam"."approval_template"("id"),
  "template_version" integer NOT NULL CHECK ("template_version" > 0),
  "operation_code" text NOT NULL,
  "trigger_condition" text NOT NULL,
  "payload_version" integer NOT NULL CHECK ("payload_version" > 0),
  "operation_payload" jsonb NOT NULL,
  "operation_payload_hash" text NOT NULL CHECK (length("operation_payload_hash") = 64),
  "summary" text NOT NULL,
  "requested_by" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "status" text NOT NULL CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'EXECUTED', 'EXECUTION_FAILED')),
  "status_reason" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "decided_by" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "decision_reason" text,
  "supersedes_request_id" text REFERENCES "zzsh_iam"."approval_request"("id"),
  "superseded_by_request_id" text REFERENCES "zzsh_iam"."approval_request"("id")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_request_candidate" (
  "request_id" text NOT NULL REFERENCES "zzsh_iam"."approval_request"("id"),
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "source" text NOT NULL CHECK ("source" IN ('TEMPLATE', 'APPENDED')),
  "template_version" integer NOT NULL CHECK ("template_version" > 0),
  "added_by" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("request_id", "admin_user_id")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_decision" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL UNIQUE REFERENCES "zzsh_iam"."approval_request"("id"),
  "approver_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "decision" text NOT NULL CHECK ("decision" IN ('APPROVED', 'REJECTED')),
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."approval_execution" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL UNIQUE REFERENCES "zzsh_iam"."approval_request"("id"),
  "operation_code" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('SUCCEEDED', 'FAILED')),
  "result_code" text NOT NULL,
  "result_detail" text,
  "executed_by" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "approval_template_candidate_admin_idx"
  ON "zzsh_iam"."approval_template_candidate" ("admin_user_id");
CREATE INDEX IF NOT EXISTS "approval_request_requester_status_idx"
  ON "zzsh_iam"."approval_request" ("requested_by", "status", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "approval_request_pending_idx"
  ON "zzsh_iam"."approval_request" ("status", "expires_at", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "approval_request_candidate_admin_idx"
  ON "zzsh_iam"."approval_request_candidate" ("admin_user_id", "request_id");
CREATE INDEX IF NOT EXISTS "approval_decision_approver_idx"
  ON "zzsh_iam"."approval_decision" ("approver_admin_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "approval_execution_executor_idx"
  ON "zzsh_iam"."approval_execution" ("executed_by", "created_at" DESC);

CREATE OR REPLACE FUNCTION "zzsh_iam"."protect_approval_request_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."template_id" IS DISTINCT FROM NEW."template_id"
    OR OLD."template_version" IS DISTINCT FROM NEW."template_version"
    OR OLD."operation_code" IS DISTINCT FROM NEW."operation_code"
    OR OLD."trigger_condition" IS DISTINCT FROM NEW."trigger_condition"
    OR OLD."payload_version" IS DISTINCT FROM NEW."payload_version"
    OR OLD."operation_payload" IS DISTINCT FROM NEW."operation_payload"
    OR OLD."operation_payload_hash" IS DISTINCT FROM NEW."operation_payload_hash"
    OR OLD."summary" IS DISTINCT FROM NEW."summary"
    OR OLD."requested_by" IS DISTINCT FROM NEW."requested_by"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
    OR OLD."supersedes_request_id" IS DISTINCT FROM NEW."supersedes_request_id" THEN
    RAISE EXCEPTION 'approval request snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "approval_request_snapshot_guard" ON "zzsh_iam"."approval_request";
CREATE TRIGGER "approval_request_snapshot_guard"
BEFORE UPDATE ON "zzsh_iam"."approval_request"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."protect_approval_request_snapshot"();

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('approval.template.read', '查看审批模板', '读取当前审批模板与候选人'),
  ('approval.template.configure', '配置审批模板', '配置明确用例的触发条件与候选审批人'),
  ('approval.request.create', '发起审批申请', '提交不可变操作载荷的审批申请'),
  ('approval.request.read', '查看审批申请', '查看本人或本人候选范围内的申请'),
  ('approval.request.approve', '审批申请', '对候选名单内的申请作出首个有效决定'),
  ('approval.request.execute', '执行已批准申请', '执行已批准的受控非资金操作'),
  ('approval.request.add_approver', '追加审批人', '向在途申请追加当前具备审批资格的审批人'),
  ('approval.audit.read', '查询审批审计', '按授权对象范围读取裁剪后的审批审计')
ON CONFLICT ("code") DO NOTHING;
