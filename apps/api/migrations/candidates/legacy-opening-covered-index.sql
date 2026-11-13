-- Candidate: keep deferred opening coverage checks indexed by their existing lookup key.
CREATE INDEX finance_covered_event_basis_idx ON zzsh_order.finance_covered_event (basis_id);
CREATE INDEX personal_finance_observation_basis_idx ON zzsh_order.personal_finance_observation (basis_id) WHERE basis_id IS NOT NULL;
COMMENT ON INDEX zzsh_order.finance_covered_event_basis_idx IS '按期初依据核对覆盖事实，避免逐户扫描全部历史覆盖记录。';
COMMENT ON INDEX zzsh_order.personal_finance_observation_basis_idx IS '按期初依据核对历史观察事实，空依据不进入此索引。';
