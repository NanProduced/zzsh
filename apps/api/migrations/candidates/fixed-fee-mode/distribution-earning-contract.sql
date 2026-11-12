-- Candidate only. Preserve the installed v1 guard and make both modes use the shared frozen derivation.
DO $patch$
DECLARE source text;definition text;digest text;start_at integer;end_at integer;
 old_declare text:=$old$posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;$old$;
 first_part text:=$old$n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=CASE WHEN$old$;
 last_part text:=$old$IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL$old$;
 replacement text:=$new$derivation:=zzsh_order.derive_frozen_referral_accrual(NEW.posting_id);
 items:=derivation->'items';posting_hash:=derivation->>'postingDigest';allocation_hash:=derivation->>'allocationDigest';
 SELECT value INTO own_item FROM jsonb_array_elements(items)
  WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF own_item IS NULL THEN RAISE EXCEPTION 'original referral role is not payable' USING ERRCODE='23514'; END IF;
 expected:=(own_item->>'amountCents')::numeric;due_value:=(own_item->>'dueAt')::timestamptz;
 expected_seed:=zzsh_order.frozen_referral_earning_seed(derivation,own_item);
 $new$;
BEGIN
 IF to_regprocedure('zzsh_order.derive_frozen_referral_accrual(text)') IS NULL
  OR to_regprocedure('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'frozen referral derivation is required' USING ERRCODE='55000'; END IF;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.guard_rental_referral_earning()')
   AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS DISTINCT FROM 'cb4d2f8b48926487c6cdf70eca38d5b9b75a8e9a4b378d44ecfc21f8594c984d'
 THEN RAISE EXCEPTION 'installed referral earning guard is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 IF position(old_declare IN definition)=0 OR position(old_declare IN replace(definition,old_declare,''))<>0
  OR position(first_part IN definition)=0 OR position(first_part IN replace(definition,first_part,''))<>0
  OR position(last_part IN definition)=0 OR position(last_part IN replace(definition,last_part,''))<>0
 THEN RAISE EXCEPTION 'referral earning guard patch is absent or ambiguous' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,old_declare,old_declare||' derivation jsonb;');
 start_at:=position(first_part IN definition);end_at:=position(last_part IN definition);
 IF end_at<=start_at THEN RAISE EXCEPTION 'referral earning guard patch order invalid' USING ERRCODE='55000'; END IF;
 definition:=substring(definition FROM 1 FOR start_at-1)||replacement||substring(definition FROM end_at);
 EXECUTE definition;
END $patch$;
