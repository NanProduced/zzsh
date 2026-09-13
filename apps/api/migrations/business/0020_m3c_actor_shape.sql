-- SQL CHECK accepts NULL; actor equality must also require a present user actor.
ALTER TABLE zzsh_supply.media_upload_intent ADD CONSTRAINT upload_user_actor_required CHECK(uploaded_by_realm <> 'user' OR uploaded_by_user_id IS NOT NULL);
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT asset_user_actor_required CHECK(uploaded_by_realm <> 'user' OR uploaded_by_user_id IS NOT NULL);
UPDATE zzsh_iam.admin_permission SET name='查看供给与媒体审核',description='按显式游戏范围查看供给版本、审核差异和私有审核材料' WHERE code='supply.review.read';
UPDATE zzsh_iam.admin_permission SET name='决定供给与媒体审核',description='对确切供给版本或媒体材料作出审核决定，保留原因与审计' WHERE code='supply.review.decide';
