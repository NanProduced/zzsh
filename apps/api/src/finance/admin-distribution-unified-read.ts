/** A source-bound pending record is known; the caller separately counts only positive amounts. */
export function legacyPendingContributorProofSql():string {
  return `EXISTS(SELECT 1 FROM zzsh_order.legacy_order_duty pending
    JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.id=pending.order_id
    JOIN zzsh_order.legacy_continuation_evidence ev ON ev.order_id=lo.id AND ev.source_kind='SOURCE_IMPORT'
    WHERE pending.kind='COMMISSION' AND pending.order_id=p.allowed_order_id AND pending.source_record_id=p.source_id
      AND pending.counterparty_user_id=p.user_id AND pending.status='PENDING' AND pending.source='LEGACY_IMPORT'
      AND pending.source_status='1' AND pending.amount_cents>=0 AND pending.admission_id IS NULL
      AND pending.continuation_version_id IS NULL AND pending.maturity_at IS NULL AND pending.settled_by IS NULL
      AND lo.source_pay_status=1 AND lo.source_order_status IN(3,8,9)
      AND COALESCE((SELECT h.stage FROM zzsh_order.legacy_continuation_version h WHERE h.order_id=lo.id AND h.superseded_at IS NULL),lo.source_order_status) IN(3,8,9)
      AND ev.source_digest=lo.source_digest AND pending.source_digest=ev.source_digest
      AND ev.facts_canonical::jsonb=ev.facts AND encode(sha256(convert_to(ev.facts_canonical,'UTF8')),'hex')=ev.facts_digest
      AND ev.facts#>>'{evidence,source,legacyOrderId}'=lo.legacy_id
      AND ev.facts#>>'{evidence,source,renterId}'=lo.legacy_renter_id AND ev.facts#>>'{evidence,source,ownerId}'=lo.legacy_owner_id
      AND p.original->>'id'=p.source_id AND p.original->>'user_id'=p.legacy_user_id
      AND p.original->>'order_id'=lo.legacy_id AND p.original->>'order_type'='1' AND p.original->>'is_delete'='0'
      AND p.original->>'status'='1' AND p.original->>'level'=pending.level::text
      AND p.original->>'earnings'=p.snapshot->>'amount' AND pending.amount_cents=round((p.snapshot->>'amount')::numeric*100)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ev.facts#>'{evidence,source,paidPay}')='array'
        THEN ev.facts#>'{evidence,source,paidPay}' ELSE '[]'::jsonb END) pay WHERE pay->>'orderId'=lo.legacy_id
          AND COALESCE(pay->>'id','')~'^[1-9][0-9]*$' AND COALESCE(pay->>'payOrderSn','')<>''
          AND CASE WHEN COALESCE(pay->>'payMoney','')~'^(0|[1-9][0-9]*)([.][0-9]+)?$' THEN (pay->>'payMoney')::numeric>0 ELSE false END)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ev.facts#>'{evidence,source,commissions}')='array'
        THEN ev.facts#>'{evidence,source,commissions}' ELSE '[]'::jsonb END) co WHERE co->>'id'=pending.source_record_id
          AND co->>'beneficiaryId'=p.legacy_user_id AND co->>'level'=pending.level::text AND co->>'status'='1'
          AND co->>'storedEarnings'=p.snapshot->>'amount'
          AND CASE WHEN COALESCE(co->>'ratio','')~'^(0|[1-9][0-9]*)(\\.[0-9]+)?$' THEN (co->>'ratio')::numeric=pending.ratio ELSE false END))`;
}

/** Same record/responsibility rules as distribution-earning-read v2. Never posts or advances a duty. */
export function unifiedDistributionSourceSql(legacy: boolean, duties: boolean, nativeScope: string, directoryRead: boolean, beneficiaryParameter?: string, beneficiaryListParameter?: string, includeSettledAt = true, recordScope?:{nativeIds:string;legacyIds:string}) {
  const beneficiary = (column: string) => beneficiaryParameter ? ` AND ${column}=${beneficiaryParameter}::text` : beneficiaryListParameter ? ` AND ${column}=ANY(${beneficiaryListParameter}::text[])` : "";
  const name = directoryRead ? 'u.name' : 'NULL::text';
  const proof = (a: string) => `${a}.source_canonical::jsonb=${a}.snapshot
    AND encode(sha256(convert_to(${a}.source_canonical,'UTF8')),'hex')=${a}.source_digest
    AND ${a}.snapshot->'rawSource'->>'entity'=${a}.source_entity
    AND encode(sha256(convert_to(${a}.snapshot->'rawSource'->>'canonical','UTF8')),'hex')=${a}.snapshot->'rawSource'->>'digest'`;
  const raw = (a: string) => `(${a}.snapshot->'rawSource'->>'canonical')::jsonb`;
  const epoch = (value: string) => `CASE WHEN ${value} ~ '^[1-9][0-9]{0,9}$' AND (${value})::numeric<=4294967295 THEN to_timestamp((${value})::double precision) END`;
  const original = 'p.original', log = 'l.original_log';
  // Materialize authenticated source bytes once; commission rows share a batch log index.
  const prelude = legacy ? `WITH legacy_input AS MATERIALIZED (
    SELECT p.id,p.user_id,p.legacy_user_id,p.source_system,p.source_entity,p.source_id,p.source_kind,p.snapshot-'rawSource' AS snapshot,p.imported_at,lo.id AS allowed_order_id,lo.original_order_no allowed_order_number,lo.game_id allowed_game_id,lo.renter_user_id allowed_renter_user_id,lo.owner_user_id allowed_owner_user_id,CASE WHEN ${proof('p')} THEN ${raw('p')} END original
    FROM zzsh_order.personal_finance_observation p
    LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.source_system=p.source_system AND lo.source_entity='la_order' AND lo.legacy_id=p.snapshot->>'orderId'
      AND p.source_kind='HISTORICAL_DISTRIBUTION' AND p.source_entity='la_distribution_order' AND p.snapshot->>'sourceOrderType'='1'
    WHERE p.source_kind='HISTORICAL_DISTRIBUTION' AND p.source_entity='la_distribution_order' AND (${nativeScope.replaceAll('o.game_id','lo.game_id')})${beneficiary('p.user_id')}${recordScope?` AND p.id=ANY(${recordScope.legacyIds}::text[])`:''}
  )${includeSettledAt ? `, legacy_log_candidates AS MATERIALIZED (
    SELECT l.source_system,l.user_id,l.legacy_user_id,l.source_id,l.source_event_at,l.snapshot-'rawSource' AS snapshot,
      CASE WHEN ${proof('l')} THEN ${raw('l')} END original_log
    FROM zzsh_order.personal_finance_observation l
    WHERE l.source_kind='HISTORICAL_EARNINGS_LOG' AND l.source_entity='la_log_earnings'
      AND l.snapshot->>'legacyChangeType'='1001' AND l.snapshot->>'action'='1'${beneficiary('l.user_id')}${recordScope?` AND EXISTS(SELECT 1 FROM legacy_input p WHERE p.source_system=l.source_system AND p.user_id=l.user_id AND p.source_id=l.snapshot->>'referenceId')`:''}
  ), legacy_credits AS MATERIALIZED (
    SELECT l.source_system,l.user_id,l.legacy_user_id,l.snapshot->>'referenceId' reference_id,${log}->>'amount' amount,
      ${log}->>'createdAt' original_at,count(*) n,min(l.source_event_at) at FROM legacy_log_candidates l
    WHERE ${log}->>'id'=l.source_id AND ${log}->>'sourceId'=l.snapshot->>'referenceId' AND ${log}->>'userId'=l.legacy_user_id
      AND ${log}->>'changeType'='1001' AND ${log}->>'action'='1' AND l.snapshot->>'amount'=${log}->>'amount'
      AND l.snapshot->>'createdAt'=${log}->>'createdAt' AND ${epoch(`${log}->>'createdAt'`)}=l.source_event_at
    GROUP BY l.source_system,l.user_id,l.legacy_user_id,l.snapshot->>'referenceId',${log}->>'amount',${log}->>'createdAt'
  )` : ''}, legacy_duties AS MATERIALIZED (${duties ? `SELECT d.counterparty_user_id,d.source_record_id,d.order_id,count(*) n,min(d.status) state,min(d.amount_cents) amount,
    bool_and(d.id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$' AND d.currency='CNY' AND d.revision>0 AND d.amount_cents>=0
      AND d.status IN('PENDING','MATURED','SETTLED','VOID') AND(d.maturity_at IS NULL OR isfinite(d.maturity_at))
      AND CASE WHEN d.status='SETTLED' THEN d.settled_by IN('FINANCE','LEGACY_RECORDS') ELSE d.settled_by IS NULL END) valid,
    ${beneficiaryListParameter ? `bool_and(d.maturity_at IS NOT NULL AND (
      EXISTS(SELECT 1 FROM zzsh_order.legacy_order_duty_admission a WHERE a.id=d.admission_id AND a.duty_id=d.id AND a.order_id=d.order_id
        AND a.source_record_id=d.source_record_id AND a.counterparty_user_id=d.counterparty_user_id AND a.amount_cents=d.amount_cents AND a.maturity_at=d.maturity_at)
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v WHERE v.id=d.continuation_version_id AND v.order_id=d.order_id AND v.command='CONFIRM')
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_duty_revision r JOIN zzsh_order.legacy_continuation_version v ON v.id=r.source_command_version_id
        WHERE r.duty_id=d.id AND r.reason='CONFIRM_FINAL_AMOUNT' AND v.order_id=d.order_id AND v.command='CONFIRM'
          AND r.after_values->>'amountCents'=d.amount_cents::text AND (r.after_values->>'maturityAt')::timestamptz=d.maturity_at)
    )) finalized` : 'false AS finalized'}
    FROM zzsh_order.legacy_order_duty d WHERE d.kind='COMMISSION' AND EXISTS(SELECT 1 FROM legacy_input p
      WHERE d.counterparty_user_id=p.user_id AND d.source_record_id=p.source_id AND d.order_id=p.allowed_order_id)
    GROUP BY d.counterparty_user_id,d.source_record_id,d.order_id`
    : `SELECT NULL::text counterparty_user_id,NULL::text source_record_id,NULL::text order_id,0::numeric n,NULL::text state,NULL::numeric amount,false valid,false finalized WHERE FALSE`}) ` : '';

  const history = legacy ? `SELECT DISTINCT ON(p.source_system,p.source_entity,p.source_id,p.user_id,p.snapshot->>'level')
    'history:'||p.id AS id,'LEGACY'::text source,p.user_id beneficiary_id,${name} beneficiary_name,
    CASE p.snapshot->>'level' WHEN '2' THEN 'RENTER_REFERRAL' WHEN '3' THEN 'OWNER_REFERRAL' WHEN '1' THEN 'TASK_REFERRAL' ELSE 'UNKNOWN' END role,
    p.allowed_order_id AS order_id,p.allowed_order_number order_number,p.allowed_game_id game_id,
    CASE WHEN d.n=1 AND d.valid THEN d.amount ELSE round((p.snapshot->>'amount')::numeric*100) END amount_cents,
    NULL::numeric recovery_cents,
    CASE WHEN d.n=1 AND d.valid THEN d.state WHEN COALESCE(d.n,0)>0 THEN 'UNKNOWN'
      WHEN p.snapshot->>'sourceStatus'='1' THEN 'UNKNOWN' WHEN p.snapshot->>'sourceStatus'='2' THEN 'SETTLED'
      WHEN p.snapshot->>'sourceStatus'='3' THEN 'EXPIRED' ELSE 'UNKNOWN' END state,
    CASE WHEN ${original}->>'id'=p.source_id AND ${original}->>'user_id'=p.legacy_user_id
      AND ${original}->>'earnings'=p.snapshot->>'amount' THEN ${epoch(`${original}->>'create_time'`)} END occurred_at,
    ${includeSettledAt ? 'CASE WHEN credit.n=1 THEN credit.at END' : 'NULL::timestamptz'} settled_at,NULL::timestamptz due_at,p.imported_at recorded_at,
    jsonb_build_array(p.source_system,p.source_entity,p.source_id,p.user_id,p.snapshot->>'level')::text economic_key,
    round((p.snapshot->>'amount')::numeric*100) source_amount_cents,
    CASE p.snapshot->>'level' WHEN '2' THEN p.allowed_renter_user_id WHEN '3' THEN p.allowed_owner_user_id END party_user_id,
    COALESCE(${original}->>'id'=p.source_id AND ${original}->>'user_id'=p.legacy_user_id
      AND ${original}->>'earnings'=p.snapshot->>'amount' AND ${original}->>'level'=p.snapshot->>'level'
      AND ${original}->>'status'=p.snapshot->>'sourceStatus' AND ${original}->>'order_type'=p.snapshot->>'sourceOrderType'
      AND ${original}->>'order_id'=p.snapshot->>'orderId' AND ${original}->>'is_delete'='0',false) source_valid,
    CASE WHEN d.n=1 AND d.valid THEN (d.finalized OR ${beneficiaryListParameter ? legacyPendingContributorProofSql() : 'false'}) ELSE p.snapshot->>'sourceStatus'='2' END contributor_confirmed
    FROM legacy_input p
    LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id
    LEFT JOIN legacy_duties d ON d.counterparty_user_id=p.user_id AND d.source_record_id=p.source_id AND d.order_id=p.allowed_order_id
    ${includeSettledAt ? `LEFT JOIN legacy_credits credit ON credit.source_system=p.source_system AND credit.user_id=p.user_id AND credit.legacy_user_id=p.legacy_user_id
      AND credit.reference_id=p.source_id AND credit.amount=${original}->>'earnings' AND credit.original_at=${original}->>'settle_time'
      AND ${original}->>'id'=p.source_id AND ${original}->>'user_id'=p.legacy_user_id
      AND ${original}->>'status'='2' AND ${original}->>'is_delete'='0' AND ${original}->>'order_type' IN('1','2')
      AND ${original}->>'level' IN('1','2','3') AND ${original}->>'sn'=p.snapshot->>'sourceNumber'
      AND ${original}->>'earnings'=p.snapshot->>'amount'` : ''}
    ORDER BY p.source_system,p.source_entity,p.source_id,p.user_id,p.snapshot->>'level',p.id COLLATE "C"`
    : `SELECT NULL::text id,NULL::text source,NULL::text beneficiary_id,NULL::text beneficiary_name,NULL::text role,NULL::text order_id,NULL::text order_number,NULL::text game_id,NULL::numeric amount_cents,NULL::numeric recovery_cents,NULL::text state,NULL::timestamptz occurred_at,NULL::timestamptz settled_at,NULL::timestamptz due_at,NULL::timestamptz recorded_at,NULL::text economic_key,NULL::numeric source_amount_cents,NULL::text party_user_id,false source_valid,false contributor_confirmed WHERE FALSE`;
  return `WITH legacy_records AS (${prelude}${history}), dashboard_records AS (
    SELECT e.id,'NATIVE'::text source,e.beneficiary_user_id beneficiary_id,${name} beneficiary_name,e.beneficiary_role role,
      o.id order_id,o.display_no order_number,o.game_id,e.amount_cents,CASE WHEN e.state='RECOVERY_REQUIRED' THEN e.recovery_required_cents END recovery_cents,e.state,e.created_at occurred_at,
      ${includeSettledAt ? `(SELECT min(f.created_at) FROM zzsh_order.rental_referral_transition t JOIN zzsh_order.finance_event f ON f.id=t.finance_event_id
        AND f.economic_root_id=e.id AND f.kind='EARNING_SETTLED' AND f.subject_user_id=e.beneficiary_user_id WHERE t.earning_id=e.id AND t.action='SETTLE')` : 'NULL::timestamptz'} settled_at,
      e.due_at,e.created_at recorded_at,jsonb_build_array('zzsh','rental_referral_earning',e.id,e.beneficiary_user_id,e.beneficiary_role)::text economic_key,e.amount_cents source_amount_cents,
      CASE e.beneficiary_role WHEN 'RENTER_REFERRAL' THEN o.renter_user_id WHEN 'OWNER_REFERRAL' THEN o.owner_user_id END party_user_id,true source_valid,true contributor_confirmed
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id WHERE ${nativeScope}${beneficiary('e.beneficiary_user_id')}${recordScope?` AND e.id=ANY(${recordScope.nativeIds}::text[])`:''}
    UNION ALL SELECT * FROM legacy_records) `;
}
