-- M3E follow-up: keep human-readable provenance on opaque codes.
ALTER TABLE "zzsh_supply"."gunsmith_code"
  ADD COLUMN IF NOT EXISTS "source_note" text
  CHECK ("source_note" IS NULL OR char_length("source_note") <= 500);
