CREATE TABLE zzsh_iam.user_identity_verification_attempt (
  user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  key_digest text NOT NULL CHECK(key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('PENDING','UNKNOWN','COMPLETED')),
  privacy_version_id text NOT NULL REFERENCES zzsh_content.legal_document_version(id),
  privacy_digest text NOT NULL CHECK(privacy_digest ~ '^[a-f0-9]{64}$'),
  disclosure_version text NOT NULL CHECK(disclosure_version='identity-provider-transfer-v1'),
  disclosure_digest text NOT NULL CHECK(disclosure_digest ~ '^[a-f0-9]{64}$'),
  consented_at timestamptz NOT NULL,
  provider_result jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,key_digest),
  CHECK((state='COMPLETED')=(result IS NOT NULL)),
  CHECK(provider_result IS NULL OR jsonb_typeof(provider_result)='object'),
  CHECK(result IS NULL OR jsonb_typeof(result)='object')
);
--> statement-breakpoint
CREATE INDEX user_identity_verification_attempt_rate_idx ON zzsh_iam.user_identity_verification_attempt(user_id,created_at);
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_identity_verification_attempt FROM PUBLIC;
