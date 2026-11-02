CREATE TABLE zzsh_iam.user_identity_subject (
  user_id text PRIMARY KEY REFERENCES zzsh_iam.user_identity_state(user_id),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source IN ('NATIVE_VERIFICATION','LEGACY_IMPORT')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX user_identity_subject_digest_idx ON zzsh_iam.user_identity_subject(subject_digest);
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_identity_subject FROM PUBLIC;
