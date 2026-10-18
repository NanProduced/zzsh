CREATE OR REPLACE FUNCTION zzsh_order.check_stored_opening_observations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_stored_opening_review;b zzsh_order.finance_opening_basis;item jsonb;observed zzsh_order.personal_finance_observation;a zzsh_order.finance_observation_admission;actual_count bigint;matching_input bigint;input_document jsonb;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=NEW.basis_id;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT count(*) INTO actual_count FROM zzsh_order.finance_observation_admission WHERE basis_id=NEW.basis_id;
 IF actual_count IS DISTINCT FROM (r.review_canonical::jsonb->>'observationCount')::int THEN RAISE EXCEPTION 'stored observation admission count mismatch' USING ERRCODE='23514'; END IF;
 input_document:=r.input_canonical::jsonb;
 FOR item IN SELECT value FROM jsonb_array_elements(input_document->'admissions') LOOP
  SELECT * INTO a FROM zzsh_order.finance_observation_admission WHERE basis_id=r.basis_id AND source_entity=item->>'sourceEntity' AND source_id=item->>'sourceId';
  SELECT * INTO observed FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=b.source_system AND source_entity=a.source_entity AND source_id=a.source_id;
  SELECT count(*) INTO matching_input FROM jsonb_array_elements(input_document->'observations') v WHERE v=observed.snapshot;
  IF a.basis_id IS NULL OR observed.id IS NULL OR a.user_id IS DISTINCT FROM b.user_id OR a.source_digest IS DISTINCT FROM item->>'sourceDigest'
   OR a.source_event_at IS DISTINCT FROM (item->>'sourceEventAt')::timestamptz OR a.included_in_opening IS DISTINCT FROM (item->>'included')::boolean
   OR observed.user_id IS DISTINCT FROM b.user_id OR observed.legacy_user_id IS DISTINCT FROM b.source_id
   OR observed.source_digest IS DISTINCT FROM a.source_digest OR observed.source_event_at IS DISTINCT FROM a.source_event_at
   OR observed.basis_id IS NOT NULL AND observed.basis_id IS DISTINCT FROM b.id
   OR observed.basis_id IS NOT NULL AND observed.included_in_opening IS DISTINCT FROM a.included_in_opening
   OR observed.basis_id IS NULL AND observed.included_in_opening OR matching_input<>1
  THEN RAISE EXCEPTION 'stored observation fact/admission mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
