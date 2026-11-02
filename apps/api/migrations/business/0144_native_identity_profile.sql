CREATE TABLE zzsh_iam.user_identity_verified_profile (
  user_id text PRIMARY KEY REFERENCES zzsh_iam.user_identity_subject(user_id),
  subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
  name_hmac text NOT NULL CHECK(name_hmac ~ '^[a-f0-9]{64}$'),
  name_mask text NOT NULL CHECK(char_length(name_mask) BETWEEN 1 AND 64),
  document_mask text NOT NULL CHECK(char_length(document_mask) BETWEEN 1 AND 64),
  provider text NOT NULL CHECK(provider='aliyun-id2meta'),
  provider_reference text NOT NULL CHECK(char_length(provider_reference) BETWEEN 1 AND 256),
  verified_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_identity_verified_profile FROM PUBLIC;
