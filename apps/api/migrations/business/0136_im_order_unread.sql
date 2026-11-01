-- 0136_im_order_unread: 订单群按成员身份记录未读消息数。
-- 订单群没有客服轮次；每个 JOINED 成员各有一份计数，打开群聊时只清自己的未读。

CREATE TABLE IF NOT EXISTS "zzsh_order"."im_order_unread" (
  "order_id" text NOT NULL,
  "identity_id" text NOT NULL,
  "unread_count" integer NOT NULL DEFAULT 0 CHECK ("unread_count" >= 0),
  "last_read_at" timestamptz,
  PRIMARY KEY ("order_id", "identity_id"),
  CONSTRAINT "im_order_unread_order_fk" FOREIGN KEY ("order_id")
    REFERENCES "zzsh_order"."rental_order" ("id") ON DELETE CASCADE,
  CONSTRAINT "im_order_unread_identity_fk" FOREIGN KEY ("identity_id")
    REFERENCES "zzsh_iam"."im_identity_mapping" ("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "im_order_unread_identity"
  ON "zzsh_order"."im_order_unread" ("identity_id");
