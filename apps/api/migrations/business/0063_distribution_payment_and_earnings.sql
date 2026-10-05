-- Immutable payment basis and typed rental referral ledger.
-- Source declarations are LOCAL_CONTROLLED; operational resource checks stay in the reviewed runner.

CREATE FUNCTION zzsh_order.canonical_finance_json(value jsonb,depth integer DEFAULT 0) RETURNS text
 LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text;entry record;number_value numeric;
BEGIN
 IF depth<0 OR depth>24 OR value IS NULL THEN RAISE EXCEPTION 'financial JSON depth/value unsupported' USING ERRCODE='23514';END IF;
 CASE jsonb_typeof(value)
 WHEN 'null' THEN RETURN 'null';
 WHEN 'boolean' THEN RETURN value::text;
 WHEN 'string' THEN RETURN value::text;
 WHEN 'number' THEN
  number_value:=value::text::numeric;
  IF number_value<>trunc(number_value) OR abs(number_value)>9007199254740991
  THEN RAISE EXCEPTION 'financial JSON numbers must be safe integers' USING ERRCODE='23514';END IF;
  RETURN number_value::numeric(16,0)::text;
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(zzsh_order.canonical_finance_json(v,depth+1),',' ORDER BY ordinal),'')||']'
   INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS a(v,ordinal);RETURN result;
 WHEN 'object' THEN
  FOR entry IN SELECT key FROM jsonb_each(value) LOOP
   IF entry.key='contentHash' OR entry.key!~'^[ -~]*$'
   THEN RAISE EXCEPTION 'financial canonical object key unsupported' USING ERRCODE='23514';END IF;
  END LOOP;
  SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||zzsh_order.canonical_finance_json(v,depth+1),',' ORDER BY key COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(value) AS e(key,v);RETURN result;
 ELSE RAISE EXCEPTION 'financial JSON type unsupported' USING ERRCODE='23514';
 END CASE;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.canonical_finance_json(jsonb,integer) FROM PUBLIC;


CREATE FUNCTION zzsh_order.derive_payment_referral_inputs(order_id_value text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;v zzsh_order.distribution_policy_version;cfg jsonb;mode text;base numeric;minimum numeric;
 role_name text;party text;own zzsh_order.distribution_participant;relation zzsh_order.invitation_relation;
 parent_row record;graph_closed boolean;level jsonb;status text;pct text;n numeric;d numeric;scale integer;
 item jsonb;items jsonb[]:=ARRAY[]::jsonb[];raw_amounts numeric[]:=ARRAY[0::numeric,0::numeric];i integer;
 uncertain boolean;total numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_id_value;
 IF o.id IS NULL OR o.currency<>'CNY' THEN RAISE EXCEPTION 'original native CNY order required' USING ERRCODE='23514';END IF;
 SELECT p.* INTO v FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version p
  ON p.id=h.current_version_id AND p.scope=h.scope AND p.revision=h.revision WHERE h.scope='LOCAL_CONTROLLED' FOR SHARE OF h;
 cfg:=v.canonical_config::jsonb;
 IF o.quote_snapshot->'schemaVersion'='2'::jsonb THEN mode:=o.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}';END IF;
 IF mode IS NULL OR mode NOT IN('ordinary','custom','fast') THEN mode:=NULL;END IF;
 IF o.quote_snapshot#>>'{platformFullProfit,currency}'='CNY'
  AND o.quote_snapshot#>>'{platformFullProfit,unit}'='yuan'
  AND o.quote_snapshot#>'{platformFullProfit,scale}'='2'::jsonb
  AND jsonb_typeof(o.quote_snapshot#>'{platformFullProfit,amount}')='string'
  AND COALESCE(o.quote_snapshot#>>'{platformFullProfit,amount}','')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$'
 THEN base:=(o.quote_snapshot#>>'{platformFullProfit,amount}')::numeric*100;END IF;
 FOREACH role_name IN ARRAY ARRAY['OWNER_REFERRAL','RENTER_REFERRAL'] LOOP
  party:=CASE WHEN role_name='OWNER_REFERRAL' THEN o.owner_user_id ELSE o.renter_user_id END;
  SELECT * INTO own FROM zzsh_order.distribution_participant WHERE user_id=party;
  SELECT * INTO relation FROM zzsh_order.invitation_relation WHERE child_user_id=party AND type='DISTRIBUTION_LEADER';
  SELECT p.*,CASE WHEN s.account_status IS NULL THEN NULL ELSE NOT u.suspended AND s.account_status='ACTIVE' END AS owner_active
   INTO parent_row FROM zzsh_order.distribution_participant p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
   LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id WHERE p.user_id=relation.parent_user_id;
  graph_closed:=false;
  IF relation.parent_user_id IS NOT NULL THEN
   WITH RECURSIVE chain(user_id,path,cyclic) AS (
    SELECT relation.parent_user_id,ARRAY[relation.parent_user_id],false UNION ALL
    SELECT r.parent_user_id,c.path||r.parent_user_id,r.parent_user_id=ANY(c.path)
     FROM chain c JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER' WHERE NOT c.cyclic
   ) SELECT COALESCE(bool_and(NOT c.cyclic AND COALESCE(
      p.leader_knowledge='KNOWN_NONE' AND r.parent_user_id IS NULL
      OR p.leader_knowledge='KNOWN_PARENT' AND r.parent_user_id IS NOT NULL,false)),false)
    INTO graph_closed FROM chain c LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=c.user_id
    LEFT JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER';
  END IF;
  pct:=NULL;n:=NULL;d:=NULL;level:=NULL;
  IF v.id IS NULL THEN status:='UNKNOWN_POLICY';
  ELSIF cfg->'enabled'<>'true'::jsonb THEN status:='SKIPPED_DISABLED';
  ELSIF mode IS NULL THEN status:='UNKNOWN_MODE';
  ELSIF mode='fast' THEN status:='SKIPPED_FAST';
  ELSIF NOT(cfg->'accountModes' ? mode) THEN status:='SKIPPED_MODE';
  ELSIF own.leader_knowledge='KNOWN_NONE' AND relation.id IS NULL THEN status:='SKIPPED_NO_PARENT';
  ELSIF own.leader_knowledge IS DISTINCT FROM 'KNOWN_PARENT' OR relation.id IS NULL OR NOT graph_closed
    OR relation.parent_user_id=party OR relation.source_digest IS NULL THEN status:='UNKNOWN_RELATION';
  ELSIF parent_row.user_id IS NULL OR parent_row.owner_active IS NULL OR parent_row.eligibility='UNKNOWN'
    OR parent_row.commission_frozen IS NULL THEN status:='UNKNOWN_PARTICIPANT';
  ELSIF NOT parent_row.owner_active OR parent_row.eligibility='INELIGIBLE' OR parent_row.commission_frozen THEN status:='SKIPPED_INELIGIBLE';
  ELSE
   SELECT value INTO level FROM jsonb_array_elements(cfg->'levels') WHERE value->>'code'=parent_row.level_code;
   IF level IS NULL THEN status:='UNKNOWN_LEVEL';
   ELSE
    pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN level->>'ownerPercent' ELSE level->>'renterPercent' END;
    scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
    n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
    status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
   END IF;
  END IF;
  item:=jsonb_build_object('role',role_name,'partyUserId',party,'status',status,
   'beneficiaryUserId',parent_row.user_id,'relationId',relation.id,'relationDigest',relation.source_digest,
   'levelCode',parent_row.level_code,'percent',pct,'ratio',CASE WHEN pct IS NULL THEN NULL ELSE jsonb_build_object('numerator',n::numeric(24,0)::text,'denominator',d::numeric(24,0)::text) END,'estimatedCents',NULL);
  items:=array_append(items,item);
 END LOOP;
 IF v.id IS NOT NULL AND base IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM unnest(items) r WHERE r->>'status' LIKE 'UNKNOWN%') INTO uncertain;
  IF NOT uncertain THEN
   FOR i IN 1..2 LOOP
    IF items[i]->>'status'='ELIGIBLE' THEN raw_amounts[i]:=floor(base*(items[i]#>>'{ratio,numerator}')::numeric/(items[i]#>>'{ratio,denominator}')::numeric+0.5);END IF;
   END LOOP;
  END IF;
  total:=raw_amounts[1]+raw_amounts[2];minimum:=(cfg->>'minimumAccrualCents')::numeric;
  FOR i IN 1..2 LOOP
   IF items[i]->>'status'='ELIGIBLE' THEN
    IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);
    ELSE items[i]:=jsonb_set(items[i],'{estimatedCents}',to_jsonb(raw_amounts[i]::numeric(24,0)::text));END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('policyVersion',v.id,'policyDigest',v.config_digest,'policyConfig',cfg,'accountMode',mode,
  'estimateBaseCents',CASE WHEN base IS NULL THEN NULL ELSE base::numeric(24,0)::text END,'roles',to_jsonb(items));
END $$;
REVOKE ALL ON FUNCTION zzsh_order.derive_payment_referral_inputs(text) FROM PUBLIC;
-- Exact runtime EXECUTE is required only via the reviewed basis guard/ACL package.


CREATE TABLE zzsh_order.distribution_order_admission (
 id text PRIMARY KEY,order_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_order(id),
 resource_oid oid NOT NULL,resource_name text NOT NULL,resource_marker text NOT NULL CHECK(resource_marker='zzsh:order-reservation-test:v1'),
 approval_digest text NOT NULL CHECK(approval_digest~'^[0-9a-f]{64}$'),
 native_creation_audit_id text NOT NULL REFERENCES zzsh_iam.audit_event(id),
 revision bigint NOT NULL CHECK(revision=1),active boolean NOT NULL,
 admitted_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>admitted_at),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 UNIQUE(id,order_id,revision)
);
CREATE TRIGGER distribution_order_admission_immutable BEFORE UPDATE OR DELETE ON zzsh_order.distribution_order_admission
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_distribution_order_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_row zzsh_order.rental_order;
BEGIN
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$' OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.resource_marker IS DISTINCT FROM (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'order admission requires exact maintained order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event WHERE id=NEW.native_creation_audit_id AND action='order.reservation.created'
   AND object_type='rental_order' AND object_id=NEW.order_id AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'new native order origin/payment state is not proved' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER distribution_order_admission_guard BEFORE INSERT ON zzsh_order.distribution_order_admission
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_order_admission();
CREATE TABLE zzsh_order.payment_distribution_basis (
 id text PRIMARY KEY,order_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_order(id),
 payment_confirmation_id text NOT NULL UNIQUE REFERENCES zzsh_order.payment_confirmation(id),
 admission_id text NOT NULL,admission_revision bigint NOT NULL,
 canonical_basis text NOT NULL,basis_digest text NOT NULL CHECK(basis_digest~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(admission_id,order_id,admission_revision) REFERENCES zzsh_order.distribution_order_admission(id,order_id,revision),
 CHECK(basis_digest=encode(sha256(convert_to(canonical_basis,'UTF8')),'hex')),
 CHECK(jsonb_typeof(canonical_basis::jsonb)='object')
);
CREATE TRIGGER payment_distribution_basis_immutable BEFORE UPDATE OR DELETE ON zzsh_order.payment_distribution_basis
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_payment_distribution_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment zzsh_order.payment_confirmation;order_row zzsh_order.rental_order;doc jsonb:=NEW.canonical_basis::jsonb;derived jsonb;payment_source jsonb;estimate_source jsonb;
BEGIN
 SELECT * INTO payment FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 payment_source:=jsonb_build_object('id',payment.id,'order_id',payment.order_id,'source',payment.source,
  'merchant_scope_id',payment.merchant_scope_id,'provider_transaction_id',payment.provider_transaction_id,
  'merchant_order_no',payment.merchant_order_no,'amount_cents',payment.amount_cents::text,'currency',payment.currency,
  'provider_paid_at',to_char(payment.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'accepted_at',to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF payment.id IS NULL OR payment.disposition<>'APPLIED' OR payment.order_id<>NEW.order_id OR order_row.paid_confirmation_id IS DISTINCT FROM payment.id
  OR doc->>'schema' IS DISTINCT FROM 'payment-distribution-basis.v1' OR doc->>'orderId' IS DISTINCT FROM NEW.order_id
  OR doc->>'confirmationId' IS DISTINCT FROM NEW.payment_confirmation_id OR doc->>'admissionId' IS DISTINCT FROM NEW.admission_id
  OR doc->>'admissionRevision' IS DISTINCT FROM NEW.admission_revision::text OR doc->>'gameId' IS DISTINCT FROM order_row.game_id
  OR doc->>'currency' IS DISTINCT FROM order_row.currency OR doc->>'acceptedAt' IS DISTINCT FROM to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 THEN RAISE EXCEPTION 'basis must belong to the same first APPLIED transaction and original order' USING ERRCODE='23514';END IF;
 IF doc->>'paymentDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(payment_source),'UTF8')),'hex')
  OR NEW.canonical_basis IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
 THEN RAISE EXCEPTION 'basis or payment source canonical digest differs' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(doc->'roles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'two frozen roles required' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'roles')<>2 OR (SELECT count(DISTINCT r->>'role') FROM jsonb_array_elements(doc->'roles') r WHERE r->>'role' IN('RENTER_REFERRAL','OWNER_REFERRAL'))<>2
 THEN RAISE EXCEPTION 'basis rental roles are not complete' USING ERRCODE='23514';END IF;
 derived:=zzsh_order.derive_payment_referral_inputs(NEW.order_id);
 IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' OR doc->'accountMode' IS DISTINCT FROM derived->'accountMode'
  OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents' OR doc->'roles' IS DISTINCT FROM derived->'roles'
 THEN RAISE EXCEPTION 'payment basis differs from original policy, role, relation or rounded estimate' USING ERRCODE='23514';END IF;
 IF derived->'estimateBaseCents'='null'::jsonb THEN
  IF doc->'estimateDigest' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'unknown estimate cannot claim a digest' USING ERRCODE='23514';END IF;
 ELSE
  estimate_source:=jsonb_build_object('definition','QUOTE_PLATFORM_FULL_PROFIT_ESTIMATE_V1','quote',order_row.quote_snapshot-'contentHash');
  IF order_row.quote_snapshot?'contentHash' THEN estimate_source:=estimate_source||jsonb_build_object('listingHash',order_row.quote_snapshot->'contentHash');END IF;
  IF doc->>'estimateDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(estimate_source),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'estimate digest differs from immutable original quote' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_distribution_basis_guard BEFORE INSERT ON zzsh_order.payment_distribution_basis
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_distribution_basis();
-- payment_confirmation is immutable (0036); admission can only be created for an
-- unpaid order. Enforce first-acceptance co-commit in both directions instead of
-- comparing a possible subtransaction xmin to the top-level xid.
CREATE FUNCTION zzsh_order.check_payment_distribution_basis_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_id_value text;p zzsh_order.payment_confirmation;a zzsh_order.distribution_order_admission;b zzsh_order.payment_distribution_basis;
BEGIN
 IF TG_TABLE_NAME='payment_confirmation' THEN payment_id_value:=NEW.id;
 ELSE payment_id_value:=NEW.payment_confirmation_id;END IF;
 SELECT * INTO p FROM zzsh_order.payment_confirmation WHERE id=payment_id_value;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=p.order_id;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE payment_confirmation_id=p.id;
 IF b.id IS NOT NULL AND (p.disposition IS DISTINCT FROM 'APPLIED' OR a.id IS NULL
  OR b.order_id IS DISTINCT FROM p.order_id OR b.admission_id IS DISTINCT FROM a.id
  OR b.admission_revision IS DISTINCT FROM a.revision OR NOT a.active
  OR p.accepted_at<a.admitted_at OR p.accepted_at>=a.expires_at)
 THEN RAISE EXCEPTION 'basis is outside the original admitted APPLIED acceptance' USING ERRCODE='23514';END IF;
 IF p.disposition='APPLIED' AND a.active AND p.accepted_at>=a.admitted_at AND p.accepted_at<a.expires_at AND b.id IS NULL
 THEN RAISE EXCEPTION 'admitted first APPLIED acceptance requires its same-transaction original basis' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER applied_distribution_basis_pair AFTER INSERT ON zzsh_order.payment_confirmation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_payment_distribution_basis_pair();
CREATE CONSTRAINT TRIGGER distribution_basis_applied_pair AFTER INSERT ON zzsh_order.payment_distribution_basis
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_payment_distribution_basis_pair();
-- Least privilege proposal: runtime SELECT admission only; SELECT+exact-column INSERT basis.
-- Guard refinement still required: admission party closure and exact policy/role/source digest
-- validation and admission expiry between prepare and actual acceptance. Reverse APPLIED/basis
-- closure is a candidate above, not yet PG-validated. No DDL/ACL/config/ORDER writes have run.


CREATE TABLE zzsh_order.controlled_payment_declaration (
 id text PRIMARY KEY CHECK(id~'^[A-Za-z0-9_-]{1,128}$'),
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED_DECLARED_PAYMENT'),
 source_event_key text NOT NULL UNIQUE,
 resource_oid oid NOT NULL,app_id text NOT NULL,merchant_scope_id text NOT NULL,
 admission_id text NOT NULL,admission_revision bigint NOT NULL,
 order_id text NOT NULL,merchant_order_no text NOT NULL,provider_transaction_id text NOT NULL,
 canonical_payment text NOT NULL,payment_digest text NOT NULL,
 approval_digest text NOT NULL CHECK(approval_digest~'^[0-9a-f]{64}$'),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(admission_id,order_id,admission_revision) REFERENCES zzsh_order.distribution_order_admission(id,order_id,revision),
 UNIQUE(merchant_scope_id,provider_transaction_id),
 CHECK(payment_digest=encode(sha256(convert_to(canonical_payment,'UTF8')),'hex')),
 CHECK(jsonb_typeof(canonical_payment::jsonb)='object'),
 CHECK(app_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND merchant_scope_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE FUNCTION zzsh_order.guard_controlled_payment_declaration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a zzsh_order.distribution_order_admission;doc jsonb:=NEW.canonical_payment::jsonb;key_name text;
BEGIN
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$'
  OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_oid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.source_event_key IS DISTINCT FROM 'local-controlled-payment:'||NEW.id
 THEN RAISE EXCEPTION 'controlled declaration requires exact maintained local order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE id=NEW.admission_id AND order_id=NEW.order_id;
 IF a.id IS NULL OR NOT a.active OR a.revision<>NEW.admission_revision OR a.approval_digest<>NEW.approval_digest
  OR a.resource_oid<>NEW.resource_oid OR a.admitted_at>clock_timestamp() OR a.expires_at<=clock_timestamp()
  OR a.resource_name<>current_database() OR a.resource_marker IS DISTINCT FROM
   (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'controlled source outside original approved admission' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(doc))<>7 THEN RAISE EXCEPTION 'exact payment input required' USING ERRCODE='23514';END IF;
 FOREACH key_name IN ARRAY ARRAY['orderId','merchantOrderNo','providerTransactionId','amountCents','currency','providerPaidAt','requestId'] LOOP
  IF jsonb_typeof(doc->key_name) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'payment source field absent or not string' USING ERRCODE='23514';END IF;
 END LOOP;
 IF doc->>'orderId' IS DISTINCT FROM NEW.order_id OR doc->>'merchantOrderNo' IS DISTINCT FROM NEW.merchant_order_no
  OR doc->>'providerTransactionId' IS DISTINCT FROM NEW.provider_transaction_id
  OR (doc->>'amountCents')!~'^(0|[1-9][0-9]{0,24})$' OR (doc->>'currency')!~'^[A-Z]{3}$'
  OR (doc->>'providerPaidAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 THEN RAISE EXCEPTION 'payment declaration differs from original immutable tuple' USING ERRCODE='23514';END IF;
 FOREACH key_name IN ARRAY ARRAY['orderId','merchantOrderNo','providerTransactionId','requestId'] LOOP
  IF (doc->>key_name)!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'payment source identifier invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 IF to_char((doc->>'providerPaidAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>doc->>'providerPaidAt'
 THEN RAISE EXCEPTION 'payment source timestamp invalid' USING ERRCODE='23514';END IF;
 NEW.declared_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER controlled_payment_declaration_guard BEFORE INSERT ON zzsh_order.controlled_payment_declaration
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_controlled_payment_declaration();
CREATE TRIGGER controlled_payment_declaration_immutable BEFORE UPDATE OR DELETE ON zzsh_order.controlled_payment_declaration
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER controlled_payment_declaration_no_truncate BEFORE TRUNCATE ON zzsh_order.controlled_payment_declaration
 FOR EACH STATEMENT EXECUTE FUNCTION zzsh_order.finance_immutable();
REVOKE ALL ON TABLE zzsh_order.controlled_payment_declaration FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_controlled_payment_declaration() FROM PUBLIC;
-- Runtime SELECT only, exact role ACL in the reviewed resource package. Maintenance INSERT
-- requires reviewed source IDs, canonical inputs and actor; no generic source-creation route.
-- No automatic reapply: missing acceptance is UNKNOWN; recovery reads original source only.


CREATE TABLE zzsh_order.rental_referral_earning (
 id text PRIMARY KEY,economic_root_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_economic_root(id),economic_key text NOT NULL UNIQUE,
 order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),payment_confirmation_id text NOT NULL REFERENCES zzsh_order.payment_confirmation(id),
 posting_id text NOT NULL REFERENCES zzsh_order.settlement_posting(id),beneficiary_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 beneficiary_role text NOT NULL CHECK(beneficiary_role IN('RENTER_REFERRAL','OWNER_REFERRAL')),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>=0),due_at timestamptz NOT NULL,
 basis_digest text NOT NULL CHECK(basis_digest~'^[0-9a-f]{64}$'),posting_digest text NOT NULL CHECK(posting_digest~'^[0-9a-f]{64}$'),
 canonical_seed text NOT NULL,seed_digest text NOT NULL CHECK(seed_digest=encode(sha256(convert_to(canonical_seed,'UTF8')),'hex')),
 state text NOT NULL CHECK(state IN('PENDING','SETTLED','REVOKED','RECOVERY_REQUIRED')),
 funds_disposition text NOT NULL CHECK(funds_disposition IN('PENDING','SETTLED','REVOKED')),
 recovery_required_cents numeric(24,0),version bigint NOT NULL CHECK(version>0),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(id=economic_root_id),UNIQUE(order_id,beneficiary_user_id,beneficiary_role),
 CHECK((state='PENDING' AND funds_disposition='PENDING' AND recovery_required_cents IS NULL)
  OR(state='SETTLED' AND funds_disposition='SETTLED' AND recovery_required_cents IS NULL)
  OR(state='REVOKED' AND funds_disposition='REVOKED' AND recovery_required_cents IS NULL)
  OR(state='RECOVERY_REQUIRED' AND funds_disposition='SETTLED' AND amount_cents>0 AND recovery_required_cents=amount_cents))
);
CREATE TABLE zzsh_order.rental_referral_reversal_source (
 id text PRIMARY KEY,earning_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_referral_earning(id),
 scope text NOT NULL CHECK(scope='LOCAL_CONTROLLED'),basis_digest text NOT NULL CHECK(basis_digest~'^[0-9a-f]{64}$'),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>=0),canonical_source text NOT NULL,
 source_digest text NOT NULL CHECK(source_digest=encode(sha256(convert_to(canonical_source,'UTF8')),'hex')),
 approval_digest text NOT NULL CHECK(approval_digest~'^[0-9a-f]{64}$'),created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(COALESCE(jsonb_typeof(canonical_source::jsonb)='object'
  AND canonical_source::jsonb->>'schema'='rental-referral-reversal.v1'
  AND canonical_source::jsonb->>'scope'=scope AND canonical_source::jsonb->>'earningId'=earning_id
  AND canonical_source::jsonb->>'basisDigest'=basis_digest AND canonical_source::jsonb->>'amountCents'=amount_cents::text,false))
);
CREATE TRIGGER referral_reversal_source_immutable BEFORE UPDATE OR DELETE ON zzsh_order.rental_referral_reversal_source
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.rental_referral_transition (
 id text PRIMARY KEY,earning_id text NOT NULL REFERENCES zzsh_order.rental_referral_earning(id),
 action text NOT NULL CHECK(action IN('ACCRUE','SETTLE','REVOKE','RECOVER')),expected_version bigint NOT NULL CHECK(expected_version>=0),
 result_version bigint NOT NULL CHECK(result_version=expected_version+1),finance_event_id text UNIQUE REFERENCES zzsh_order.finance_event(id),
 reversal_source_id text REFERENCES zzsh_order.rental_referral_reversal_source(id),source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(earning_id,action),
 CHECK((action='ACCRUE' AND expected_version=0 AND result_version=1 AND reversal_source_id IS NULL AND finance_event_id IS NOT NULL)
  OR(action='SETTLE' AND expected_version>0 AND reversal_source_id IS NULL AND finance_event_id IS NOT NULL)
  OR(action='REVOKE' AND expected_version>0 AND reversal_source_id IS NOT NULL)
  OR(action='RECOVER' AND expected_version>0 AND reversal_source_id IS NOT NULL AND finance_event_id IS NOT NULL))
);
CREATE TRIGGER referral_transition_immutable BEFORE UPDATE OR DELETE ON zzsh_order.rental_referral_transition
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE INDEX referral_earning_self ON zzsh_order.rental_referral_earning(beneficiary_user_id,created_at,id);
CREATE INDEX referral_earning_due ON zzsh_order.rental_referral_earning(due_at,id) WHERE state='PENDING';
-- Required, NOT YET IMPLEMENTED here:
-- 1) Append-only origin/reversal admission and exact first-payment policy/role/posting derivation.
-- 2) EARNING_PENDING/SETTLED/REVOKED expected lines in the SAME existing ledger (zero has zero lines).
-- 3) Restrict current broad non-OPENING withdrawal triggers and non-intent opening triggers to their own kinds;
--    do not edit frozen0058/0059. Preserve their guards while dispatching new typed earning kinds.
-- 4) Bidirectional earning/action/event/line closure, user locks, expected wallet ledger revision and CAS.
-- 5) RECOVERY_REQUIRED has no new ledger debit; debt+originalSETTLED remain. Prevent new withdrawal until reconciled.
-- 6) Runtime exact INSERT/UPDATE columns; no reversal-source/seed/frozen-source edits and no empty wallet inference.


ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
  OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL') AND basis_id IS NULL));
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED'));
DROP TRIGGER finance_root_guard ON zzsh_order.finance_economic_root;
CREATE TRIGGER finance_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN(NEW.source_kind='LEGACY_OPENING') EXECUTE FUNCTION zzsh_order.guard_finance_root();
DROP TRIGGER withdrawal_event_guard ON zzsh_order.finance_event;
CREATE TRIGGER withdrawal_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind IN('RESERVE','RELEASE','PAYOUT')) EXECUTE FUNCTION zzsh_order.guard_withdrawal_event();
DROP TRIGGER withdrawal_event_batch_guard ON zzsh_order.finance_event;
CREATE CONSTRAINT TRIGGER withdrawal_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.kind IN('RESERVE','RELEASE','PAYOUT')) EXECUTE FUNCTION zzsh_order.check_withdrawal_batch();
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId')) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId')) EXECUTE FUNCTION zzsh_order.check_finance_batch();
ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts,DROP CONSTRAINT settlement_ledger_counterparty,
 ADD CONSTRAINT settlement_ledger_accounts CHECK((posting_id IS NOT NULL AND account_code IN('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
  OR(finance_event_id IS NOT NULL AND account_code IN('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE','WALLET_RESERVED','PAYOUT_CLEARING','WITHDRAW_FEE','WALLET_PENDING_EARNINGS','DISTRIBUTION_EXPENSE'))),
 ADD CONSTRAINT settlement_ledger_counterparty CHECK((account_code IN('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED','WALLET_PENDING_EARNINGS') AND counterparty_user_id IS NOT NULL)
  OR(account_code NOT IN('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED','WALLET_PENDING_EARNINGS') AND counterparty_user_id IS NULL));
CREATE FUNCTION zzsh_order.earning_expected_lines(event_id_value text)
 RETURNS TABLE(line_no integer,account_code text,debit_cents numeric,credit_cents numeric,counterparty_user_id text,source_payment_confirmation_id text)
 LANGUAGE plpgsql STABLE AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;from_settled boolean;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=event_id_value;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 IF r.id IS NULL OR r.amount_cents=0 THEN RETURN;END IF;
 IF e.kind='EARNING_PENDING' THEN
  RETURN QUERY VALUES(1,'DISTRIBUTION_EXPENSE',r.amount_cents,0::numeric,NULL::text,r.payment_confirmation_id),(2,'WALLET_PENDING_EARNINGS',0::numeric,r.amount_cents,r.beneficiary_user_id,r.payment_confirmation_id);
 ELSIF e.kind='EARNING_SETTLED' THEN
  RETURN QUERY VALUES(1,'WALLET_PENDING_EARNINGS',r.amount_cents,0::numeric,r.beneficiary_user_id,r.payment_confirmation_id),(2,'WALLET_AVAILABLE',0::numeric,r.amount_cents,r.beneficiary_user_id,r.payment_confirmation_id);
 ELSIF e.kind='EARNING_REVOKED' THEN
  SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_event WHERE economic_root_id=r.economic_root_id AND kind='EARNING_SETTLED') INTO from_settled;
  RETURN QUERY VALUES(1,CASE WHEN from_settled THEN 'WALLET_AVAILABLE' ELSE 'WALLET_PENDING_EARNINGS' END,r.amount_cents,0::numeric,r.beneficiary_user_id,r.payment_confirmation_id),(2,'DISTRIBUTION_EXPENSE',0::numeric,r.amount_cents,NULL::text,r.payment_confirmation_id);
 END IF;
END $$;
CREATE FUNCTION zzsh_order.guard_earning_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.rental_referral_earning;version_now bigint;available numeric;
BEGIN
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=NEW.economic_root_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.subject_user_id FOR UPDATE;
 SELECT ledger_revision INTO version_now FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF r.id IS NULL OR NEW.subject_user_id<>r.beneficiary_user_id OR version_now IS DISTINCT FROM NEW.expected_ledger_revision
 THEN RAISE EXCEPTION 'earning event lacks exact source/wallet revision' USING ERRCODE='23514';END IF;
 IF NEW.kind='EARNING_PENDING' AND(r.created_xid<>pg_current_xact_id() OR r.state<>'PENDING' OR r.version<>1)
  OR NEW.kind='EARNING_SETTLED' AND(r.state<>'PENDING' OR clock_timestamp()<r.due_at)
  OR NEW.kind='EARNING_REVOKED' AND r.state NOT IN('PENDING','SETTLED','RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'earning event state/due/source transaction invalid' USING ERRCODE='23514';END IF;
 IF NEW.kind='EARNING_REVOKED' AND r.state IN('SETTLED','RECOVERY_REQUIRED') THEN
  SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
   WHERE counterparty_user_id=r.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
  IF available<r.amount_cents THEN RAISE EXCEPTION 'insufficient available requires recovery, no debit' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER earning_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind IN('EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED')) EXECUTE FUNCTION zzsh_order.guard_earning_event();
CREATE FUNCTION zzsh_order.guard_earning_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 IF r.id IS NULL OR e.created_xid<>pg_current_xact_id() OR NEW.details->>'earningId' IS DISTINCT FROM r.id
  OR NEW.details->>'earningRole' IS DISTINCT FROM r.beneficiary_role OR NEW.details->>'scope' IS DISTINCT FROM 'LOCAL_CONTROLLED'
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.earning_expected_lines(e.id) x WHERE
   (NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id,NEW.source_payment_confirmation_id)
    IS NOT DISTINCT FROM(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id))
 THEN RAISE EXCEPTION 'earning line differs from exact original template' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER earning_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'earningId') EXECUTE FUNCTION zzsh_order.guard_earning_entry();
CREATE FUNCTION zzsh_order.check_earning_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;r zzsh_order.rental_referral_earning;lines integer;dr numeric;cr numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN target:=NEW.id;
 ELSE target:=NEW.finance_event_id;END IF;
 SELECT x.* INTO r FROM zzsh_order.rental_referral_earning x JOIN zzsh_order.finance_event e ON e.economic_root_id=x.economic_root_id WHERE e.id=target;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=target;
 IF r.id IS NULL OR lines<>(SELECT count(*) FROM zzsh_order.earning_expected_lines(target)) OR dr<>r.amount_cents OR cr<>r.amount_cents
 THEN RAISE EXCEPTION 'earning batch is missing, duplicated or unbalanced' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER earning_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.kind IN('EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED')) EXECUTE FUNCTION zzsh_order.check_earning_batch();
CREATE CONSTRAINT TRIGGER earning_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'earningId') EXECUTE FUNCTION zzsh_order.check_earning_batch();
-- STILL REQUIRED before this is an executable financial migration:
-- exact native root/seed/policy/role/amount/posting derivation; state CAS+immutable columns;
-- root/earning/transition/event bidirectional closure; approved reversal-source guard;
-- wallet revision/security-definer triggers+least columns; zero event validation; old/native genesis;
-- write permission resource admission and real concurrency/negative PG window.
CREATE FUNCTION zzsh_order.guard_native_earning_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.payment_distribution_basis;doc jsonb;
BEGIN
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.source_id;doc:=b.canonical_basis::jsonb;
 IF b.id IS NULL OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'rental_order'
  OR NEW.policy_version IS DISTINCT FROM doc->>'policyVersion' OR NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'roles') role WHERE role->>'role'=NEW.beneficiary_role
    AND role->>'beneficiaryUserId'=NEW.subject_user_id AND role->>'status'='ELIGIBLE')
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.subject_user_id)
 THEN RAISE EXCEPTION 'native earning root lacks original eligible payment role/wallet origin' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER native_earning_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_RENTAL_REFERRAL') EXECUTE FUNCTION zzsh_order.guard_native_earning_root();
CREATE FUNCTION zzsh_order.guard_rental_referral_earning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.payment_distribution_basis;p zzsh_order.settlement_posting;root zzsh_order.finance_economic_root;doc jsonb;role jsonb;seed jsonb;base numeric;expected numeric;n numeric;d numeric;available numeric;pair_total numeric;pair_role jsonb;
 posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'earning obligation cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.economic_root_id,NEW.economic_key,NEW.order_id,NEW.payment_confirmation_id,NEW.posting_id,NEW.beneficiary_user_id,NEW.beneficiary_role,NEW.amount_cents,NEW.due_at,NEW.basis_digest,NEW.posting_digest,NEW.canonical_seed,NEW.seed_digest,NEW.created_xid,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.economic_root_id,OLD.economic_key,OLD.order_id,OLD.payment_confirmation_id,OLD.posting_id,OLD.beneficiary_user_id,OLD.beneficiary_role,OLD.amount_cents,OLD.due_at,OLD.basis_digest,OLD.posting_digest,OLD.canonical_seed,OLD.seed_digest,OLD.created_xid,OLD.created_at)
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'original earning source/amount/due immutable and next CAS required' USING ERRCODE='40001';END IF;
  IF NOT(OLD.state='PENDING' AND NEW.state IN('SETTLED','REVOKED') OR OLD.state='SETTLED' AND NEW.state IN('REVOKED','RECOVERY_REQUIRED') OR OLD.state='RECOVERY_REQUIRED' AND NEW.state='REVOKED')
  THEN RAISE EXCEPTION 'earning state transition invalid' USING ERRCODE='23514';END IF;
  IF NEW.state='SETTLED' AND clock_timestamp()<OLD.due_at THEN RAISE EXCEPTION 'earning cannot settle before original due' USING ERRCODE='23514';END IF;
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.beneficiary_user_id FOR UPDATE;
  IF NEW.state='RECOVERY_REQUIRED' THEN
   SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
    WHERE counterparty_user_id=NEW.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
   IF available>=OLD.amount_cents OR NEW.recovery_required_cents IS DISTINCT FROM OLD.amount_cents OR NEW.funds_disposition<>'SETTLED'
   THEN RAISE EXCEPTION 'recovery requires actual shortfall and original settled funds' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=NEW.posting_id AND order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;doc:=b.canonical_basis::jsonb;seed:=NEW.canonical_seed::jsonb;
 SELECT value INTO role FROM jsonb_array_elements(doc->'roles') WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF b.id IS NULL OR p.id IS NULL OR root.id IS NULL OR root.created_xid<>pg_current_xact_id() OR root.source_id<>NEW.order_id
  OR root.subject_user_id<>NEW.beneficiary_user_id OR root.beneficiary_role<>NEW.beneficiary_role OR root.source_digest<>NEW.posting_digest
  OR NEW.basis_digest<>b.basis_digest OR role IS NULL OR role->>'status'<>'ELIGIBLE'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND(p.approval_request_id IS NULL OR p.approval_requested_by IS NULL
   OR p.approval_approved_by IS NULL OR p.approval_requested_by=p.approval_approved_by
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
  OR NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.funds_disposition<>'PENDING' OR NEW.recovery_required_cents IS NOT NULL
 THEN RAISE EXCEPTION 'earning must derive from original closed posting/payment role' USING ERRCODE='23514';END IF;
 n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=p.platform_contribution_cents-p.compensation_fee_cents;
 IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'original referral ratio invalid' USING ERRCODE='23514';END IF;
 expected:=floor(base*n/d+0.5);
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 -- Validate the complete frozen pair even when only one earning is being inserted.
 -- Otherwise direct SQL could mint two individually valid shares exceeding the base.
 pair_total:=0;
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') LOOP
  IF pair_role->>'status' LIKE 'UNKNOWN%' THEN RAISE EXCEPTION 'unknown counterpart cannot authorize partial accrual' USING ERRCODE='23514';END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',NEW.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',floor(base*n/d+0.5)::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
   IF pair_role->>'role'=NEW.beneficiary_role AND pair_role->>'beneficiaryUserId'=NEW.beneficiary_user_id THEN own_item:=item;END IF;
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514';END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',NEW.order_id,
  'confirmationId',NEW.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 expected_seed:=jsonb_build_object('id',NEW.id,'economicKey',own_item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order','id',NEW.order_id,
   'digest',posting_hash,'eventAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'beneficiaryUserId',NEW.beneficiary_user_id,'role',NEW.beneficiary_role,'policyVersion',doc->>'policyVersion',
  'policyDigest',doc->>'policyDigest','baseDigest',allocation_hash,'relationDigest',role->>'relationDigest',
  'amountCents',expected::numeric(24,0)::text,'dueAt',due_text,
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(own_item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1');
 IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL
  OR NEW.posting_digest IS DISTINCT FROM posting_hash OR NEW.economic_key IS DISTINCT FROM own_item->>'economicKey'
  OR NEW.id IS DISTINCT FROM 'earning_'||encode(sha256(convert_to(NEW.economic_key,'UTF8')),'hex')
  OR seed IS DISTINCT FROM expected_seed OR NEW.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
 THEN RAISE EXCEPTION 'earning amount/due/seed differs from original frozen derivation' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER rental_referral_earning_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.rental_referral_earning
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_rental_referral_earning();
CREATE FUNCTION zzsh_order.guard_referral_transition_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.rental_referral_earning;e zzsh_order.finance_event;s zzsh_order.rental_referral_reversal_source;expected_kind text;expected_digest text;
BEGIN
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 IF r.id IS NULL OR NEW.result_version IS DISTINCT FROM r.version
 THEN RAISE EXCEPTION 'transition receipt must describe its exact accepted version' USING ERRCODE='23514';END IF;
 IF NEW.action='ACCRUE' THEN expected_kind:='EARNING_PENDING';expected_digest:=r.posting_digest;
 ELSIF NEW.action='SETTLE' THEN expected_kind:='EARNING_SETTLED';expected_digest:=r.seed_digest;
 ELSE
  SELECT * INTO s FROM zzsh_order.rental_referral_reversal_source WHERE id=NEW.reversal_source_id;
  IF s.id IS NULL OR s.earning_id<>r.id OR s.basis_digest<>r.basis_digest OR s.amount_cents<>r.amount_cents
  THEN RAISE EXCEPTION 'transition reversal source does not belong to the original earning' USING ERRCODE='23514';END IF;
  expected_kind:='EARNING_REVOKED';expected_digest:=s.source_digest;
 END IF;
 IF NEW.source_digest IS DISTINCT FROM expected_digest
 THEN RAISE EXCEPTION 'transition receipt source digest differs from original evidence' USING ERRCODE='23514';END IF;
 IF NEW.finance_event_id IS NULL THEN
  IF NEW.action<>'REVOKE' OR r.state<>'RECOVERY_REQUIRED' OR r.funds_disposition<>'SETTLED'
   OR r.recovery_required_cents IS DISTINCT FROM r.amount_cents OR r.amount_cents<=0
  THEN RAISE EXCEPTION 'only an original outstanding reversal may have no financial event' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  IF e.id IS NULL OR e.economic_root_id<>r.economic_root_id OR e.subject_user_id<>r.beneficiary_user_id
   OR e.kind<>expected_kind OR e.created_xid<>pg_current_xact_id()
   OR NEW.action='ACCRUE' AND r.state<>'PENDING'
   OR NEW.action='SETTLE' AND r.state<>'SETTLED'
   OR NEW.action IN('REVOKE','RECOVER') AND r.state<>'REVOKED'
  THEN RAISE EXCEPTION 'transition receipt financial event is not the exact accepted action' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER referral_transition_source_guard BEFORE INSERT ON zzsh_order.rental_referral_transition
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_transition_source();
CREATE FUNCTION zzsh_order.guard_referral_reversal_declaration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.rental_referral_earning;a zzsh_order.distribution_order_admission;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=r.order_id;
 IF current_user<>owner_name OR r.id IS NULL OR a.id IS NULL OR NEW.scope<>'LOCAL_CONTROLLED'
  OR NEW.approval_digest IS DISTINCT FROM a.approval_digest OR NEW.basis_digest IS DISTINCT FROM r.basis_digest
  OR NEW.amount_cents IS DISTINCT FROM r.amount_cents OR a.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR a.resource_name<>current_database()
 THEN RAISE EXCEPTION 'reversal declaration requires exact maintenance admission and original earning' USING ERRCODE='23514';END IF;
 NEW.declared_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER referral_reversal_declaration_guard BEFORE INSERT ON zzsh_order.rental_referral_reversal_source
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_reversal_declaration();
CREATE FUNCTION zzsh_order.check_earning_reverse_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id text;r zzsh_order.rental_referral_earning;root zzsh_order.finance_economic_root;pending_count integer;settled_count integer;revoked_count integer;action_count integer;e zzsh_order.finance_event;
BEGIN
 IF TG_TABLE_NAME='finance_economic_root' THEN root_id:=NEW.id;
 ELSIF TG_TABLE_NAME IN('rental_referral_earning','finance_event') THEN root_id:=NEW.economic_root_id;
 ELSE root_id:=NEW.earning_id;END IF;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=root_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=root_id;
 IF r.id IS NULL OR root.id IS NULL OR root.source_kind<>'NATIVE_RENTAL_REFERRAL' OR root.source_type<>'NATIVE'
  OR root.source_system<>'zzsh' OR root.source_entity<>'rental_order' OR root.source_id<>r.order_id
  OR root.subject_user_id<>r.beneficiary_user_id OR root.beneficiary_role<>r.beneficiary_role OR root.source_digest<>r.posting_digest
 THEN RAISE EXCEPTION 'earning root and frozen source are not bidirectionally bound' USING ERRCODE='23514';END IF;
 SELECT count(*) FILTER(WHERE kind='EARNING_PENDING'),count(*) FILTER(WHERE kind='EARNING_SETTLED'),count(*) FILTER(WHERE kind='EARNING_REVOKED')
  INTO pending_count,settled_count,revoked_count FROM zzsh_order.finance_event WHERE economic_root_id=root_id;
 IF pending_count<>1 OR settled_count>1 OR revoked_count>1
  OR r.state='PENDING' AND(settled_count<>0 OR revoked_count<>0)
  OR r.state IN('SETTLED','RECOVERY_REQUIRED') AND(settled_count<>1 OR revoked_count<>0)
  OR r.state='REVOKED' AND revoked_count<>1
 THEN RAISE EXCEPTION 'earning state has missing/extra original financial actions' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO action_count FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id;
 IF action_count<>r.version OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='ACCRUE' AND result_version=1)
  OR r.state IN('SETTLED','RECOVERY_REQUIRED') AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='SETTLE')
  OR r.state IN('REVOKED','RECOVERY_REQUIRED') AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='REVOKE' AND reversal_source_id IS NOT NULL)
 THEN RAISE EXCEPTION 'earning has missing original state/action receipt' USING ERRCODE='23514';END IF;
 FOR e IN SELECT * FROM zzsh_order.finance_event WHERE economic_root_id=root_id LOOP
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND finance_event_id=e.id
    AND(e.kind='EARNING_PENDING' AND action='ACCRUE' OR e.kind='EARNING_SETTLED' AND action='SETTLE' OR e.kind='EARNING_REVOKED' AND action IN('REVOKE','RECOVER')))
  THEN RAISE EXCEPTION 'earning financial action has no exact transition receipt' USING ERRCODE='23514';END IF;
 END LOOP;
 IF r.state='RECOVERY_REQUIRED' AND EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='REVOKE' AND finance_event_id IS NOT NULL)
 THEN RAISE EXCEPTION 'recovery required must not falsely post a completed reversal' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='RECOVER') AND(
  r.state<>'REVOKED' OR settled_count<>1 OR revoked_count<>1 OR NOT EXISTS(
   SELECT 1 FROM zzsh_order.rental_referral_transition debt JOIN zzsh_order.rental_referral_transition recovered ON recovered.earning_id=debt.earning_id
   WHERE debt.earning_id=r.id AND debt.action='REVOKE' AND debt.finance_event_id IS NULL AND recovered.action='RECOVER'
    AND recovered.reversal_source_id=debt.reversal_source_id AND recovered.expected_version=debt.result_version AND recovered.finance_event_id IS NOT NULL))
 THEN RAISE EXCEPTION 'recovery completion requires the same original outstanding reversal and one real debit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER earning_root_reverse_guard AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_RENTAL_REFERRAL') EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();
CREATE CONSTRAINT TRIGGER earning_state_reverse_guard AFTER INSERT OR UPDATE ON zzsh_order.rental_referral_earning DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();
CREATE CONSTRAINT TRIGGER earning_transition_reverse_guard AFTER INSERT ON zzsh_order.rental_referral_transition DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();
CREATE CONSTRAINT TRIGGER earning_event_reverse_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.kind IN('EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED')) EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();
-- Existing withdrawal_revision already increments the common wallet revision for every
-- non-OPENING finance_event; reuse it exactly once. Debt-only REVOKE has no such event.
CREATE FUNCTION zzsh_order.referral_debt_read_revision() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject_value text;
BEGIN
 SELECT beneficiary_user_id INTO subject_value FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_value FOR UPDATE;
 UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=subject_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral debt has no covered wallet' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.referral_debt_read_revision() FROM PUBLIC;
CREATE TRIGGER referral_debt_read_revision AFTER INSERT ON zzsh_order.rental_referral_transition
 FOR EACH ROW WHEN(NEW.finance_event_id IS NULL) EXECUTE FUNCTION zzsh_order.referral_debt_read_revision();


CREATE FUNCTION zzsh_order.guard_withdrawal_referral_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=NEW.user_id AND state='RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'outstanding referral recovery prevents new withdrawal reservation' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_referral_recovery_guard BEFORE INSERT ON zzsh_order.withdrawal_intent
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_referral_recovery();

REVOKE ALL ON TABLE zzsh_order.distribution_order_admission,zzsh_order.payment_distribution_basis,
 zzsh_order.controlled_payment_declaration,zzsh_order.rental_referral_earning,
 zzsh_order.rental_referral_reversal_source,zzsh_order.rental_referral_transition FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.canonical_finance_json(jsonb,integer),zzsh_order.derive_payment_referral_inputs(text),
 zzsh_order.earning_expected_lines(text),zzsh_order.guard_distribution_order_admission(),
 zzsh_order.guard_payment_distribution_basis(),zzsh_order.check_payment_distribution_basis_pair(),
 zzsh_order.guard_controlled_payment_declaration(),zzsh_order.guard_native_earning_root(),
 zzsh_order.guard_rental_referral_earning(),zzsh_order.guard_earning_event(),zzsh_order.guard_earning_entry(),
 zzsh_order.check_earning_batch(),zzsh_order.guard_referral_transition_source(),zzsh_order.guard_referral_reversal_declaration(),
 zzsh_order.check_earning_reverse_closure(),zzsh_order.referral_debt_read_revision(),zzsh_order.guard_withdrawal_referral_recovery()
 FROM PUBLIC;
