-- ADM-SCOPE-1: account-level game scope mode.
-- Existing administrators default to ALL_GAMES (no narrowing); SELECTED_GAMES
-- reuses the existing zzsh_supply.admin_supply_scope rows as the assigned set.
ALTER TABLE "zzsh_iam"."admin_security"
  ADD COLUMN IF NOT EXISTS "game_scope_mode" text NOT NULL DEFAULT 'ALL_GAMES';

ALTER TABLE "zzsh_iam"."admin_security"
  DROP CONSTRAINT IF EXISTS "admin_security_game_scope_mode_check";

ALTER TABLE "zzsh_iam"."admin_security"
  ADD CONSTRAINT "admin_security_game_scope_mode_check"
  CHECK ("game_scope_mode" IN ('ALL_GAMES', 'SELECTED_GAMES'));
