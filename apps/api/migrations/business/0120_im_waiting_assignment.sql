-- 0120_im_waiting_assignment: 首条用户消息、入口场景与无客服兜底标记。
-- 自动分配只在用户真正发出第一条消息后发生：进入会话、发送欢迎语都不产生分配。
-- entry_intent 仅决定欢迎语文案，线程 kind 仍统一为 SERVICE。
-- 旧行不做启发式回填：first_user_message_at 保持 NULL 的历史 WAITING 空会话
-- 不会进入自动分配队列，也不会出现在客服管理队列，需要管理岗人工处理/清理。

ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN IF NOT EXISTS "first_user_message_at" timestamptz;
ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN IF NOT EXISTS "entry_intent" text NOT NULL DEFAULT 'SERVICE';
ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN IF NOT EXISTS "no_support_notice_at" timestamptz;

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zzsh_iam.im_consultation'::regclass
       AND conname = 'im_consultation_entry_intent_check'
  ) THEN
    ALTER TABLE "zzsh_iam"."im_consultation"
      ADD CONSTRAINT "im_consultation_entry_intent_check"
      CHECK ("entry_intent" IN ('SERVICE', 'COMPLAINT'));
  END IF;
END $$;
