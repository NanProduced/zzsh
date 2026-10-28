CREATE TABLE IF NOT EXISTS zzsh_iam.user_identity_display_source (
  user_id      text PRIMARY KEY REFERENCES zzsh_iam.user_identity_state(user_id) ON DELETE CASCADE,
  real_name    text NOT NULL CHECK (char_length(real_name) BETWEEN 1 AND 64),
  id_card_no   text NOT NULL CHECK (char_length(id_card_no) BETWEEN 6 AND 32),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_identity_display_source FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON zzsh_iam.user_identity_display_source TO zzsh_order_milestone_real_1_r;