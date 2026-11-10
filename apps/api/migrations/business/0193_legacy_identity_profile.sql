CREATE TABLE zzsh_iam.user_legacy_identity_profile (
  user_id text PRIMARY KEY REFERENCES zzsh_iam.user_identity_state(user_id),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[a-f0-9]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_ref text NOT NULL CHECK (source_ref ~ '^la_user:[0-9]{1,32}$'),
  key_version text NOT NULL CHECK (key_version = 'v1'),
  name_mask text NOT NULL CHECK (char_length(name_mask) BETWEEN 1 AND 64),
  document_mask text NOT NULL CHECK (char_length(document_mask) BETWEEN 1 AND 64),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  authentication_tag text NOT NULL CHECK (authentication_tag ~ '^[A-Za-z0-9_-]{22}$'),
  ciphertext text NOT NULL CHECK (char_length(ciphertext) BETWEEN 1 AND 4096 AND ciphertext ~ '^[A-Za-z0-9_-]+$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_legacy_identity_profile FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TABLE zzsh_iam.user_legacy_identity_profile IS '旧实名资料的受限加密承接，不代表新渠道核验。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.user_id IS '关联的用户身份标识。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.subject_digest IS '关联的旧实名主体摘要。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.source_digest IS '冻结旧用户源记录的摘要。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.source_ref IS '旧用户表及原编号。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.key_version IS '资料加密保护钥版本。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.name_mask IS '用于普通读取的脱敏姓名。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.document_mask IS '用于普通读取的脱敏证件号。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.nonce IS '加密随机数，使用 base64url 编码。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.authentication_tag IS '加密认证标签，使用 base64url 编码。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.ciphertext IS '姓名和证件号的认证加密结果，使用 base64url 编码。';
COMMENT ON COLUMN zzsh_iam.user_legacy_identity_profile.recorded_at IS '本平台承接该资料的时间。';
