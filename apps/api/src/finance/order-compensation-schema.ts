// A partial installation must not authorize or advertise a money-writing workflow.
export const compensationTriggersSql = `SELECT count(*)::int FROM pg_trigger t JOIN (VALUES
  ('zzsh_order.order_compensation_posting','order_compensation_posting_guard','zzsh_order.guard_order_compensation_posting()',false),
  ('zzsh_order.order_compensation_posting','order_compensation_immutable','zzsh_order.finance_immutable()',false),
  ('zzsh_order.order_compensation_posting','order_compensation_posting_complete','zzsh_order.check_order_compensation_batch()',true),
  ('zzsh_iam.approval_request','order_compensation_approval_guard','zzsh_order.protect_order_compensation_approval()',false),
  ('zzsh_order.finance_economic_root','order_compensation_root_guard','zzsh_order.guard_order_compensation_root()',false),
  ('zzsh_order.finance_economic_root','order_compensation_root_complete','zzsh_order.check_order_compensation_batch()',true),
  ('zzsh_order.finance_event','order_compensation_event_guard','zzsh_order.guard_order_compensation_event()',false),
  ('zzsh_order.finance_event','order_compensation_event_complete','zzsh_order.check_order_compensation_batch()',true),
  ('zzsh_order.finance_event','order_compensation_wallet_revision','zzsh_order.withdrawal_wallet_revision()',false),
  ('zzsh_order.settlement_ledger_entry','order_compensation_entry_guard','zzsh_order.guard_order_compensation_entry()',false),
  ('zzsh_order.settlement_ledger_entry','order_compensation_entry_complete','zzsh_order.check_order_compensation_batch()',true)
) required(relation,name,fn,deferred) ON t.tgrelid=to_regclass(required.relation) AND t.tgname=required.name
 AND t.tgfoid=to_regprocedure(required.fn) AND t.tgdeferrable=required.deferred AND t.tginitdeferred=required.deferred
 WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A')`;

export const compensationFunctionsSafeSql = `NOT EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.post_order_compensation(text)'),('zzsh_order.order_compensation_posting_complete(text)')
) required(fn) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.order_compensation_posting')
 WHERE p.oid=to_regprocedure(required.fn) AND p.proowner=c.relowner AND p.prosecdef AND 'search_path=pg_catalog'=ANY(p.proconfig)))`;

export const compensationIncidentIndexSafeSql = `EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('zzsh_iam.order_compensation_incident_once') AND indisunique AND indisvalid AND indisready)`;
