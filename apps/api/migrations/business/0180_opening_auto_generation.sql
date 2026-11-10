-- 0180_opening_auto_generation: 付款被正式接纳后自动生成唯一开租清单，并冻结自动确认等待期。
-- 只追加事实；不重算历史 DRAFT 的截止时间，不改写已确认/已结算记录。
--> statement-breakpoint

-- 自动开租与失败记录同时不可写时，订单上的可见兜底标记仍要求客服核对。
ALTER TABLE "zzsh_order"."rental_order"
  ADD COLUMN IF NOT EXISTS "opening_generation_recovery_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
COMMENT ON COLUMN "zzsh_order"."rental_order"."opening_generation_recovery_required" IS '自动开租和生成结论均写入失败时置真；客服可重新核对，不能据此伪造清单';
--> statement-breakpoint

-- 系统自动创建必须记录真实来源，不能伪造客服账号；历史记录保持 created_by_source='ADMIN'。
ALTER TABLE "zzsh_order"."rental_opening" ALTER COLUMN "created_by_admin_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "zzsh_order"."rental_opening"
  ADD COLUMN IF NOT EXISTS "created_by_source" text NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN IF NOT EXISTS "payment_confirmation_id" text REFERENCES "zzsh_order"."payment_confirmation"("id"),
  ADD COLUMN IF NOT EXISTS "auto_confirm_policy_revision" bigint,
  ADD COLUMN IF NOT EXISTS "auto_confirm_wait_minutes" integer;
--> statement-breakpoint
ALTER TABLE "zzsh_order"."rental_opening"
  ADD CONSTRAINT "rental_opening_created_by_shape" CHECK (
    ("created_by_source" = 'ADMIN' AND "created_by_admin_id" IS NOT NULL)
    OR ("created_by_source" = 'SYSTEM' AND "created_by_admin_id" IS NULL)
  ),
  ADD CONSTRAINT "rental_opening_auto_confirm_policy_shape" CHECK (
    ("auto_confirm_policy_revision" IS NULL AND "auto_confirm_wait_minutes" IS NULL)
    OR ("auto_confirm_policy_revision" > 0 AND "auto_confirm_wait_minutes" BETWEEN 1 AND 10080)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rental_opening_one_per_payment"
  ON "zzsh_order"."rental_opening" ("payment_confirmation_id")
  WHERE "payment_confirmation_id" IS NOT NULL;
--> statement-breakpoint

-- 自动确认等待期是平台配置；每份新清单在 INSERT 时冻结 revision 和分钟数。
CREATE TABLE IF NOT EXISTS "zzsh_order"."opening_auto_confirm_policy" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "wait_minutes" integer NOT NULL DEFAULT 40 CHECK ("wait_minutes" BETWEEN 1 AND 10080),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "updated_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
INSERT INTO "zzsh_order"."opening_auto_confirm_policy" ("singleton") VALUES (true) ON CONFLICT ("singleton") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zzsh_order"."guard_opening_auto_confirm_policy"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opening auto-confirm policy singleton cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."singleton" IS DISTINCT FROM OLD."singleton" OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'opening auto-confirm policy revision must advance by one' USING ERRCODE = '23514';
  END IF;
  IF NEW."wait_minutes" NOT BETWEEN 1 AND 10080 THEN
    RAISE EXCEPTION 'opening auto-confirm minutes out of range' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "opening_auto_confirm_policy_guard" ON "zzsh_order"."opening_auto_confirm_policy";
--> statement-breakpoint
CREATE TRIGGER "opening_auto_confirm_policy_guard"
  BEFORE UPDATE OR DELETE ON "zzsh_order"."opening_auto_confirm_policy"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_order"."guard_opening_auto_confirm_policy"();
--> statement-breakpoint

-- 记录每次自动生成的结论：CREATED 或待客服核对（REVIEW_REQUIRED + 原因）。
CREATE TABLE IF NOT EXISTS "zzsh_order"."rental_opening_generation" (
  "order_id" text PRIMARY KEY REFERENCES "zzsh_order"."rental_order"("id"),
  "payment_confirmation_id" text NOT NULL REFERENCES "zzsh_order"."payment_confirmation"("id"),
  "state" text NOT NULL CHECK ("state" IN ('CREATED', 'REVIEW_REQUIRED')),
  "reason" text,
  "opening_id" text REFERENCES "zzsh_order"."rental_opening"("id"),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "rental_opening_generation_shape" CHECK (
    ("state" = 'CREATED' AND "opening_id" IS NOT NULL AND "reason" IS NULL)
    OR ("state" = 'REVIEW_REQUIRED' AND "opening_id" IS NULL AND "reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_opening_generation_state_idx"
  ON "zzsh_order"."rental_opening_generation" ("state", "updated_at", "order_id");
--> statement-breakpoint

-- 客服进度提醒：每次实际点击一条；同一管理员+请求键重试复用同一条和同一云信消息键。
CREATE TABLE IF NOT EXISTS "zzsh_order"."opening_progress_reminder" (
  "id" text PRIMARY KEY,
  "order_id" text NOT NULL REFERENCES "zzsh_order"."rental_order"("id"),
  "app_id" text NOT NULL,
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "request_key" text NOT NULL,
  "stage" text NOT NULL CHECK ("stage" IN ('OPENING_PENDING', 'SETTLEMENT_DECISION', 'IN_RENTAL')),
  "target_parties" text[] NOT NULL CHECK (array_length("target_parties", 1) BETWEEN 1 AND 2 AND "target_parties" <@ ARRAY['RENTER','OWNER']::text[]),
  "message_text" text NOT NULL CHECK (length("message_text") BETWEEN 1 AND 1000),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'SENDING', 'SENT', 'UNKNOWN', 'FAILED')),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "failure_class" text,
  "lease_token_hash" text,
  "lease_until" timestamptz,
  "server_message_id" text,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "opening_progress_reminder_request_unique" UNIQUE ("admin_user_id", "request_key"),
  CONSTRAINT "opening_progress_reminder_sent_shape" CHECK (("state" = 'SENT') = ("sent_at" IS NOT NULL)),
  CONSTRAINT "opening_progress_reminder_lease_shape" CHECK (
    ("state" = 'SENDING' AND "lease_token_hash" IS NOT NULL AND "lease_until" IS NOT NULL)
    OR ("state" <> 'SENDING' AND "lease_token_hash" IS NULL AND "lease_until" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opening_progress_reminder_order_idx"
  ON "zzsh_order"."opening_progress_reminder" ("order_id", "created_at", "id");
--> statement-breakpoint

-- 旧 DRAFT 保留原有 auto_confirm_due_at；只有迁移后的新 INSERT 使用冻结的当前配置。
CREATE OR REPLACE FUNCTION "zzsh_order"."set_rental_opening_auto_confirm_due"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE policy record;
BEGIN
  SELECT "revision", "wait_minutes" INTO policy
    FROM "zzsh_order"."opening_auto_confirm_policy" WHERE "singleton" FOR SHARE;
  IF policy IS NULL THEN
    RAISE EXCEPTION 'opening auto-confirm policy is unavailable' USING ERRCODE = '23514';
  END IF;
  NEW."auto_confirm_policy_revision" := policy."revision";
  NEW."auto_confirm_wait_minutes" := policy."wait_minutes";
  NEW."auto_confirm_due_at" := NEW."created_at" + policy."wait_minutes" * interval '1 minute';
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 保持历史不可变语义，同时把自动生成的来源/付款绑定纳入不可改写字段。
CREATE OR REPLACE FUNCTION "zzsh_order"."guard_rental_opening"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opening versions are immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'CONFIRMED' OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.quote_digest IS DISTINCT FROM OLD.quote_digest OR NEW.payment_digest IS DISTINCT FROM OLD.payment_digest
     OR NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id
     OR NEW.created_by_source IS DISTINCT FROM OLD.created_by_source
     OR NEW.payment_confirmation_id IS DISTINCT FROM OLD.payment_confirmation_id
     OR NEW.auto_confirm_policy_revision IS DISTINCT FROM OLD.auto_confirm_policy_revision
     OR NEW.auto_confirm_wait_minutes IS DISTINCT FROM OLD.auto_confirm_wait_minutes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'confirmed opening lines are immutable' USING ERRCODE = '40001';
  END IF;
  IF NOT (OLD.status = 'DRAFT' AND NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'opening can only move from draft to confirmed' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
REVOKE ALL ON TABLE "zzsh_order"."opening_auto_confirm_policy", "zzsh_order"."rental_opening_generation", "zzsh_order"."opening_progress_reminder" FROM PUBLIC;
REVOKE ALL ON FUNCTION "zzsh_order"."guard_opening_auto_confirm_policy"(), "zzsh_order"."set_rental_opening_auto_confirm_due"() FROM PUBLIC;

--> statement-breakpoint
COMMENT ON TABLE "zzsh_order"."opening_auto_confirm_policy" IS '开租清单自动确认等待期的单例配置；修改只影响之后新生成的清单';
COMMENT ON COLUMN "zzsh_order"."opening_auto_confirm_policy"."singleton" IS '单例标记；保证整个平台只有一份当前配置';
COMMENT ON COLUMN "zzsh_order"."opening_auto_confirm_policy"."wait_minutes" IS '清单生成后等待双方确认的整数分钟数，范围 1–10080，0 不作为关闭或立即确认';
COMMENT ON COLUMN "zzsh_order"."opening_auto_confirm_policy"."revision" IS '配置修订号，用于并发版本校验';
COMMENT ON COLUMN "zzsh_order"."opening_auto_confirm_policy"."updated_by_admin_id" IS '最后修改配置的管理员标识';
COMMENT ON COLUMN "zzsh_order"."opening_auto_confirm_policy"."updated_at" IS '配置最近更新时间';
COMMENT ON TABLE "zzsh_order"."rental_opening_generation" IS '每笔正式接纳付款的自动开租生成结论及待客服核对原因';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."order_id" IS '订单标识；每单至多一条生成结论';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."payment_confirmation_id" IS '触发自动生成的已接纳付款确认';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."state" IS 'CREATED 已生成清单；REVIEW_REQUIRED 资料不足待客服核对';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."reason" IS '待客服核对的可恢复原因代码；成功时为空';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."opening_id" IS '自动生成的开租清单标识；待核对时为空';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."created_at" IS '首次生成结论写入时间';
COMMENT ON COLUMN "zzsh_order"."rental_opening_generation"."updated_at" IS '生成结论最近更新时间';
COMMENT ON COLUMN "zzsh_order"."rental_opening"."created_by_source" IS '清单创建来源：ADMIN 客服手工记录，SYSTEM 付款接纳后系统自动生成';
COMMENT ON COLUMN "zzsh_order"."rental_opening"."payment_confirmation_id" IS '自动生成绑定的已接纳付款确认；历史手工记录可为空';
COMMENT ON COLUMN "zzsh_order"."rental_opening"."auto_confirm_policy_revision" IS '生成时冻结的自动确认配置修订号；历史 DRAFT 可为空';
COMMENT ON COLUMN "zzsh_order"."rental_opening"."auto_confirm_wait_minutes" IS '生成时冻结的自动确认等待分钟数；历史 DRAFT 可为空';
COMMENT ON TABLE "zzsh_order"."opening_progress_reminder" IS '客服发送的订单阶段进度提醒；同一次请求重试复用同一消息键';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."id" IS '提醒标识，同时作为云信消息客户端消息ID';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."order_id" IS '提醒对应的订单';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."app_id" IS '订单群所属应用';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."admin_user_id" IS '实际点击发送的客服';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."request_key" IS '同一管理员下的请求幂等键；重试不得换键';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."stage" IS '发送时的订单阶段：待开租、待结算确认或租期中';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."target_parties" IS '本次提醒的接收方：RENTER/OWNER';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."message_text" IS '发送的通用进度提醒正文，不含私有金额或客服备注';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."state" IS '投递状态：PENDING 待发、SENDING 已认领、SENT 已发送、UNKNOWN 结果未知、FAILED 明确失败';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."attempt_count" IS '实际投递尝试次数';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."failure_class" IS '脱敏后的投递失败分类';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."lease_token_hash" IS '发送认领令牌哈希；只有当前认领者能落成功或失败';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."lease_until" IS '发送认领租约到期时间；过期后按未知结果处理';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."server_message_id" IS '云信返回的服务端消息ID；仅成功发送后记录';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."sent_at" IS '成功投递时间';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."created_at" IS '提醒创建时间';
COMMENT ON COLUMN "zzsh_order"."opening_progress_reminder"."updated_at" IS '提醒最近更新时间';
