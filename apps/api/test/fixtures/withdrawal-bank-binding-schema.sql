-- 仅供隔离PG验收的最小fixture；不是已编号的正式迁移，本包不执行。
CREATE TABLE zzsh_order.withdrawal_bank_binding (
 id text PRIMARY KEY CHECK(id ~ '^bank_[a-f0-9]{32}$'),
 user_id text NOT NULL UNIQUE REFERENCES zzsh_auth_user."user"(id),
 revision bigint NOT NULL CHECK(revision > 0),
 sealed_details text NOT NULL CHECK(octet_length(sealed_details) BETWEEN 1 AND 4096 AND jsonb_typeof(sealed_details::jsonb)='object'),
 card_mask text NOT NULL CHECK(card_mask ~ '^\*{4} \*{4} [0-9]{4}$'),
 holder_mask text NOT NULL CHECK(char_length(holder_mask)=3 AND right(holder_mask,2)='**'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION zzsh_order.withdrawal_bank_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'binding initial revision invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'binding identity or revision invalid' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER withdrawal_bank_binding_guard BEFORE INSERT OR UPDATE ON zzsh_order.withdrawal_bank_binding
FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_bank_binding_guard();
