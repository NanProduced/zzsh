-- The runtime may discard a guide's working copy without DELETE on content tables.
CREATE FUNCTION zzsh_content.discard_guide_draft(target_item text, target_version text, expected_revision bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM zzsh_content.content_item i
    WHERE i.id = target_item AND i.type = 'RESOURCE' AND i.resource_key LIKE 'guide:%' AND i.revision = expected_revision
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM zzsh_content.content_version d
    WHERE d.id = target_version AND d.item_id = target_item AND d.state = 'DRAFT'
      AND EXISTS (SELECT 1 FROM zzsh_content.content_version p WHERE p.item_id = target_item AND p.state = 'PUBLISHED');
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE zzsh_content.content_item SET revision = revision + 1, updated_at = clock_timestamp() WHERE id = target_item;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION zzsh_content.discard_guide_draft(text, text, bigint) FROM PUBLIC;
