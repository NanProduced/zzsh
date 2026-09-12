-- Preserve pre-repair keys. Media realm comes from the recorded upload actor,
-- never from an assumption that user and admin IDs differ.
DO $$
DECLARE
  entry record;
  scope jsonb;
  realm text;
  actor text;
  operation text;
  upgraded text;
BEGIN
  FOR entry IN SELECT scope_key, key, response_body FROM zzsh_supply.idempotency_record FOR UPDATE LOOP
    scope := entry.scope_key::jsonb;
    IF jsonb_array_length(scope) = 4 THEN CONTINUE; END IF;
    IF jsonb_array_length(scope) <> 3 THEN RAISE EXCEPTION 'unrecognized legacy idempotency scope'; END IF;
    actor := scope->>0;
    operation := scope->>1;
    realm := NULL;
    IF operation = 'supply.account.create' THEN realm := 'user';
    ELSIF operation = 'supply.media.upload' THEN
      SELECT uploaded_by_realm INTO realm FROM zzsh_supply.media_asset
      WHERE id = entry.response_body->>'assetId'
        AND actor = CASE WHEN uploaded_by_realm = 'admin' THEN uploaded_by_admin_id ELSE uploaded_by_user_id END;
    ELSIF operation = 'supply.media.upload_intent.create' THEN
      SELECT uploaded_by_realm INTO realm FROM zzsh_supply.media_upload_intent
      WHERE id = entry.response_body->>'intentId'
        AND actor = CASE WHEN uploaded_by_realm = 'admin' THEN uploaded_by_admin_id ELSE uploaded_by_user_id END;
    ELSIF operation LIKE 'supply.game.%' OR operation LIKE 'supply.catalog.%' OR operation LIKE 'supply.rules.%'
       OR operation IN ('supply.media.review', 'supply.media.visibility') THEN realm := 'admin';
    END IF;
    IF realm IS NULL THEN RAISE EXCEPTION 'legacy idempotency actor requires reconciliation'; END IF;
    upgraded := '[' || to_json(realm)::text || ',' || to_json(actor)::text || ',' || to_json(operation)::text || ',' || COALESCE(to_json(scope->>2)::text, 'null') || ']';
    UPDATE zzsh_supply.idempotency_record SET scope_key = upgraded WHERE scope_key = entry.scope_key AND key = entry.key;
  END LOOP;
END $$;
