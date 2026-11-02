-- Source-bound maintenance and readers check one object's audit evidence repeatedly.
-- A reviewed concurrent installation may already exist; accept only this exact shape.
DO $audit_object_lookup$
DECLARE idx oid;
BEGIN
  idx := to_regclass('zzsh_iam.audit_event_object_action_outcome_idx');
  IF idx IS NULL THEN
    CREATE INDEX audit_event_object_action_outcome_idx
      ON zzsh_iam.audit_event USING btree (object_id, action, outcome);
    idx := to_regclass('zzsh_iam.audit_event_object_action_outcome_idx');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_am am ON am.oid=c.relam
    JOIN pg_class t ON t.oid=i.indrelid
    WHERE i.indexrelid=idx AND i.indrelid='zzsh_iam.audit_event'::regclass
      AND c.relkind='i' AND c.relowner=t.relowner AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indpred IS NULL AND i.indexprs IS NULL
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
                JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.n)
          = ARRAY['object_id','action','outcome']::text[]
      AND ARRAY(SELECT ns.nspname::text||'.'||op.opcname::text
                FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(opoid,n)
                JOIN pg_opclass op ON op.oid=k.opoid JOIN pg_namespace ns ON ns.oid=op.opcnamespace ORDER BY k.n)
          = ARRAY['pg_catalog.text_ops','pg_catalog.text_ops','pg_catalog.text_ops']::text[]
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption::smallint[]) v WHERE v<>0)
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[],i.indcollation::oid[]) k(attnum,colloid)
                      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                      WHERE a.attcollation<>k.colloid)
  ) THEN
    RAISE EXCEPTION 'AUDIT_OBJECT_LOOKUP_INDEX_SHAPE_MISMATCH';
  END IF;
END
$audit_object_lookup$;
