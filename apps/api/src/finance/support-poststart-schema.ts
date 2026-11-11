/** Fixed guards protect the special cancellation's balance and refund liability. */
export const supportPoststartTriggersSql=`SELECT count(*)::int FROM pg_trigger t JOIN (VALUES
 ('zzsh_order.support_poststart_cancellation','support_poststart_cancellation_guard','zzsh_order.guard_support_poststart_cancellation()',false,7,NULL),
 ('zzsh_order.support_poststart_cancellation','support_poststart_cancellation_immutable','zzsh_order.finance_immutable()',false,27,NULL),
 ('zzsh_order.support_poststart_cancellation','support_poststart_case_complete','zzsh_order.check_support_poststart_cancellation()',true,5,NULL),
 ('zzsh_order.rental_order','support_poststart_order_guard','zzsh_order.guard_support_poststart_order()',false,19,NULL),
 ('zzsh_order.rental_order','support_poststart_order_complete','zzsh_order.check_support_poststart_cancellation()',true,17,'(new.cancel_reason = ''SUPPORT_AFTER_START_CANCELLED''::text)'),
 ('zzsh_order.finance_economic_root','support_poststart_root_guard','zzsh_order.guard_support_poststart_root()',false,7,'(new.source_kind = ''NATIVE_SUPPORT_CANCELLATION''::text)'),
 ('zzsh_order.finance_economic_root','support_poststart_root_complete','zzsh_order.check_support_poststart_cancellation()',true,5,'(new.source_kind = ''NATIVE_SUPPORT_CANCELLATION''::text)'),
 ('zzsh_order.finance_event','support_poststart_event_guard','zzsh_order.guard_support_poststart_event()',false,7,'(new.kind = ''SUPPORT_CANCELLATION_RECOGNIZED''::text)'),
 ('zzsh_order.finance_event','support_poststart_event_complete','zzsh_order.check_support_poststart_cancellation()',true,5,'(new.kind = ''SUPPORT_CANCELLATION_RECOGNIZED''::text)'),
 ('zzsh_order.finance_event','support_poststart_wallet_revision','zzsh_order.withdrawal_wallet_revision()',false,5,'(new.kind = ''SUPPORT_CANCELLATION_RECOGNIZED''::text)'),
 ('zzsh_order.settlement_ledger_entry','support_poststart_entry_guard','zzsh_order.guard_support_poststart_entry()',false,7,'((new.finance_event_id IS NOT NULL) AND (new.details ? ''supportCancellationId''::text))'),
 ('zzsh_order.settlement_ledger_entry','support_poststart_entry_complete','zzsh_order.check_support_poststart_cancellation()',true,5,'(new.details ? ''supportCancellationId''::text)')
) required(relation,name,fn,deferred,type,qual) ON t.tgrelid=to_regclass(required.relation) AND t.tgname=required.name
 AND t.tgfoid=to_regprocedure(required.fn) AND t.tgdeferrable=required.deferred AND t.tginitdeferred=required.deferred
 AND t.tgtype=required.type::smallint AND t.tgnargs=0 AND t.tgattr::text=''
 AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qual
 WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A')`;

export const supportPoststartExecutorSafeSql=`EXISTS(SELECT 1 FROM pg_proc p
 JOIN pg_class c ON c.oid=to_regclass('zzsh_order.support_poststart_cancellation')
 WHERE p.oid=to_regprocedure('zzsh_order.cancel_order_after_start_v2(text,bigint,numeric,numeric,text)')
  AND p.proowner=c.relowner AND p.prosecdef AND 'search_path=pg_catalog'=ANY(p.proconfig)
  AND EXISTS(SELECT 1 FROM pg_proc h WHERE h.oid=to_regprocedure('zzsh_order.poststart_full_payout_selected(jsonb,text,text,text,text,text,text)')
   AND h.proowner=c.relowner AND NOT h.prosecdef AND h.provolatile='i')
  AND EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.conname='support_poststart_owner_fee_shape' AND k.convalidated)
  AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN('owner_gross_cents','full_payout_fee_cents','full_payout_selected') AND a.attnum>0 AND NOT a.attisdropped)=3)`;
