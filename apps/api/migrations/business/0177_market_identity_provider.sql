-- 保留原实名来源，同时允许云市场二要素核验的独立来源。
ALTER TABLE zzsh_iam.user_identity_verified_profile
  DROP CONSTRAINT user_identity_verified_profile_provider_check;
--> statement-breakpoint
ALTER TABLE zzsh_iam.user_identity_verified_profile
  ADD CONSTRAINT user_identity_verified_profile_provider_check
  CHECK (provider IN ('aliyun-id2meta', 'aliyun-market-id2'));
--> statement-breakpoint
ALTER TABLE zzsh_iam.user_identity_verification_attempt
  DROP CONSTRAINT user_identity_verification_attempt_disclosure_version_check;
--> statement-breakpoint
ALTER TABLE zzsh_iam.user_identity_verification_attempt
  ADD CONSTRAINT user_identity_verification_attempt_disclosure_version_check
  CHECK (disclosure_version IN ('identity-provider-transfer-v1', 'identity-provider-transfer-market-v1'));
--> statement-breakpoint
COMMENT ON COLUMN zzsh_iam.user_identity_verified_profile.provider IS '实名认证提供方：阿里云官方二要素或阿里云市场二要素，须按各自合同追溯。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_iam.user_identity_verification_attempt.disclosure_version IS '本次实名核验提交前由用户确认的对应提供方资料传输说明版本。';
