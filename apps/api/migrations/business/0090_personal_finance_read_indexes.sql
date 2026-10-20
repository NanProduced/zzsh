-- Scope the existing immutable finance readers by their subject; keyset IDs use the query's C collation.
CREATE INDEX zzsh_order_settlement_ledger_entry_counterparty_created_id_idx
  ON zzsh_order.settlement_ledger_entry (counterparty_user_id, created_at, id COLLATE "C");
--> statement-breakpoint
CREATE INDEX zzsh_order_personal_finance_observation_user_kind_event_id_idx
  ON zzsh_order.personal_finance_observation (user_id, source_kind, source_event_at, id COLLATE "C");
