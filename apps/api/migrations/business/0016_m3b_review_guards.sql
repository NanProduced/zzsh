-- Forward repair; preserve applied 0015.
ALTER TABLE zzsh_supply.media_asset ADD COLUMN public_storage_key text CHECK (public_storage_key ~ '^[0-9a-f]{64}$');
CREATE FUNCTION zzsh_supply.guard_public_derivative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_storage_key IS DISTINCT FROM OLD.public_storage_key THEN
    RAISE EXCEPTION 'public derivative is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_derivative BEFORE UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_public_derivative();
CREATE FUNCTION zzsh_supply.guard_detail_parents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_table text;
  parent_key text;
  old_id text;
  new_id text;
  parent record;
  parent_game text;
  item_game text;
BEGIN
  parent_table := CASE WHEN TG_TABLE_NAME = 'price_line' THEN 'price_version' ELSE 'term_version' END;
  parent_key := CASE WHEN TG_TABLE_NAME = 'price_line' THEN 'price_version_id' ELSE 'version_id' END;
  IF TG_OP <> 'INSERT' THEN old_id := to_jsonb(OLD)->>parent_key; END IF;
  IF TG_OP <> 'DELETE' THEN new_id := to_jsonb(NEW)->>parent_key; END IF;
  FOR parent IN EXECUTE format('SELECT id, status, game_id FROM zzsh_supply.%I WHERE id = ANY($1) ORDER BY id FOR UPDATE', parent_table)
    USING ARRAY[old_id, new_id]
  LOOP
    IF parent.status = 'SEALED' THEN RAISE EXCEPTION 'sealed detail is immutable' USING ERRCODE = '40001'; END IF;
    IF parent.id = new_id THEN parent_game := parent.game_id; END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF parent_game IS NULL THEN RAISE EXCEPTION 'parent does not exist'; END IF;
  IF TG_TABLE_NAME = 'price_line' THEN
    SELECT game_id INTO item_game FROM zzsh_supply.billable_item WHERE id = NEW.item_id FOR UPDATE;
    IF item_game IS DISTINCT FROM parent_game THEN RAISE EXCEPTION 'price item belongs to another game'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_detail_parents BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.price_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_detail_parents();
CREATE TRIGGER a_detail_parents BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.term_option FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_detail_parents();

CREATE FUNCTION zzsh_supply.guard_version_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.game_id IS DISTINCT FROM OLD.game_id
     OR (OLD.status = 'SEALED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'version identity and sealed content are immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.term_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.agreement_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();

CREATE FUNCTION zzsh_supply.guard_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release is immutable' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER release_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.rule_release FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();

CREATE FUNCTION zzsh_supply.guard_item_semantics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.game_id, NEW.code, NEW.unit, NEW.quantity_scale) IS DISTINCT FROM
     (OLD.id, OLD.game_id, OLD.code, OLD.unit, OLD.quantity_scale)
     AND EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION 'referenced billing semantics require a new item' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_semantics BEFORE UPDATE ON zzsh_supply.billable_item FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_item_semantics();
