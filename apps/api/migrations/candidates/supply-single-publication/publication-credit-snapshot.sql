-- Candidate only. Paid requirements already contain their original amount and score.
-- Only a waiver needs new evidence because no guarantee requirement exists for it.
ALTER TABLE zzsh_supply.listing_publication
  ADD COLUMN credit_guarantee_waived boolean,
  ADD COLUMN credit_guarantee_waived_revision bigint,
  ADD CONSTRAINT listing_publication_credit_guarantee_waiver_shape CHECK ((
    (credit_guarantee_waived IS NULL AND credit_guarantee_waived_revision IS NULL)
    OR (credit_guarantee_waived IS TRUE AND credit_guarantee_waived_revision > 0)
  ) IS TRUE);

COMMENT ON COLUMN zzsh_supply.listing_publication.credit_guarantee_waived IS '上架时权威规则已判定免缴号主保证金；空值不代表免缴。';
COMMENT ON COLUMN zzsh_supply.listing_publication.credit_guarantee_waived_revision IS '上架时免缴保证金所依据的信用版本；空值不代表免缴。';
COMMENT ON CONSTRAINT listing_publication_credit_guarantee_waiver_shape ON zzsh_supply.listing_publication IS '免缴事实须同时记录已判免缴与信用版本；已缴情况沿保证金责任与账本核对。';
