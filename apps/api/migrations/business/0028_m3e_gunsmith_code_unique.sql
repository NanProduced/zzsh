-- M3E follow-up: one opaque code has one firearm owner per game.
CREATE UNIQUE INDEX IF NOT EXISTS "gunsmith_code_game_code_unique"
  ON "zzsh_supply"."gunsmith_code" ("game_id", "code");
