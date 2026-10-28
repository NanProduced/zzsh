-- UNNUMBERED / NOT APPLIED. Master assigns the migration number (0103 applied, 0104 PAY-pending).
-- B5 minimal restricted identity-display store. Read path only; write path, encryption/KMS,
-- provider integration and legacy data migration are explicitly out of scope.
CREATE TABLE IF NOT EXISTS zzsh_iam.user_identity_display_source (
  user_id      uuid PRIMARY KEY REFERENCES zzsh_iam.user_identity_state(user_id) ON DELETE CASCADE,
  real_name    text NOT NULL CHECK (char_length(real_name) BETWEEN 1 AND 64),
  id_card_no   text NOT NULL CHECK (char_length(id_card_no) BETWEEN 6 AND 32),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON zzsh_iam.user_identity_display_source FROM PUBLIC;
-- Grant SELECT only to the API runtime role (role name to be confirmed by Master), e.g.:
-- GRANT SELECT ON zzsh_iam.user_identity_display_source TO zzsh_api_runtime;
