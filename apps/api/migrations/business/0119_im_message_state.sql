-- 0119_im_message_state: 最近消息摘要与用户已读指针。
-- 轮次保存 160 码点以内的最近消息摘要，供客服队列在未打开历史时直接展示；
-- 线程保存用户侧已读时间，由客户端最近消息时间比较得出未读；均不是 NIM 原生回执。

ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN IF NOT EXISTS "last_message_preview" text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zzsh_iam.im_consultation'::regclass
       AND conname = 'im_consultation_last_message_preview_length'
  ) THEN
    ALTER TABLE "zzsh_iam"."im_consultation"
      ADD CONSTRAINT "im_consultation_last_message_preview_length" CHECK (char_length("last_message_preview") <= 160);
  END IF;
END $$;

--> statement-breakpoint

ALTER TABLE "zzsh_iam"."im_support_thread" ADD COLUMN IF NOT EXISTS "user_read_at" timestamptz;
