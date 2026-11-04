# 新装结构导航

基线 `release_production_0153`。行号指向本目录 `01-structure.sql` 的最终 `CREATE`，不是canonical里第一次出现该对象的迁移。约束和触发器在 `03-constraints-triggers.sql`。

## zzsh_auth_admin

管理员密码、TOTP与会话。认证密钥不进入本文件。

### zzsh_auth_admin.account

认证提供方与口令凭据绑定。管理员认证域。

最终定义：01-structure.sql:10585
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：account_pkey、account_providerId_accountId_key、account_userId_idx、admin_account_user_id_idx

### zzsh_auth_admin.session

登录会话、有效期与客户端信息。管理员认证域。

最终定义：01-structure.sql:10743
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：admin_session_user_id_idx、session_pkey、session_token_key、session_userId_idx

### zzsh_auth_admin.twoFactor

双因素密钥与备份码。管理员认证域。

最终定义：01-structure.sql:10861
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：admin_two_factor_secret_idx、admin_two_factor_user_id_idx、twoFactor_pkey、twoFactor_secret_idx、twoFactor_userId_idx

### zzsh_auth_admin.user

认证主体及其基础资料。管理员认证域。

最终定义：01-structure.sql:10939
主键：id
外键：无
索引：user_email_key、user_phoneNumber_key、user_pkey、user_username_key

### zzsh_auth_admin.verification

有期限的认证挑战或验证记录。管理员认证域。

最终定义：01-structure.sql:11065
主键：id
外键：无
索引：admin_verification_identifier_idx、verification_identifier_idx、verification_pkey

## zzsh_auth_user

用户密码、旧凭据及会话。不得混入管理员认证域。

### zzsh_auth_user.account

认证提供方与口令凭据绑定。用户认证域。

最终定义：01-structure.sql:11135
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE
索引：account_pkey、account_providerId_accountId_key、user_account_user_id_idx

### zzsh_auth_user.session

登录会话、有效期与客户端信息。用户认证域。

最终定义：01-structure.sql:11293
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE
索引：session_pkey、session_token_key、user_session_user_id_idx

### zzsh_auth_user.twoFactor

双因素密钥与备份码。用户认证域。

最终定义：01-structure.sql:11403
主键：id
外键：FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE
索引：twoFactor_pkey、user_two_factor_secret_idx、user_two_factor_user_id_idx

### zzsh_auth_user.user

认证主体及其基础资料。用户认证域。

最终定义：01-structure.sql:11481
主键：id
外键：无
索引：user_email_key、user_phoneNumber_key、user_pkey、user_username_key

### zzsh_auth_user.verification

有期限的认证挑战或验证记录。用户认证域。

最终定义：01-structure.sql:11607
主键：id
外键：无
索引：user_verification_identifier_idx、verification_pkey

## zzsh_content

内容和法律文书。正文版本与接受事实分别保留。

### zzsh_content.carousel_item

内容或法律文书版本。旧帮助正文不自动成为现行条款。

最终定义：01-structure.sql:11684
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id)
索引：carousel_item_pkey、carousel_item_slot_idx

### zzsh_content.content_item

内容或法律文书版本。旧帮助正文不自动成为现行条款。

最终定义：01-structure.sql:11837
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)
索引：content_item_pkey、content_item_public_idx、content_item_resource_key_unique

### zzsh_content.content_version

内容或法律文书版本。旧帮助正文不自动成为现行条款。

最终定义：01-structure.sql:11944
主键：id
外键：FOREIGN KEY (cover_media_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (item_id) REFERENCES zzsh_content.content_item(id)；FOREIGN KEY (published_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：content_version_item_idx、content_version_item_sequence_unique、content_version_pkey、content_version_single_draft、content_version_single_published

### zzsh_content.document_acceptance

内容或法律文书版本。旧帮助正文不自动成为现行条款。

最终定义：01-structure.sql:12109
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：document_acceptance_identity_unique、document_acceptance_pkey、document_acceptance_subject_idx

### zzsh_content.legal_document_version

内容或法律文书版本。旧帮助正文不自动成为现行条款。

最终定义：01-structure.sql:12224
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：legal_document_current_idx、legal_document_version_pkey

## zzsh_credit

信用与保证金。金额和资格由服务端合同核定。

### zzsh_credit.credit_event

信用加减的不可变来源事件。

最终定义：01-structure.sql:12366
主键：id
外键：FOREIGN KEY (actor_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (reversal_of_id) REFERENCES zzsh_credit.credit_event(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：credit_event_pkey、credit_event_reversal_of_id_key、credit_event_user_id_event_key_key

### zzsh_credit.credit_recovery_request

用户信用恢复申请与审核决定。

最终定义：01-structure.sql:12541
主键：id
外键：FOREIGN KEY (decided_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (event_id) REFERENCES zzsh_credit.credit_event(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：credit_recovery_request_pkey、credit_recovery_request_user_id_request_key_key

### zzsh_credit.user_credit_state

用户当前信用分与修订版本。

最终定义：01-structure.sql:12701
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：user_credit_state_pkey

## zzsh_iam

权限、审批、身份与会员。历史事实不伪造成当前授权。

### zzsh_iam.admin_auth_captcha_used

已消费的管理员认证验证码。

最终定义：01-structure.sql:12766
主键：signature
外键：无
索引：admin_auth_captcha_used_expiry_idx、admin_auth_captcha_used_pkey

### zzsh_iam.admin_auth_failure

管理员认证失败计数事实。

最终定义：01-structure.sql:12807
主键：id
外键：无
索引：admin_auth_failure_lookup_idx、admin_auth_failure_pkey

### zzsh_iam.admin_auth_lockout

管理员认证锁定期限。

最终定义：01-structure.sql:12885
主键：scope、subject
外键：无
索引：admin_auth_lockout_pkey

### zzsh_iam.admin_backup_code_generation

备份码生成批次与已披露状态。

最终定义：01-structure.sql:12951
主键：admin_user_id
外键：无
索引：admin_backup_code_generation_pkey

### zzsh_iam.admin_permission

服务端操作权限定义，不包含实际管理员授权。

最终定义：01-structure.sql:13018
主键：code
外键：无
索引：admin_permission_pkey

### zzsh_iam.admin_recovery_notification_target

灾难恢复通知的收件目标。

最终定义：01-structure.sql:13073
主键：id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：admin_recovery_notification_target_active_user_idx、admin_recovery_notification_target_pkey

### zzsh_iam.admin_recovery_request

管理员灾难恢复请求及审批状态。

最终定义：01-structure.sql:13147
主键：id
外键：FOREIGN KEY (target_admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：admin_recovery_request_pkey、admin_recovery_request_target_idx、admin_recovery_request_token_hash_idx

### zzsh_iam.admin_role

内置及自定义管理员角色定义。

最终定义：01-structure.sql:13261
主键：id
外键：无
索引：admin_role_code_key、admin_role_pkey

### zzsh_iam.admin_role_permission

角色与操作权限的关联。

最终定义：01-structure.sql:13340
主键：role_id、permission_code
外键：FOREIGN KEY (permission_code) REFERENCES zzsh_iam.admin_permission(code)；FOREIGN KEY (role_id) REFERENCES zzsh_iam.admin_role(id) ON DELETE CASCADE
索引：admin_role_permission_pkey

### zzsh_iam.admin_security

管理员Boss标记、冻结状态与安全版本。

最终定义：01-structure.sql:13381
主键：admin_user_id
外键：无
索引：admin_security_pkey

### zzsh_iam.admin_security_command

管理员自助安全命令的指纹与执行回执。

最终定义：01-structure.sql:13506
主键：admin_user_id、command_id
外键：无
索引：admin_security_command_pkey

### zzsh_iam.admin_security_notification_outbox

管理员安全通知投递队列。

最终定义：01-structure.sql:13638
主键：id
外键：无
索引：admin_security_notification_outbox_pending_idx、admin_security_notification_outbox_pkey

### zzsh_iam.admin_user_permission

实际管理员的直接操作授权。

最终定义：01-structure.sql:13775
主键：admin_user_id、permission_code
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE；FOREIGN KEY (permission_code) REFERENCES zzsh_iam.admin_permission(code)
索引：admin_user_permission_code_idx、admin_user_permission_pkey

### zzsh_iam.admin_user_role

实际管理员的角色授权关系。

最终定义：01-structure.sql:13822
主键：admin_user_id、role_id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE；FOREIGN KEY (role_id) REFERENCES zzsh_iam.admin_role(id) ON DELETE CASCADE
索引：admin_user_role_pkey、admin_user_role_role_idx

### zzsh_iam.approval_decision

审批人的逐次决定。

最终定义：01-structure.sql:13862
主键：id
外键：FOREIGN KEY (approver_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id)
索引：approval_decision_approver_idx、approval_decision_pkey、approval_decision_request_id_key

### zzsh_iam.approval_execution

审批通过后的执行与幂等回执。

最终定义：01-structure.sql:13951
主键：id
外键：FOREIGN KEY (executed_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id)
索引：approval_execution_executor_idx、approval_execution_pkey、approval_execution_request_id_key

### zzsh_iam.approval_request

审批申请与冻结的业务正文。

最终定义：01-structure.sql:14050
主键：id
外键：FOREIGN KEY (decided_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (requested_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (superseded_by_request_id) REFERENCES zzsh_iam.approval_request(id)；FOREIGN KEY (supersedes_request_id) REFERENCES zzsh_iam.approval_request(id)；FOREIGN KEY (template_id) REFERENCES zzsh_iam.approval_template(id)
索引：approval_request_pending_idx、approval_request_pkey、approval_request_requester_status_idx

### zzsh_iam.approval_request_candidate

申请时封存的候选审批人。

最终定义：01-structure.sql:14230
主键：request_id、admin_user_id
外键：FOREIGN KEY (added_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id)
索引：approval_request_candidate_admin_idx、approval_request_candidate_pkey

### zzsh_iam.approval_template

按操作与触发条件选择的审批模板。

最终定义：01-structure.sql:14303
主键：id
外键：无
索引：approval_template_operation_code_trigger_condition_key、approval_template_pkey

### zzsh_iam.approval_template_candidate

模板指定的实际审批候选管理员。

最终定义：01-structure.sql:14374
主键：template_id、admin_user_id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (template_id) REFERENCES zzsh_iam.approval_template(id)
索引：approval_template_candidate_admin_idx、approval_template_candidate_pkey

### zzsh_iam.audit_event

只追加的操作审计事件。

最终定义：01-structure.sql:14413
主键：id
外键：无
索引：audit_event_actor_idx、audit_event_object_action_outcome_idx、audit_event_occurred_at_idx、audit_event_pkey、joinpay_payout_claim_audit_once、joinpay_payout_observed_audit_once、joinpay_withdrawal_money_audit_once、zzsh_iam_audit_event_user_migration_latest_idx

### zzsh_iam.im_aftersale_record

客服售后处理记录。

最终定义：01-structure.sql:14547
主键：id
外键：FOREIGN KEY (handler_admin_id) REFERENCES zzsh_iam.admin_security(admin_user_id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (requester_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (resolved_by_admin_id) REFERENCES zzsh_iam.admin_security(admin_user_id)
索引：im_aftersale_one_pending、im_aftersale_queue、im_aftersale_record_app_id_requester_user_id_operation_id_key、im_aftersale_record_pkey、im_aftersale_user_recent

### zzsh_iam.im_consultation

咨询轮次与客服分配。

最终定义：01-structure.sql:14729
主键：id
外键：FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT；FOREIGN KEY (thread_id, app_id, user_id, kind) REFERENCES zzsh_iam.im_support_thread(id, app_id, user_id, kind) ON DELETE RESTRICT；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT
索引：im_consultation_app_queue_idx、im_consultation_app_user_idx、im_consultation_pkey、im_consultation_queue_idx、im_consultation_thread_open_unique、im_consultation_thread_round_unique、im_consultation_user_idx

### zzsh_iam.im_consultation_event

咨询状态变更事件。

最终定义：01-structure.sql:14980
主键：id
外键：FOREIGN KEY (consultation_id) REFERENCES zzsh_iam.im_consultation(id) ON DELETE CASCADE；FOREIGN KEY (from_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT；FOREIGN KEY (to_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT
索引：im_consultation_event_consultation_idx、im_consultation_event_pkey

### zzsh_iam.im_consultation_scope_operation

咨询范围调整的幂等操作。

最终定义：01-structure.sql:15102
主键：id
外键：FOREIGN KEY (consultation_id) REFERENCES zzsh_iam.im_consultation(id)
索引：im_consultation_scope_operation_active_idx、im_consultation_scope_operation_due_idx、im_consultation_scope_operation_pkey

### zzsh_iam.im_identity_mapping

业务主体与云信身份的映射。

最终定义：01-structure.sql:15324
主键：id
外键：无
索引：im_identity_id_app_unique、im_identity_mapping_account_unique、im_identity_mapping_pending_idx、im_identity_mapping_pkey、im_identity_mapping_platform_unique、im_identity_mapping_scope_idx

### zzsh_iam.im_read_copy_position

各会话已读副本同步位置。

最终定义：01-structure.sql:15508
主键：app_id、team_id、account_id
外键：无
索引：im_read_copy_position_pkey

### zzsh_iam.im_read_copy_settings

消息已读副本策略。

最终定义：01-structure.sql:15590
主键：app_id
外键：FOREIGN KEY (updated_by) REFERENCES zzsh_iam.admin_security(admin_user_id)
索引：im_read_copy_settings_pkey

### zzsh_iam.im_support_handover

客服交接记录及目标。

最终定义：01-structure.sql:15692
主键：id
外键：FOREIGN KEY (from_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT；FOREIGN KEY (to_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT
索引：im_support_handover_from_idx、im_support_handover_object_idx、im_support_handover_pkey、im_support_handover_recent_idx、im_support_handover_to_idx

### zzsh_iam.im_support_presence

客服在线状态投影。

最终定义：01-structure.sql:15789
主键：无
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE
索引：im_support_consultation_rotation、im_support_order_rotation、im_support_presence_app_admin_unique

### zzsh_iam.im_support_presence_session

客服在线心跳会话。

最终定义：01-structure.sql:15901
主键：id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT
索引：im_support_presence_session_open_unique、im_support_presence_session_owner_idx、im_support_presence_session_pkey、im_support_presence_session_stale_idx、im_support_presence_session_window_idx

### zzsh_iam.im_support_round_rating

咨询轮次的用户评价。

最终定义：01-structure.sql:15998
主键：id
外键：FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT；FOREIGN KEY (round_id) REFERENCES zzsh_iam.im_consultation(id) ON DELETE RESTRICT；FOREIGN KEY (thread_id) REFERENCES zzsh_iam.im_support_thread(id) ON DELETE RESTRICT；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT
索引：im_support_round_rating_agent_idx、im_support_round_rating_day_idx、im_support_round_rating_pkey、im_support_round_rating_round_id_key

### zzsh_iam.im_support_settings

洲洲助手欢迎与投诉提示文案的版本化配置。

最终定义：01-structure.sql:16125
主键：app_id
外键：FOREIGN KEY (updated_by) REFERENCES zzsh_iam.admin_security(admin_user_id)
索引：im_support_settings_pkey

### zzsh_iam.im_support_thread

跨咨询轮次的稳定客服会话。

最终定义：01-structure.sql:16219
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT
索引：im_support_thread_pkey、im_support_thread_round_identity、im_support_thread_scope_state_idx、im_support_thread_scope_unique、im_support_thread_user_kind_unique

### zzsh_iam.membership_entitlement

用户实际会员礼遇及有效期。

最终定义：01-structure.sql:16379
主键：id
外键：FOREIGN KEY (approved_policy_id) REFERENCES zzsh_iam.membership_growth_policy(id)；FOREIGN KEY (replaced_by_id) REFERENCES zzsh_iam.membership_entitlement(id)
索引：membership_entitlement_pkey、membership_entitlement_subject_scope_idx

### zzsh_iam.membership_growth_contribution

按来源键记载的成长贡献及修正。

最终定义：01-structure.sql:16579
主键：id
外键：无
索引：membership_growth_contribution_pkey、membership_growth_contribution_user_effective_idx、membership_growth_contribution_user_game_idx、membership_growth_contribution_user_id_source_key_revision_key

### zzsh_iam.membership_growth_legacy_coverage

旧成长事实的覆盖截点与逐键证据。

最终定义：01-structure.sql:16767
主键：id
外键：FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：membership_growth_legacy_cove_subject_user_id_execution_key_key、membership_growth_legacy_covera_subject_user_id_fingerprint_key、membership_growth_legacy_coverage_pkey、membership_growth_legacy_coverage_receipt、membership_growth_legacy_coverage_subject_scope

### zzsh_iam.membership_growth_legacy_read_admission

已验证无来源零基底的读取准入，不是等级缓存。

最终定义：01-structure.sql:16903
主键：coverage_id
外键：FOREIGN KEY (scope_key, execution_key) REFERENCES zzsh_supply.idempotency_record(scope_key, key)；FOREIGN KEY (coverage_id) REFERENCES zzsh_iam.membership_growth_legacy_coverage(id)；FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (success_audit_id) REFERENCES zzsh_iam.audit_event(id)
索引：membership_growth_legacy_read_admis_scope_key_execution_key_key、membership_growth_legacy_read_admission_pkey、membership_growth_legacy_read_admission_success_audit_id_key

### zzsh_iam.membership_growth_policy

封存的会员成长政策版本。

最终定义：01-structure.sql:17073
主键：id
外键：无
索引：membership_growth_policy_pkey

### zzsh_iam.membership_growth_state

按用户汇总的成长状态。

最终定义：01-structure.sql:17215
主键：user_id
外键：FOREIGN KEY (policy_id) REFERENCES zzsh_iam.membership_growth_policy(id)
索引：membership_growth_state_pkey

### zzsh_iam.personal_finance_read_scope

个人资金观察的读取范围准入。

最终定义：01-structure.sql:17357
主键：admin_user_id、scope_key
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：personal_finance_read_scope_pkey

### zzsh_iam.user_identity_display_source

旧身份展示资料来源，不等同原生实名核验。

最终定义：01-structure.sql:17440
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_state(user_id) ON DELETE CASCADE
索引：user_identity_display_source_pkey

### zzsh_iam.user_identity_state

用户身份状态与服务端认定版本。

最终定义：01-structure.sql:17500
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT
索引：user_identity_state_account_status_idx、user_identity_state_pkey

### zzsh_iam.user_identity_subject

业务身份主体与认证用户的稳定关联。

最终定义：01-structure.sql:17608
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_state(user_id)
索引：user_identity_subject_digest_idx、user_identity_subject_pkey

### zzsh_iam.user_identity_verification_attempt

实名核验请求、结果与重试依据。

最终定义：01-structure.sql:17673
主键：user_id、key_digest
外键：FOREIGN KEY (privacy_version_id) REFERENCES zzsh_content.legal_document_version(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：user_identity_verification_attempt_pkey、user_identity_verification_attempt_rate_idx

### zzsh_iam.user_identity_verified_profile

原生实名核验后封存的资料。

最终定义：01-structure.sql:17814
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_subject(user_id)
索引：user_identity_verified_profile_pkey

### zzsh_iam.user_note

管理员对用户的业务备注。

最终定义：01-structure.sql:17916
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE
索引：user_note_pkey、user_note_visible_by_user

### zzsh_iam.user_registration_fact

由成功审计派生的用户注册只读投影。

最终定义：01-structure.sql:17996
主键：user_id
外键：无
索引：user_registration_fact_pkey

### zzsh_iam.user_rental_membership

租赁会员资格及版本。

最终定义：01-structure.sql:18061
主键：user_id
外键：FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：user_rental_membership_pkey

### zzsh_iam.user_risk_flag

用户风险标记及原因。

最终定义：01-structure.sql:18134
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE
索引：user_risk_flag_pkey

## zzsh_order

订单、责任与资金账本。历史付款标记不代表新渠道到账。

### zzsh_order.channel_refund_intent

租赁退款应付与冻结的渠道请求。

最终定义：01-structure.sql:1702
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)；FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id)；FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (liability_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (liability_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (terminal_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (terminal_evidence_id, id) REFERENCES zzsh_order.joinpay_refund_evidence(id, intent_id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (terminal_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED
索引：channel_refund_funds_budget、channel_refund_intent_payment_source_merchant_identity_id_r_key、channel_refund_intent_pkey、channel_refund_intent_posting_id_idempotency_key_key、joinpay_abnormal_refund_key、joinpay_refund_transaction_once、prestart_refund_original_key

### zzsh_order.channel_refund_observation

通用退款渠道事实观察。

最终定义：01-structure.sql:18204
主键：id
外键：FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id)
索引：channel_refund_observation_pkey

### zzsh_order.distribution_invite_code

分销邀请码及主体关联。

最终定义：01-structure.sql:18329
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：distribution_invite_code_match_code_key、distribution_invite_code_pkey、distribution_invite_code_source_type_source_system_source_e_key

### zzsh_order.distribution_order_admission

订单参加分销的资源与来源准入。

最终定义：01-structure.sql:18433
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (native_creation_audit_id) REFERENCES zzsh_iam.audit_event(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)
索引：distribution_order_admission_id_order_id_revision_key、distribution_order_admission_order_id_key、distribution_order_admission_pkey

### zzsh_order.distribution_participant

参与分销主体及资格。

最终定义：01-structure.sql:18591
主键：user_id
外键：FOREIGN KEY (policy_version_id) REFERENCES zzsh_order.distribution_policy_version(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：distribution_participant_pkey

### zzsh_order.distribution_policy_head

当前分销政策版本入口。

最终定义：01-structure.sql:18720
主键：scope
外键：FOREIGN KEY (current_version_id, scope, revision) REFERENCES zzsh_order.distribution_policy_version(id, scope, revision) DEFERRABLE INITIALLY DEFERRED
索引：distribution_policy_head_pkey

### zzsh_order.distribution_policy_version

封存的分销准入与佣金政策。

最终定义：01-structure.sql:18774
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：distribution_policy_version_id_scope_revision_key、distribution_policy_version_pkey、distribution_policy_version_scope_revision_key

### zzsh_order.finance_covered_event

已包含在期初中的来源事件集合，防止重复入账。

最终定义：01-structure.sql:18871
主键：user_id、source_kind、source_type、source_entity、source_id、beneficiary_role
外键：FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：finance_covered_event_pkey

### zzsh_order.finance_economic_root

一次经济行为的唯一资金根。

最终定义：01-structure.sql:18973
主键：id
外键：FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id)；FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：finance_economic_root_basis_id_key、finance_economic_root_pkey、finance_economic_root_source_kind_source_type_source_system_key

### zzsh_order.finance_event

资金根下的不可变记账事件。

最终定义：01-structure.sql:19105
主键：id
外键：FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id)；FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：finance_event_economic_root_id_kind_key、finance_event_pkey

### zzsh_order.finance_observation_admission

外部资金观察的维护接纳依据。

最终定义：01-structure.sql:19187
主键：basis_id、source_entity、source_id
外键：FOREIGN KEY (basis_id, user_id) REFERENCES zzsh_order.finance_opening_basis(id, user_id)
索引：finance_observation_admission_pkey

### zzsh_order.finance_opening_basis

用户资金期初及原生或旧源来源证明。

最终定义：01-structure.sql:19288
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：finance_opening_basis_id_user_id_key、finance_opening_basis_pkey、finance_opening_basis_source_system_source_entity_source_id_key

### zzsh_order.finance_stored_opening_review

封存期初的维护审核与原来源证明。

最终定义：01-structure.sql:19438
主键：basis_id
外键：FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id)
索引：finance_stored_opening_review_pkey

### zzsh_order.im_order_activity

订单会话最后活动投影。

最终定义：01-structure.sql:19527
主键：order_id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE CASCADE
索引：im_order_activity_pkey、im_order_activity_recent

### zzsh_order.im_order_due_reminder

订单到期提醒任务与租约。

最终定义：01-structure.sql:19590
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE RESTRICT
索引：im_order_due_reminder_due_idx、im_order_due_reminder_lease_idx、im_order_due_reminder_pkey、im_order_due_reminder_unique

### zzsh_order.im_order_event

订单群业务阶段事件。

最终定义：01-structure.sql:19736
主键：id
外键：FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id)；FOREIGN KEY (related_operation_id) REFERENCES zzsh_order.im_order_operation(id)
索引：im_order_event_approval_unique、im_order_event_delivery_unique、im_order_event_key、im_order_event_order_type、im_order_event_pending、im_order_event_pkey

### zzsh_order.im_order_group

每个订单独立的云信群绑定。

最终定义：01-structure.sql:19925
主键：order_id
外键：FOREIGN KEY (first_response_event_id) REFERENCES zzsh_order.im_order_event(id)；FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (order_id, payment_confirmation_id) REFERENCES zzsh_order.rental_order(id, paid_confirmation_id)；FOREIGN KEY (responsible_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (system_identity_id, app_id) REFERENCES zzsh_iam.im_identity_mapping(id, app_id)
索引：im_order_dispatch_waiting、im_order_group_add_due、im_order_group_pkey、im_order_group_reminder_due、im_order_id_app_unique、im_order_team_unique

### zzsh_order.im_order_member

订单群成员及主体角色。

最终定义：01-structure.sql:20169
主键：order_id、identity_id
外键：FOREIGN KEY (identity_id, app_id) REFERENCES zzsh_iam.im_identity_mapping(id, app_id)；FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id)
索引：im_order_member_pkey、im_order_one_buyer、im_order_one_owner

### zzsh_order.im_order_operation

订单群操作的幂等执行。

最终定义：01-structure.sql:20254
主键：id
外键：FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id)；FOREIGN KEY (target_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：im_order_operation_create_unique、im_order_operation_due、im_order_operation_escalation_due、im_order_operation_pkey、im_order_operation_round_unique、im_order_operation_unresolved_structure_unique

### zzsh_order.im_order_stage_card

订单阶段卡片及更新版本。

最终定义：01-structure.sql:20433
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE RESTRICT
索引：im_order_stage_card_card_id_unique、im_order_stage_card_due_idx、im_order_stage_card_lease_idx、im_order_stage_card_pkey、im_order_stage_card_unique

### zzsh_order.im_order_unread

用户在订单会话中的未读位置。

最终定义：01-structure.sql:20577
主键：order_id、identity_id
外键：FOREIGN KEY (identity_id) REFERENCES zzsh_iam.im_identity_mapping(id) ON DELETE CASCADE；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE CASCADE
索引：im_order_unread_identity、im_order_unread_pkey

### zzsh_order.invitation_relation

用户邀请关系及来源。

最终定义：01-structure.sql:20636
主键：id
外键：FOREIGN KEY (child_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (parent_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (policy_version_id) REFERENCES zzsh_order.distribution_policy_version(id)
索引：invitation_relation_parent_read、invitation_relation_pkey、invitation_relation_type_child_user_id_key

### zzsh_order.joinpay_account_observation

汇付商户账户状态观察。

最终定义：01-structure.sql:20753
主键：attempt_id
外键：无
索引：joinpay_account_observation_pkey、joinpay_account_observation_scope_time

### zzsh_order.joinpay_collection_attempt

汇付收款调用尝试及租约。

最终定义：01-structure.sql:21029
主键：id
外键：FOREIGN KEY (request_id) REFERENCES zzsh_order.joinpay_collection_binding(request_id)
索引：joinpay_collection_attempt_id_request_id_key、joinpay_collection_attempt_pkey、joinpay_collection_attempt_request_id_lease_version_key

### zzsh_order.joinpay_collection_binding

汇付收款请求的冻结商户与接入依据。

最终定义：01-structure.sql:21173
主键：request_id
外键：FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id)
索引：joinpay_collection_binding_pkey

### zzsh_order.joinpay_collection_evidence

汇付收款验签及业务绑定证据。

最终定义：01-structure.sql:21307
主键：id
外键：FOREIGN KEY (origin_observation_id) REFERENCES zzsh_order.joinpay_collection_observation(id)；FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id)
索引：joinpay_collection_evidence_id_request_id_key、joinpay_collection_evidence_pkey、joinpay_collection_evidence_request_id_operation_raw_sha256_key

### zzsh_order.joinpay_collection_observation

汇付收款返回或通知的观察。

最终定义：01-structure.sql:21561
主键：id
外键：FOREIGN KEY (attempt_id, request_id) REFERENCES zzsh_order.joinpay_collection_attempt(id, request_id)
索引：joinpay_collection_observation_attempt_id_key、joinpay_collection_observation_pkey

### zzsh_order.joinpay_payout_attempt

汇付代付尝试及租约。

最终定义：01-structure.sql:21784
主键：id
外键：FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id)
索引：joinpay_payout_attempt_id_intent_id_key、joinpay_payout_attempt_intent_id_lease_version_key、joinpay_payout_attempt_pkey、joinpay_payout_submit_once

### zzsh_order.joinpay_payout_evidence

汇付代付验签与资金终定依据。

最终定义：01-structure.sql:21943
主键：id
外键：FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id)；FOREIGN KEY (observation_id, intent_id) REFERENCES zzsh_order.joinpay_payout_observation(id, intent_id)
索引：joinpay_payout_evidence_id_intent_id_key、joinpay_payout_evidence_intent_id_key、joinpay_payout_evidence_observation_id_key、joinpay_payout_evidence_pkey

### zzsh_order.joinpay_payout_observation

汇付代付返回或通知观察。

最终定义：01-structure.sql:8149
主键：id
外键：FOREIGN KEY (attempt_id, intent_id) REFERENCES zzsh_order.joinpay_payout_attempt(id, intent_id)；FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id)
索引：joinpay_payout_observation_id_intent_id_key、joinpay_payout_observation_pkey

### zzsh_order.joinpay_refund_attempt

汇付退款调用尝试及租约。

最终定义：01-structure.sql:22078
主键：id
外键：FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id)
索引：joinpay_refund_attempt_id_intent_id_key、joinpay_refund_attempt_intent_id_lease_version_key、joinpay_refund_attempt_pkey、joinpay_refund_submit_once

### zzsh_order.joinpay_refund_evidence

汇付退款验签与终定依据。

最终定义：01-structure.sql:22228
主键：id
外键：FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id)；FOREIGN KEY (observation_id, intent_id) REFERENCES zzsh_order.joinpay_refund_observation(id, intent_id)
索引：joinpay_refund_evidence_id_intent_id_key、joinpay_refund_evidence_intent_id_key、joinpay_refund_evidence_observation_id_key、joinpay_refund_evidence_pkey

### zzsh_order.joinpay_refund_observation

汇付退款返回或通知观察。

最终定义：01-structure.sql:22369
主键：id
外键：FOREIGN KEY (attempt_id, intent_id) REFERENCES zzsh_order.joinpay_refund_attempt(id, intent_id)；FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id)
索引：joinpay_refund_observation_id_intent_id_key、joinpay_refund_observation_pkey

### zzsh_order.joinpay_withdrawal_intent

原生钱包提现占用与冻结的汇付代付请求。

最终定义：01-structure.sql:1133
主键：id
外键：FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (reserve_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (terminal_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (terminal_evidence_id, id) REFERENCES zzsh_order.joinpay_payout_evidence(id, intent_id) DEFERRABLE INITIALLY DEFERRED
索引：joinpay_withdrawal_intent_economic_root_id_key、joinpay_withdrawal_intent_id_user_id_key、joinpay_withdrawal_intent_merchant_identity_id_merchant_ord_key、joinpay_withdrawal_intent_payout_key_key、joinpay_withdrawal_intent_pkey、joinpay_withdrawal_intent_reserve_event_id_key、joinpay_withdrawal_platform_once

### zzsh_order.legacy_continuation_evidence

旧单续办的原始事实、参数及摘要。

最终定义：01-structure.sql:22628
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id)；FOREIGN KEY (order_id, derived_from_command_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id, id) DEFERRABLE INITIALLY DEFERRED
索引：legacy_continuation_evidence_derived_from_command_version_i_key、legacy_continuation_evidence_order_id_evidence_version_key、legacy_continuation_evidence_order_id_id_key、legacy_continuation_evidence_pkey、legacy_continuation_one_import

### zzsh_order.legacy_continuation_version

旧单续办的决定版本与来源。

最终定义：01-structure.sql:22800
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id)；FOREIGN KEY (order_id, input_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id, id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (order_id, result_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id, id) DEFERRABLE INITIALLY DEFERRED
索引：legacy_continuation_one_head、legacy_continuation_version_order_id_id_key、legacy_continuation_version_order_id_revision_key、legacy_continuation_version_pkey、legacy_continuation_version_result_evidence_id_key

### zzsh_order.legacy_duty_finance_contract

旧单责任与新资金动作的合同绑定。

最终定义：01-structure.sql:22973
主键：singleton
外键：无
索引：legacy_duty_finance_contract_pkey

### zzsh_order.legacy_duty_finance_fact

旧单责任对应的已执行资金事实。

最终定义：01-structure.sql:23062
主键：duty_id
外键：FOREIGN KEY (actor_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id)；FOREIGN KEY (effective_head_id) REFERENCES zzsh_order.legacy_continuation_version(id)；FOREIGN KEY (event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id)；FOREIGN KEY (root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：legacy_duty_finance_fact_event_id_key、legacy_duty_finance_fact_pkey、legacy_duty_finance_fact_root_id_key、legacy_duty_finance_subject

### zzsh_order.legacy_inflight_register

旧平台在途订单的封存登记。

最终定义：01-structure.sql:23334
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：legacy_inflight_account_disposition、legacy_inflight_register_pkey、legacy_inflight_register_source_system_source_entity_legacy_key

### zzsh_order.legacy_order_duty

旧单未结责任、对手方及当前处理状态。

最终定义：01-structure.sql:2257
主键：id
外键：FOREIGN KEY (order_id, admission_id) REFERENCES zzsh_order.legacy_order_duty_admission(order_id, id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (order_id, continuation_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id, id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id)
索引：legacy_order_duty_order_id_id_key、legacy_order_duty_order_id_kind_source_record_id_key、legacy_order_duty_party_state、legacy_order_duty_pkey

### zzsh_order.legacy_order_duty_admission

旧单责任可执行的显式准入。

最终定义：01-structure.sql:23505
主键：id
外键：FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id)
索引：legacy_order_duty_admission_duty_id_key、legacy_order_duty_admission_order_id_id_key、legacy_order_duty_admission_order_id_kind_source_record_id_key、legacy_order_duty_admission_pkey

### zzsh_order.legacy_order_duty_revision

旧单责任修订前后值及操作者。

最终定义：01-structure.sql:23778
主键：id
外键：FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id)；FOREIGN KEY (source_command_version_id) REFERENCES zzsh_order.legacy_continuation_version(id) DEFERRABLE INITIALLY DEFERRED
索引：legacy_order_duty_revision_duty_id_revision_key、legacy_order_duty_revision_pkey

### zzsh_order.legacy_order_read_snapshot

旧订单的只读业务展示快照。

最终定义：01-structure.sql:23898
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (source_system, legacy_account_entity, legacy_account_id) REFERENCES zzsh_supply.legacy_supply_map(source_system, source_entity, legacy_id)
索引：legacy_order_read_account、legacy_order_read_no、legacy_order_read_owner、legacy_order_read_renter、legacy_order_read_scope、legacy_order_read_snapshot_pkey、legacy_order_read_snapshot_source_system_source_entity_lega_key

### zzsh_order.legacy_owner_guarantee_coverage

旧号主保证金观察覆盖与处理依据。

最终定义：01-structure.sql:24226
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：legacy_guarantee_coverage_latest、legacy_owner_guarantee_coverage_pkey、legacy_owner_guarantee_coverage_user_id_source_cutoff_key

### zzsh_order.legacy_owner_guarantee_observation

旧号主保证金来源观察。

最终定义：01-structure.sql:24391
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：legacy_guarantee_history_user_page、legacy_owner_guarantee_observ_user_id_legacy_account_id_sou_key、legacy_owner_guarantee_observation_pkey

### zzsh_order.native_origin_resource_admission

特定资源允许原生零期初的显式准入，空库不自带准入行。

最终定义：01-structure.sql:24517
主键：resource_oid
外键：无
索引：native_origin_resource_admission_pkey

### zzsh_order.native_user_insert_proof

同事务新建原生用户的出生证明。

最终定义：01-structure.sql:24582
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：native_user_insert_proof_pkey

### zzsh_order.owner_guarantee_payment

号主保证金付款申请及渠道事实。

最终定义：01-structure.sql:24635
主键：id
外键：FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id)；FOREIGN KEY (ledger_entry_ref) REFERENCES zzsh_order.settlement_ledger_entry(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (requirement_id) REFERENCES zzsh_order.owner_guarantee_requirement(id)
索引：owner_guarantee_payment_merchant_order_no_key、owner_guarantee_payment_pkey、owner_guarantee_payment_provider_provider_transaction_id_key、owner_guarantee_payment_requirement_id_request_key_key

### zzsh_order.owner_guarantee_reconciliation

保证金对账来源与结论。

最终定义：01-structure.sql:24810
主键：id
外键：FOREIGN KEY (payment_id) REFERENCES zzsh_order.owner_guarantee_payment(id)；FOREIGN KEY (refund_id) REFERENCES zzsh_order.owner_guarantee_refund(id)
索引：owner_guarantee_reconciliation_payment_id_payload_digest_key、owner_guarantee_reconciliation_pkey、owner_guarantee_reconciliation_refund_id_payload_digest_key

### zzsh_order.owner_guarantee_refund

号主保证金释放或退款申请与结果。

最终定义：01-structure.sql:24915
主键：id
外键：FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id)；FOREIGN KEY (ledger_entry_ref) REFERENCES zzsh_order.settlement_ledger_entry(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (payment_id) REFERENCES zzsh_order.owner_guarantee_payment(id)；FOREIGN KEY (release_decided_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (requirement_id) REFERENCES zzsh_order.owner_guarantee_requirement(id)
索引：owner_guarantee_refund_pkey、owner_guarantee_refund_provider_provider_refund_id_key、owner_guarantee_refund_requirement_id_request_key_key

### zzsh_order.owner_guarantee_requirement

号主保证金需求与资格快照。

最终定义：01-structure.sql:25126
主键：id
外键：FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：owner_guarantee_requirement_binding_uq、owner_guarantee_requirement_pkey

### zzsh_order.payment_channel_observation

通用收款渠道的原始观察与验证结论。

最终定义：01-structure.sql:25283
主键：id
外键：FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id)
索引：payment_channel_observation_pkey

### zzsh_order.payment_channel_transaction

已认定收款交易与订单请求绑定。

最终定义：01-structure.sql:25549
主键：id
外键：FOREIGN KEY (confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)；FOREIGN KEY (native_order_id) REFERENCES zzsh_order.rental_order(id) DEFERRABLE；FOREIGN KEY (request_id, native_order_id) REFERENCES zzsh_order.payment_request(id, order_id)
索引：payment_channel_transaction_channel_merchant_identity_id_ch_key、payment_channel_transaction_pkey

### zzsh_order.payment_confirmation

订单付款结论及受控或渠道来源。

最终定义：01-structure.sql:25671
主键：id
外键：FOREIGN KEY (joinpay_anchor_id) REFERENCES zzsh_order.payment_channel_transaction(id)；FOREIGN KEY (joinpay_evidence_id, joinpay_request_id) REFERENCES zzsh_order.joinpay_collection_evidence(id, request_id)；FOREIGN KEY (joinpay_request_id, order_id) REFERENCES zzsh_order.payment_request(id, order_id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)
索引：payment_confirmation_one_applied、payment_confirmation_order_id_id_disposition_key、payment_confirmation_pkey、payment_confirmation_source_merchant_scope_id_provider_tran_key

### zzsh_order.payment_distribution_basis

付款结论对应的分销合同与参与人快照。

最终定义：01-structure.sql:25835
主键：id
外键：FOREIGN KEY (admission_id, order_id, admission_revision) REFERENCES zzsh_order.distribution_order_admission(id, order_id, revision)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)
索引：payment_distribution_basis_order_id_key、payment_distribution_basis_payment_confirmation_id_key、payment_distribution_basis_pkey

### zzsh_order.payment_request

收款请求及金额、主体、幂等状态。

最终定义：01-structure.sql:25946
主键：id
外键：FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)
索引：payment_request_channel_merchant_identity_id_channel_order__key、payment_request_id_order_id_key、payment_request_order_id_key、payment_request_pkey

### zzsh_order.personal_finance_observation

旧平台个人资金观察，不单独产生可提现余额。

最终定义：01-structure.sql:26187
主键：id
外键：FOREIGN KEY (basis_id, user_id) REFERENCES zzsh_order.finance_opening_basis(id, user_id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：personal_finance_observation_pkey、personal_finance_observation_source_type_source_system_sour_key、zzsh_order_personal_finance_observation_user_kind_event_id_idx

### zzsh_order.personal_finance_observation_coverage

个人资金观察的完整覆盖范围与截点。

最终定义：01-structure.sql:26348
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：finance_observation_coverage_latest、personal_finance_observation__user_id_source_kind_source_sy_key、personal_finance_observation_coverage_pkey

### zzsh_order.prestart_termination

开租前终止申请与责任版本。

最终定义：01-structure.sql:26543
主键：id
外键：FOREIGN KEY (liability_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (liability_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (requested_by_admin_user_id) REFERENCES zzsh_auth_admin."user"(id) DEFERRABLE INITIALLY DEFERRED；FOREIGN KEY (requested_by_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：prestart_termination_one_active、prestart_termination_pkey

### zzsh_order.prestart_termination_decision

开租前终止的当事人决定。

最终定义：01-structure.sql:26720
主键：id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (session_id) REFERENCES zzsh_auth_admin.session(id)；FOREIGN KEY (termination_id) REFERENCES zzsh_order.prestart_termination(id)
索引：prestart_termination_decision_pkey、prestart_termination_decision_termination_id_result_revisio_key

### zzsh_order.rental_opening

开租数量与交付确认版本。

最终定义：01-structure.sql:26840
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)
索引：rental_opening_auto_confirm_due_idx、rental_opening_one_confirmed、rental_opening_order_id_version_no_key、rental_opening_pkey

### zzsh_order.rental_opening_ack

租客或号主对开租版本的确认。

最终定义：01-structure.sql:26967
主键：opening_id、party
外键：FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：rental_opening_ack_pkey

### zzsh_order.rental_order

每单独立的租赁订单、价格与规则快照。

最终定义：01-structure.sql:2636
主键：id
外键：FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (id, paid_confirmation_id, payment_disposition) REFERENCES zzsh_order.payment_confirmation(order_id, id, disposition)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (listing_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id)
索引：rental_order_admin_list、rental_order_confirmation_unique、rental_order_display_no_key、rental_order_expiry_scan、rental_order_owner_list、rental_order_payment_pair、rental_order_pkey、rental_order_renter_list、rental_order_single_occupancy

### zzsh_order.rental_referral_earning

订单佣金应付及成熟、冲回状态。

最终定义：01-structure.sql:27050
主键：id
外键：FOREIGN KEY (beneficiary_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)；FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id)
索引：referral_earning_due、referral_earning_self、rental_referral_earning_economic_key_key、rental_referral_earning_economic_root_id_key、rental_referral_earning_order_id_beneficiary_user_id_benefi_key、rental_referral_earning_pkey

### zzsh_order.rental_referral_reversal_source

佣金冲回的原始来源证明。

最终定义：01-structure.sql:27250
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (earning_id) REFERENCES zzsh_order.rental_referral_earning(id)
索引：rental_referral_reversal_source_earning_id_key、rental_referral_reversal_source_pkey

### zzsh_order.rental_referral_transition

佣金状态变更与资金事件绑定。

最终定义：01-structure.sql:27373
主键：id
外键：FOREIGN KEY (earning_id) REFERENCES zzsh_order.rental_referral_earning(id)；FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id)；FOREIGN KEY (reversal_source_id) REFERENCES zzsh_order.rental_referral_reversal_source(id)
索引：rental_referral_transition_earning_id_action_key、rental_referral_transition_finance_event_id_key、rental_referral_transition_pkey

### zzsh_order.settlement_decision

当事人对结算版本的决定。

最终定义：01-structure.sql:27478
主键：id
外键：FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id)
索引：settlement_decision_pkey、settlement_decision_settlement_version_id_party_action_key

### zzsh_order.settlement_intake

待记账结算及接纳正文。

最终定义：01-structure.sql:27583
主键：id
外键：FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id)
索引：settlement_intake_one_open、settlement_intake_order_id_version_no_key、settlement_intake_pkey

### zzsh_order.settlement_ledger_entry

结算逐主体的不可变借贷分录。

最终定义：01-structure.sql:27723
主键：id
外键：FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id)；FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id)；FOREIGN KEY (source_payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)
索引：finance_event_line_once、settlement_ledger_entry_pkey、settlement_ledger_entry_posting_id_line_no_key、settlement_ledger_source_payment_once、zzsh_order_settlement_ledger_entry_counterparty_created_id_idx

### zzsh_order.settlement_posting

一次结算记账的根与幂等身份。

最终定义：01-structure.sql:27860
主键：id
外键：FOREIGN KEY (approval_approved_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (approval_request_id) REFERENCES zzsh_iam.approval_request(id)；FOREIGN KEY (approval_requested_by) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)；FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id)；FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id)
索引：settlement_posting_order_id_key、settlement_posting_payment_confirmation_id_key、settlement_posting_pkey、settlement_posting_settlement_version_id_key

### zzsh_order.settlement_version

结算计算与双方冻结的版本依据。

最终定义：01-structure.sql:28096
主键：id
外键：FOREIGN KEY (approval_request_id) REFERENCES zzsh_iam.approval_request(id)；FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id)；FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id)
索引：settlement_version_approval_request_id_key、settlement_version_current、settlement_version_order_id_version_no_key、settlement_version_pkey

### zzsh_order.wallet_coverage

钱包读取的已覆盖来源截点。

最终定义：01-structure.sql:28292
主键：user_id
外键：FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id)；FOREIGN KEY (opening_event_id) REFERENCES zzsh_order.finance_event(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：wallet_coverage_basis_id_key、wallet_coverage_opening_event_id_key、wallet_coverage_pkey

### zzsh_order.wallet_revision

用户钱包并发控制版本。

最终定义：01-structure.sql:28358
主键：user_id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：wallet_revision_pkey

### zzsh_order.withdrawal_bank_binding

用户银行卡绑定与加密资料版本。

最终定义：01-structure.sql:28411
主键：id
外键：FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：withdrawal_bank_binding_pkey、withdrawal_bank_binding_user_id_key

## zzsh_supply

游戏目录、账号、规则、媒体与发布。展示不代表可交易。

### zzsh_supply.account_display_no_counter

按业务日期分配公开账号编号的计数器。

最终定义：01-structure.sql:28504
主键：business_date
外键：无
索引：account_display_no_counter_pkey

### zzsh_supply.account_guarantee_proof

发布账号所需保证依据及来源绑定。

最终定义：01-structure.sql:28565
主键：id
外键：FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id)；FOREIGN KEY (supersedes_id) REFERENCES zzsh_supply.account_guarantee_proof(id)；FOREIGN KEY (verified_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：account_guarantee_proof_pkey、account_guarantee_proof_version_unique

### zzsh_supply.admin_supply_scope

管理员可管理的游戏供给范围。

最终定义：01-structure.sql:28732
主键：admin_user_id、game_id
外键：FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (granted_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：admin_supply_scope_game_idx、admin_supply_scope_pkey

### zzsh_supply.agreement_version

供给协议正文及封存摘要。

最终定义：01-structure.sql:28791
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：agreement_version_game_status_idx、agreement_version_pkey

### zzsh_supply.billable_item

可计价物品、基础数量单位与精度。

最终定义：01-structure.sql:28918
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id)
索引：billable_item_game_code_unique、billable_item_game_idx、billable_item_pkey

### zzsh_supply.duplicate_hint

供给重复线索，不自动合并账号身份。

最终定义：01-structure.sql:29065
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (related_account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (reviewer_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：duplicate_hint_pkey

### zzsh_supply.entitlement

账号权益字典及值类型、有效期类型。

最终定义：01-structure.sql:29156
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)
索引：entitlement_game_code_unique、entitlement_game_idx、entitlement_pkey

### zzsh_supply.favorite

用户收藏的账号关联。

最终定义：01-structure.sql:29277
主键：user_id、account_id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id)
索引：favorite_pkey、favorite_user_page

### zzsh_supply.firearm

枪械稳定词条。

最终定义：01-structure.sql:29329
主键：id
外键：FOREIGN KEY (game_id, classification_id) REFERENCES zzsh_supply.firearm_classification(game_id, id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (game_id, media_id) REFERENCES zzsh_supply.media_asset(game_id, id)；FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：firearm_game_code_unique、firearm_game_id_unique、firearm_game_sort_idx、firearm_pkey、firearm_source_unique

### zzsh_supply.firearm_alias

枪械别名与稳定词条关联。

最终定义：01-structure.sql:29491
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id)；FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：firearm_alias_pkey、firearm_alias_search_idx、firearm_alias_source_unique、firearm_alias_unique

### zzsh_supply.firearm_classification

枪械分类及展示归属。

最终定义：01-structure.sql:29645
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：firearm_classification_game_code_unique、firearm_classification_game_id_unique、firearm_classification_pkey、firearm_classification_source_unique

### zzsh_supply.full_payout_terms_version

包赔条款与价格版本的冻结关联。

最终定义：01-structure.sql:29794
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：full_payout_terms_version_game_id_policy_ref_policy_version_key、full_payout_terms_version_pkey

### zzsh_supply.game

游戏目录与目录修订号、当前规则版本入口。

最终定义：01-structure.sql:29947
主键：id
外键：FOREIGN KEY (cover_media_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (current_release_id) REFERENCES zzsh_supply.rule_release(id)
索引：game_code_key、game_pkey

### zzsh_supply.game_service_operation

游戏服务类型的支持与启停配置。

最终定义：01-structure.sql:30053
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)
索引：game_service_operation_game_idx、game_service_operation_pkey、game_service_operation_unique

### zzsh_supply.gunsmith_code

改枪码与枪械、来源的关联。

最终定义：01-structure.sql:30140
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id)；FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：gunsmith_code_game_code_unique、gunsmith_code_pkey、gunsmith_code_public_idx、gunsmith_code_source_unique

### zzsh_supply.idempotency_record

跨订单、资金与会员域复用的作用域键、请求指纹及原回执。

最终定义：01-structure.sql:30298
主键：scope_key、key
外键：无
索引：idempotency_record_pkey

### zzsh_supply.inventory_line

申报版本逐物品的基础单位库存数量。

最终定义：01-structure.sql:30379
主键：version_id、item_id
外键：FOREIGN KEY (item_id) REFERENCES zzsh_supply.billable_item(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：inventory_line_pkey

### zzsh_supply.legacy_listing_display_snapshot

旧账号按版本封存的展示字段与资源快照。

最终定义：01-structure.sql:30431
主键：account_id、schema_version
外键：FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id)；FOREIGN KEY (account_id) REFERENCES zzsh_supply.legacy_listing_read_snapshot(account_id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：legacy_listing_display_snapshot_pkey

### zzsh_supply.legacy_listing_read_snapshot

旧账号的只读列表与详情快照。

最终定义：01-structure.sql:30550
主键：account_id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id)；FOREIGN KEY (source_system, source_entity, legacy_id) REFERENCES zzsh_supply.legacy_supply_map(source_system, source_entity, legacy_id)
索引：legacy_account_number_lookup、legacy_listing_read_snapshot_pkey

### zzsh_supply.legacy_skin_holding

旧账号皮肤持有的来源摘要与稳定词条集合。

最终定义：01-structure.sql:30677
主键：account_id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id) ON DELETE RESTRICT；FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT；FOREIGN KEY (observation_version_id) REFERENCES zzsh_supply.listing_version(id) ON DELETE RESTRICT
索引：legacy_skin_holding_observation_version_idx、legacy_skin_holding_pkey

### zzsh_supply.legacy_supply_map

旧来源类型与原账号键到新账号的映射。

最终定义：01-structure.sql:30792
主键：source_system、source_entity、legacy_id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：legacy_supply_map_pkey

### zzsh_supply.listing_entitlement

申报版本的权益值与有效期。

最终定义：01-structure.sql:30879
主键：version_id、entitlement_id
外键：FOREIGN KEY (entitlement_id) REFERENCES zzsh_supply.entitlement(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：listing_entitlement_pkey

### zzsh_supply.listing_filter_config

版本化的公开账号筛选展示配置。

最终定义：01-structure.sql:30945
主键：game_id、revision
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (game_id, restore_from_revision) REFERENCES zzsh_supply.listing_filter_config(game_id, revision)
索引：listing_filter_config_pkey

### zzsh_supply.listing_media

申报版本绑定的展示或审核媒体。

最终定义：01-structure.sql:31019
主键：version_id、asset_id
外键：FOREIGN KEY (asset_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：listing_media_pkey、listing_media_version_id_position_key

### zzsh_supply.listing_publication

账号发布事实及当时规则、价格绑定。

最终定义：01-structure.sql:31070
主键：id
外键：FOREIGN KEY (owner_user_id, version_id, rule_release_id, content_hash) REFERENCES zzsh_supply.rule_acceptance(owner_user_id, listing_version_id, rule_release_id, accepted_content_hash)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (published_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (published_by_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id)；FOREIGN KEY (version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id)
索引：listing_publication_account_time_idx、listing_publication_pkey、listing_publication_version_id_key

### zzsh_supply.listing_skin

申报版本与皮肤的关联。

最终定义：01-structure.sql:31192
主键：version_id、skin_id
外键：FOREIGN KEY (skin_id) REFERENCES zzsh_supply.skin(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：listing_skin_pkey

### zzsh_supply.listing_version

出租账号申报内容的冻结版本。

最终定义：01-structure.sql:31240
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id)
索引：listing_review_queue、listing_version_account_id_sequence_key、listing_version_id_account_id_key、listing_version_pkey

### zzsh_supply.media_asset

审核后的媒体资产、访问级别与公开存储绑定。

最终定义：01-structure.sql:31438
主键：id
外键：FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (reviewed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (uploaded_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (uploaded_by_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：media_asset_game_id_unique、media_asset_game_idx、media_asset_pkey、media_asset_review_idx

### zzsh_supply.media_upload_intent

媒体上传意图、主体与完成状态。

最终定义：01-structure.sql:31722
主键：id
外键：FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (consumed_asset_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (uploaded_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (uploaded_by_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：media_upload_intent_pkey、media_upload_intent_token_hash_key

### zzsh_supply.price_line

价格版本逐物品、会员档位的买卖单价。

最终定义：01-structure.sql:31886
主键：id
外键：FOREIGN KEY (item_id) REFERENCES zzsh_supply.billable_item(id)；FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id)
索引：price_line_pkey、price_line_version_item_tier_unique

### zzsh_supply.price_version

价格政策草稿与封存版本。

最终定义：01-structure.sql:31995
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (full_payout_terms_version_id) REFERENCES zzsh_supply.full_payout_terms_version(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：price_version_game_status_idx、price_version_pkey

### zzsh_supply.profile_avatar

用户或管理员当前头像与待审上传绑定。

最终定义：01-structure.sql:32185
主键：realm、subject_id
外键：FOREIGN KEY (current_asset_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (last_review_asset_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (latest_upload_intent_id) REFERENCES zzsh_supply.media_upload_intent(id)；FOREIGN KEY (pending_asset_id) REFERENCES zzsh_supply.media_asset(id)
索引：profile_avatar_pending_idx、profile_avatar_pkey

### zzsh_supply.profile_avatar_policy

自定义头像上传审核策略单例，canonical默认须人工审核。

最终定义：01-structure.sql:32357
主键：singleton
外键：FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：profile_avatar_policy_pkey

### zzsh_supply.rental_account

出租账号身份、号主、公开编号与可租限制。

最终定义：01-structure.sql:32425
主键：id
外键：FOREIGN KEY (current_version_id, id) REFERENCES zzsh_supply.listing_version(id, account_id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)
索引：rental_account_owner_game_idx、rental_account_owner_unique、rental_account_pkey、rental_account_public_number_unique

### zzsh_supply.review_decision

账号申报版本的审核结论。

最终定义：01-structure.sql:32557
主键：id
外键：FOREIGN KEY (release_id) REFERENCES zzsh_supply.rule_release(id)；FOREIGN KEY (reviewer_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id)
索引：review_decision_pkey、review_decision_version_id_key

### zzsh_supply.rule_acceptance

当事人接受的具体规则版本与摘要。

最终定义：01-structure.sql:32649
主键：id
外键：FOREIGN KEY (listing_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id)；FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id)；FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)；FOREIGN KEY (full_payout_terms_version_id) REFERENCES zzsh_supply.full_payout_terms_version(id)；FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id)；FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id)
索引：rule_acceptance_identity_unique、rule_acceptance_pkey

### zzsh_supply.rule_release

依赖价格、租期和协议版本的不可变规则发布。

最终定义：01-structure.sql:32772
主键：id
外键：FOREIGN KEY (activated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (agreement_version_id) REFERENCES zzsh_supply.agreement_version(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id)；FOREIGN KEY (term_version_id) REFERENCES zzsh_supply.term_version(id)
索引：rule_release_game_generation_idx、rule_release_game_generation_unique、rule_release_pkey

### zzsh_supply.skin

稳定皮肤词条及媒体、分类、品质关联。

最终定义：01-structure.sql:32885
主键：id
外键：FOREIGN KEY (category_id) REFERENCES zzsh_supply.skin_category(id)；FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id) ON DELETE RESTRICT；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id)；FOREIGN KEY (game_id, owner_kind, owner_id) REFERENCES zzsh_supply.skin_owner(game_id, kind, id) ON DELETE RESTRICT
索引：skin_game_category_idx、skin_game_code_unique、skin_pkey、skin_source_identity_unique

### zzsh_supply.skin_category

皮肤分类树与表单可见性。

最终定义：01-structure.sql:33127
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (parent_id) REFERENCES zzsh_supply.skin_category(id)
索引：skin_category_game_code_unique、skin_category_game_idx、skin_category_pkey

### zzsh_supply.skin_owner

皮肤归属对象的稳定身份。

最终定义：01-structure.sql:33235
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)
索引：skin_owner_game_kind_code_unique、skin_owner_game_kind_id_unique、skin_owner_pkey

### zzsh_supply.skin_rarity

皮肤品质字典。

最终定义：01-structure.sql:33326
主键：id
外键：FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)
索引：skin_rarity_game_code_unique、skin_rarity_pkey

### zzsh_supply.term_option

租期选项及数量边界。

最终定义：01-structure.sql:33416
主键：id
外键：FOREIGN KEY (version_id) REFERENCES zzsh_supply.term_version(id)
索引：term_option_pkey、term_option_version_code_unique

### zzsh_supply.term_version

租期政策草稿与封存版本。

最终定义：01-structure.sql:33500
主键：id
外键：FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)；FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id)；FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id)
索引：term_version_game_status_idx、term_version_pkey

## 函数与触发器

- `zzsh_content.guard_document_acceptance_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_content.guard_legal_document_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_content.guard_resource_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_content.guard_update_settings()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_credit.guard_credit_event_insert()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_credit.guard_credit_state_update()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_credit.runtime_contract_version()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.clear_admin_password_change_requirement()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.clear_legacy_password_on_change()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.guard_audit_purge_record()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_consultation_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_consultation_scope_operation_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_identity_mapping_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_support_presence_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_support_round_rating_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_im_support_thread_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_legacy_growth_coverage()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_legacy_growth_read_admission()`：核对原覆盖、审计、幂等回执与零来源证明，拒绝补造会员等级。
- `zzsh_iam.guard_rental_membership()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.guard_user_note_append_only()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_iam.initialize_rental_membership()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.migration_registration_time(details jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.protect_admin_first_activation()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.protect_approval_request_snapshot()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.purge_admin_audit_events(p_retention_days integer, p_actor_id text, p_session_id text, p_request_id text, p_dry_run boolean)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.record_auth_user_created()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.record_password_change()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.record_security_change()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.record_user_identity_state_change()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.refresh_user_registration_fact()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.revoke_admin_recovery_on_password_change()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_iam.sync_aftersale_consultation_handler()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_joinpay_payout_profile(canonical text, op text, pid text, key_ref text, i zzsh_order.joinpay_withdrawal_intent)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_joinpay_payout_scope(canonical text, digest text, op text, pid text, profile_digest text, key_ref text, i zzsh_order.joinpay_withdrawal_intent)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_joinpay_refund_profile(canonical text, op text, pid text, key_ref text, i zzsh_order.channel_refund_intent)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_joinpay_withdrawal_admission(i zzsh_order.joinpay_withdrawal_intent, new_reservation boolean)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_legacy_duty_complete(duty_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.assert_legacy_duty_finance_transition(old_row zzsh_order.legacy_order_duty, new_row zzsh_order.legacy_order_duty)`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.assert_legacy_duty_funding(p jsonb, d zzsh_order.legacy_order_duty)`：核对旧单责任与原资金来源，排除已入账或已覆盖历史。
- `zzsh_order.assert_legacy_finance_order_lock(order_id_value text)`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.assert_personal_growth_order_v4(n zzsh_order.rental_order)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.canonical_finance_json(value jsonb, depth integer)`：确定性编码资金依据JSON，供摘要、幂等和来源绑定使用。
- `zzsh_order.capture_native_user_insert()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_abnormal_refund_liability_batch()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_applied_payment()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_channel_transaction_confirmation()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_distribution_relation_knowledge()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_earning_batch()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_earning_reverse_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_finance_batch()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.check_guarantee_batch()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_joinpay_collection_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_joinpay_formal_confirmation_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_joinpay_native_admission_pair()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_joinpay_withdrawal_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_legacy_continuation_result()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_legacy_duty_admission()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_legacy_duty_batch()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_legacy_duty_revision()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_legacy_order_read_audit()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_native_origin_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_native_origin_excludes_legacy()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_native_refund_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_opening_coverage_set()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.check_order_member_joined()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_order_operation_success()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_order_team_ready()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_payment_distribution_basis_pair()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_prestart_termination_closure()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_settlement_posting_batch()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.check_stored_opening_observations()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.derive_payment_referral_inputs(order_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.distribution_policy_contract_version()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.earning_expected_lines(event_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.fill_order_responsible()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.finance_event_wallet_revision()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.finance_history_coverage_read_revision()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.finance_immutable()`：禁止资金事实UPDATE、DELETE或TRUNCATE，保留原始来源。
- `zzsh_order.guard_abnormal_refund_liability_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_abnormal_refund_liability_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_abnormal_refund_liability_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_channel_payment_append_only()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_channel_refund_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_covered_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_distribution_order_admission()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_distribution_participant()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_distribution_policy_head()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_distribution_policy_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_earning_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_earning_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_finance_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_finance_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_finance_history_coverage()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_finance_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_finance_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_first_response_binding()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_guarantee_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_guarantee_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_guarantee_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_im_order_dispatch()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_invitation_relation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_account_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_collection_evidence()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_collection_insert()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_collection_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_collection_request()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_formal_anchor()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_formal_binding()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_formal_confirmation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_payout_attempt()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_payout_evidence()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_payout_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_refund_attempt()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_refund_evidence()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_refund_intent()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_refund_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_withdrawal_audit()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_withdrawal_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_withdrawal_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_withdrawal_intent()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_joinpay_withdrawal_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_continuation_head()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_continuation_immutable()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_duty()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_duty_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_duty_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_duty_finance_fact()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_duty_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_guarantee_coverage()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_guarantee_observation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_order_read_binding()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_legacy_source_owner()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_manual_close_order()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_earning_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_invitation_source()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_invite_code_proof()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_origin_basis()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_origin_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_refund_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_refund_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_refund_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_native_user_insert_proof()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_observation_admission()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_opening_ack()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_opening_basis()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_order_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_order_member()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_order_operation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_order_responsible()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_payment_distribution_basis()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_payment_fact()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_payment_request()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_payment_request_insert()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_personal_order()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_liability_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_liability_event()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_liability_root()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_opening()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_order_cancel()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_termination()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_prestart_termination_decision()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_referral_reversal_declaration()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_referral_transition_source()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_rental_opening()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_rental_order()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_rental_referral_earning()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_settlement_decision()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_settlement_intake()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_settlement_ledger_entry()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_settlement_posting()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_settlement_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_stored_opening_review()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_stored_opening_source_proof()`：将期初审核与新来源证明、原键和九字段事实逐项绑定。
- `zzsh_order.guard_supply_final_funding()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.guard_withdrawal_return_covered()`：要求退回根绑定同事务已审核的提现来源证明。
- `zzsh_order.initialize_native_wallet_origin(user_id_value text, canonical text, digest text, request_id_value text)`：只为获准资源中同事务出生的原生用户初始化零期初。
- `zzsh_order.joinpay_formal_request_effect(request_id_value text, state_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.joinpay_payout_observation_read_revision()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.joinpay_payout_raw_data(o zzsh_order.joinpay_payout_observation)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.joinpay_withdrawal_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.joinpay_withdrawal_expected_lines(event_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.legacy_opening_source_proof(basis_id_value text)`：只返回旧期初绑定的安全来源摘要，不为旧无证明数据补造证明。
- `zzsh_order.lock_finance_history_subject()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.native_abnormal_refund_liability_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.native_abnormal_refund_terminal_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.native_prestart_refund_liability_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.native_prestart_refund_terminal_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.native_refund_terminal_complete(intent_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.native_settlement_wallet_revision()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.next_display_no()`：编号分配。发出公开编号不提升可交易资格。
- `zzsh_order.prestart_liability_complete(termination_id_value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.prestart_payment_basis_valid(b jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.referral_debt_read_revision()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.set_rental_opening_auto_confirm_due()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_order.settlement_snapshot_cents(value text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.support_cancel_payment_basis_valid(b jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.withdrawal_bank_binding_guard()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_order.withdrawal_read_revision()`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_order.withdrawal_wallet_revision()`：资金函数。余额变化必须有对应分录，不能由展示行单独产生。
- `zzsh_supply.assert_listing_publication_final(p_version_id text)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.guard_account_guarantee_proof_immutable()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_account_guarantee_proof_insert()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_account_public_number()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_agreement_version_update()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_asset_account()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_avatar_policy_asset()`：只允许绑定当前策略及待审上传的系统批准；原政策来源不可改写。
- `zzsh_supply.guard_compat_price_line()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_compat_price_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_detail_parents()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_full_payout_acceptance()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_full_payout_price_reference()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_full_payout_terms_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_item_semantics()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_legacy_display_snapshot()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_legacy_read_snapshot()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_legacy_skin_holding()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_legacy_takeover_authorization()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_acceptance()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_child()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_commitments()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_content()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_decision()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_filter_config()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_publication_consistency()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_publication_immutable()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_publication_shape()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_listing_version_publication()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_media_asset_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_price_line_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_price_version_update()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_profile_avatar_policy()`：禁止删除头像策略单例，修改必须严格推进CAS版本。
- `zzsh_supply.guard_public_derivative()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_release_immutable()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_rental_identity()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_rule_release_insert()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_sealed_term_version()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_skin_category_tree()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_skin_identity_write()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_term_option_mutation()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.guard_version_identity()`：写入守卫。拒绝破坏不变式、已覆盖截点或不可变历史的写入。
- `zzsh_supply.jsonb_exact_keys(doc jsonb, keys text[])`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.next_account_display_no()`：编号分配。发出公开编号不提升可交易资格。
- `zzsh_supply.next_dated_account_display_no()`：编号分配。发出公开编号不提升可交易资格。
- `zzsh_supply.skin_aliases_valid(value text[])`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.skin_text_valid(value text, max_chars integer, canonical boolean)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.valid_compat_haff_rule(rule jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.valid_funding_policy(policy jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.valid_funding_policy_draft(policy jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.valid_funding_policy_legacy_v1(policy jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `zzsh_supply.valid_owner_deposit_declaration(declaration jsonb)`：结构函数。函数体、安全属性和search_path以随后定义原文为准。
- `admin_clear_legacy_password` ON `zzsh_auth_admin.account` → `zzsh_iam.clear_legacy_password_on_change`
- `admin_password_change_audit` ON `zzsh_auth_admin.account` → `zzsh_iam.record_password_change`
- `admin_password_change_requirement` ON `zzsh_auth_admin.account` → `zzsh_iam.clear_admin_password_change_requirement`
- `admin_recovery_revoke_on_password_change` ON `zzsh_auth_admin.account` → `zzsh_iam.revoke_admin_recovery_on_password_change`
- `admin_session_audit` ON `zzsh_auth_admin.session` → `zzsh_iam.record_security_change`
- `admin_two_factor_audit` ON `zzsh_auth_admin.twoFactor` → `zzsh_iam.record_security_change`
- `admin_auth_creation_audit` ON `zzsh_auth_admin.user` → `zzsh_iam.record_auth_user_created`
- `user_clear_legacy_password` ON `zzsh_auth_user.account` → `zzsh_iam.clear_legacy_password_on_change`
- `user_password_change_audit` ON `zzsh_auth_user.account` → `zzsh_iam.record_password_change`
- `user_session_audit` ON `zzsh_auth_user.session` → `zzsh_iam.record_security_change`
- `user_two_factor_audit` ON `zzsh_auth_user.twoFactor` → `zzsh_iam.record_security_change`
- `native_user_insert_proof_capture` ON `zzsh_auth_user.user` → `zzsh_order.capture_native_user_insert`
- `user_auth_creation_audit` ON `zzsh_auth_user.user` → `zzsh_iam.record_auth_user_created`
- `user_rental_membership_init` ON `zzsh_auth_user.user` → `zzsh_iam.initialize_rental_membership`
- `content_resource_version_guard` ON `zzsh_content.content_version` → `zzsh_content.guard_resource_version`
- `content_update_settings_guard` ON `zzsh_content.content_version` → `zzsh_content.guard_update_settings`
- `document_acceptance_immutable` ON `zzsh_content.document_acceptance` → `zzsh_content.guard_document_acceptance_mutation`
- `legal_document_version_guard` ON `zzsh_content.legal_document_version` → `zzsh_content.guard_legal_document_version`
- `credit_event_guard` ON `zzsh_credit.credit_event` → `zzsh_credit.guard_credit_event_insert`
- `credit_event_immutable` ON `zzsh_credit.credit_event` → `zzsh_credit.guard_credit_state_update`
- `user_credit_state_guard` ON `zzsh_credit.user_credit_state` → `zzsh_credit.guard_credit_state_update`
- `admin_first_activation_evidence` ON `zzsh_iam.admin_security` → `zzsh_iam.protect_admin_first_activation`
- `admin_security_audit` ON `zzsh_iam.admin_security` → `zzsh_iam.record_security_change`
- `approval_request_snapshot_guard` ON `zzsh_iam.approval_request` → `zzsh_iam.protect_approval_request_snapshot`
- `audit_purge_record_guard` ON `zzsh_iam.audit_event` → `zzsh_iam.guard_audit_purge_record`
- `joinpay_withdrawal_audit_guard` ON `zzsh_iam.audit_event` → `zzsh_order.guard_joinpay_withdrawal_audit`
- `native_origin_excludes_legacy_source` ON `zzsh_iam.audit_event` → `zzsh_order.check_native_origin_excludes_legacy`
- `user_registration_fact_after_migration` ON `zzsh_iam.audit_event` → `zzsh_iam.refresh_user_registration_fact`
- `im_aftersale_follow_consultation` ON `zzsh_iam.im_consultation` → `zzsh_iam.sync_aftersale_consultation_handler`
- `im_consultation_mutation_guard` ON `zzsh_iam.im_consultation` → `zzsh_iam.guard_im_consultation_mutation`
- `im_consultation_scope_operation_mutation_guard` ON `zzsh_iam.im_consultation_scope_operation` → `zzsh_iam.guard_im_consultation_scope_operation_mutation`
- `im_identity_mapping_mutation_guard` ON `zzsh_iam.im_identity_mapping` → `zzsh_iam.guard_im_identity_mapping_mutation`
- `im_support_presence_mutation_guard` ON `zzsh_iam.im_support_presence` → `zzsh_iam.guard_im_support_presence_mutation`
- `im_support_round_rating_mutation_guard` ON `zzsh_iam.im_support_round_rating` → `zzsh_iam.guard_im_support_round_rating_mutation`
- `im_support_thread_mutation_guard` ON `zzsh_iam.im_support_thread` → `zzsh_iam.guard_im_support_thread_mutation`
- `legacy_growth_coverage_guard` ON `zzsh_iam.membership_growth_legacy_coverage` → `zzsh_iam.guard_legacy_growth_coverage`
- `legacy_growth_coverage_no_truncate` ON `zzsh_iam.membership_growth_legacy_coverage` → `zzsh_iam.guard_legacy_growth_coverage`
- `legacy_growth_read_admission_guard` ON `zzsh_iam.membership_growth_legacy_read_admission` → `zzsh_iam.guard_legacy_growth_read_admission`
- `legacy_growth_read_admission_no_truncate` ON `zzsh_iam.membership_growth_legacy_read_admission` → `zzsh_iam.guard_legacy_growth_read_admission`
- `user_identity_state_audit` ON `zzsh_iam.user_identity_state` → `zzsh_iam.record_user_identity_state_change`
- `user_note_append_only` ON `zzsh_iam.user_note` → `zzsh_iam.guard_user_note_append_only`
- `rental_membership_guard` ON `zzsh_iam.user_rental_membership` → `zzsh_iam.guard_rental_membership`
- `channel_refund_joinpay_delete_guard` ON `zzsh_order.channel_refund_intent` → `zzsh_order.guard_joinpay_refund_intent`
- `channel_refund_joinpay_write_guard` ON `zzsh_order.channel_refund_intent` → `zzsh_order.guard_joinpay_refund_intent`
- `native_refund_intent_closure` ON `zzsh_order.channel_refund_intent` → `zzsh_order.check_native_refund_closure`
- `channel_refund_observation_guard` ON `zzsh_order.channel_refund_observation` → `zzsh_order.guard_channel_refund_observation`
- `distribution_code_immutable` ON `zzsh_order.distribution_invite_code` → `zzsh_order.finance_immutable`
- `native_invite_code_proof` ON `zzsh_order.distribution_invite_code` → `zzsh_order.guard_native_invite_code_proof`
- `distribution_order_admission_guard` ON `zzsh_order.distribution_order_admission` → `zzsh_order.guard_distribution_order_admission`
- `distribution_order_admission_immutable` ON `zzsh_order.distribution_order_admission` → `zzsh_order.finance_immutable`
- `native_admission_formal_binding_pair` ON `zzsh_order.distribution_order_admission` → `zzsh_order.check_joinpay_native_admission_pair`
- `distribution_participant_guard` ON `zzsh_order.distribution_participant` → `zzsh_order.guard_distribution_participant`
- `distribution_participant_knowledge_guard` ON `zzsh_order.distribution_participant` → `zzsh_order.check_distribution_relation_knowledge`
- `distribution_policy_head_guard` ON `zzsh_order.distribution_policy_head` → `zzsh_order.guard_distribution_policy_head`
- `distribution_policy_version_guard` ON `zzsh_order.distribution_policy_version` → `zzsh_order.guard_distribution_policy_version`
- `distribution_policy_version_immutable` ON `zzsh_order.distribution_policy_version` → `zzsh_order.finance_immutable`
- `covered_event_guard` ON `zzsh_order.finance_covered_event` → `zzsh_order.guard_covered_event`
- `covered_event_immutable` ON `zzsh_order.finance_covered_event` → `zzsh_order.finance_immutable`
- `covered_event_set_guard` ON `zzsh_order.finance_covered_event` → `zzsh_order.check_opening_coverage_set`
- `withdrawal_return_covered_guard` ON `zzsh_order.finance_covered_event` → `zzsh_order.guard_withdrawal_return_covered`
- `abnormal_refund_liability_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_abnormal_refund_liability_root`
- `earning_root_reverse_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.check_earning_reverse_closure`
- `economic_root_immutable` ON `zzsh_order.finance_economic_root` → `zzsh_order.finance_immutable`
- `finance_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_finance_root`
- `guarantee_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_guarantee_root`
- `joinpay_withdrawal_root_closure` ON `zzsh_order.finance_economic_root` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_withdrawal_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_joinpay_withdrawal_root`
- `legacy_duty_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_legacy_duty_root`
- `native_earning_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_native_earning_root`
- `native_origin_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_native_origin_root`
- `native_refund_root_closure` ON `zzsh_order.finance_economic_root` → `zzsh_order.check_native_refund_closure`
- `native_refund_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_native_refund_root`
- `prestart_liability_root_guard` ON `zzsh_order.finance_economic_root` → `zzsh_order.guard_prestart_liability_root`
- `prestart_root_closure` ON `zzsh_order.finance_economic_root` → `zzsh_order.check_prestart_termination_closure`
- `abnormal_refund_liability_event_batch_guard` ON `zzsh_order.finance_event` → `zzsh_order.check_abnormal_refund_liability_batch`
- `abnormal_refund_liability_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_abnormal_refund_liability_event`
- `earning_event_batch_guard` ON `zzsh_order.finance_event` → `zzsh_order.check_earning_batch`
- `earning_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_earning_event`
- `earning_event_reverse_guard` ON `zzsh_order.finance_event` → `zzsh_order.check_earning_reverse_closure`
- `finance_event_batch_guard` ON `zzsh_order.finance_event` → `zzsh_order.check_finance_batch`
- `finance_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_finance_event`
- `finance_event_immutable` ON `zzsh_order.finance_event` → `zzsh_order.finance_immutable`
- `finance_event_revision` ON `zzsh_order.finance_event` → `zzsh_order.finance_event_wallet_revision`
- `guarantee_event_batch_guard` ON `zzsh_order.finance_event` → `zzsh_order.check_guarantee_batch`
- `guarantee_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_guarantee_event`
- `joinpay_withdrawal_event_closure` ON `zzsh_order.finance_event` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_withdrawal_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_joinpay_withdrawal_event`
- `joinpay_withdrawal_wallet_revision` ON `zzsh_order.finance_event` → `zzsh_order.withdrawal_wallet_revision`
- `legacy_duty_event_batch` ON `zzsh_order.finance_event` → `zzsh_order.check_legacy_duty_batch`
- `legacy_duty_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_legacy_duty_event`
- `legacy_duty_wallet_revision` ON `zzsh_order.finance_event` → `zzsh_order.withdrawal_wallet_revision`
- `native_refund_event_closure` ON `zzsh_order.finance_event` → `zzsh_order.check_native_refund_closure`
- `native_refund_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_native_refund_event`
- `native_refund_wallet_revision` ON `zzsh_order.finance_event` → `zzsh_order.withdrawal_wallet_revision`
- `prestart_event_closure` ON `zzsh_order.finance_event` → `zzsh_order.check_prestart_termination_closure`
- `prestart_liability_event_guard` ON `zzsh_order.finance_event` → `zzsh_order.guard_prestart_liability_event`
- `withdrawal_revision` ON `zzsh_order.finance_event` → `zzsh_order.withdrawal_wallet_revision`
- `observation_admission_guard` ON `zzsh_order.finance_observation_admission` → `zzsh_order.guard_observation_admission`
- `observation_admission_immutable` ON `zzsh_order.finance_observation_admission` → `zzsh_order.finance_immutable`
- `native_origin_basis_guard` ON `zzsh_order.finance_opening_basis` → `zzsh_order.guard_native_origin_basis`
- `native_origin_complete_batch` ON `zzsh_order.finance_opening_basis` → `zzsh_order.check_native_origin_closure`
- `native_origin_excludes_legacy_basis` ON `zzsh_order.finance_opening_basis` → `zzsh_order.check_native_origin_excludes_legacy`
- `opening_basis_guard` ON `zzsh_order.finance_opening_basis` → `zzsh_order.guard_opening_basis`
- `opening_basis_immutable` ON `zzsh_order.finance_opening_basis` → `zzsh_order.finance_immutable`
- `opening_coverage_set_guard` ON `zzsh_order.finance_opening_basis` → `zzsh_order.check_opening_coverage_set`
- `stored_opening_observations_guard` ON `zzsh_order.finance_stored_opening_review` → `zzsh_order.check_stored_opening_observations`
- `stored_opening_review_guard` ON `zzsh_order.finance_stored_opening_review` → `zzsh_order.guard_stored_opening_review`
- `stored_opening_review_immutable` ON `zzsh_order.finance_stored_opening_review` → `zzsh_order.finance_immutable`
- `stored_opening_source_proof_guard` ON `zzsh_order.finance_stored_opening_review` → `zzsh_order.guard_stored_opening_source_proof`
- `im_order_event_guard` ON `zzsh_order.im_order_event` → `zzsh_order.guard_order_event`
- `im_order_group_dispatch_guard` ON `zzsh_order.im_order_group` → `zzsh_order.guard_im_order_dispatch`
- `im_order_group_first_response_guard` ON `zzsh_order.im_order_group` → `zzsh_order.guard_first_response_binding`
- `im_order_group_responsible_fill` ON `zzsh_order.im_order_group` → `zzsh_order.fill_order_responsible`
- `im_order_group_responsible_guard` ON `zzsh_order.im_order_group` → `zzsh_order.guard_order_responsible`
- `im_order_team_ready_guard` ON `zzsh_order.im_order_group` → `zzsh_order.check_order_team_ready`
- `im_order_member_guard` ON `zzsh_order.im_order_member` → `zzsh_order.guard_order_member`
- `im_order_member_joined_guard` ON `zzsh_order.im_order_member` → `zzsh_order.check_order_member_joined`
- `im_order_operation_guard` ON `zzsh_order.im_order_operation` → `zzsh_order.guard_order_operation`
- `im_order_operation_success_guard` ON `zzsh_order.im_order_operation` → `zzsh_order.check_order_operation_success`
- `invitation_relation_cycle_guard` ON `zzsh_order.invitation_relation` → `zzsh_order.guard_invitation_relation`
- `invitation_relation_immutable` ON `zzsh_order.invitation_relation` → `zzsh_order.finance_immutable`
- `invitation_relation_knowledge_guard` ON `zzsh_order.invitation_relation` → `zzsh_order.check_distribution_relation_knowledge`
- `invitation_relation_source_guard` ON `zzsh_order.invitation_relation` → `zzsh_order.guard_native_invitation_source`
- `joinpay_account_observation_immutable` ON `zzsh_order.joinpay_account_observation` → `zzsh_order.guard_joinpay_account_observation`
- `joinpay_account_observation_insert` ON `zzsh_order.joinpay_account_observation` → `zzsh_order.guard_joinpay_account_observation`
- `joinpay_collection_attempt_append_only` ON `zzsh_order.joinpay_collection_attempt` → `zzsh_order.guard_channel_payment_append_only`
- `joinpay_collection_attempt_guard` ON `zzsh_order.joinpay_collection_attempt` → `zzsh_order.guard_joinpay_collection_insert`
- `joinpay_collection_binding_append_only` ON `zzsh_order.joinpay_collection_binding` → `zzsh_order.guard_channel_payment_append_only`
- `joinpay_collection_binding_guard` ON `zzsh_order.joinpay_collection_binding` → `zzsh_order.guard_joinpay_collection_insert`
- `joinpay_formal_binding_admission_pair` ON `zzsh_order.joinpay_collection_binding` → `zzsh_order.check_joinpay_native_admission_pair`
- `joinpay_formal_binding_guard` ON `zzsh_order.joinpay_collection_binding` → `zzsh_order.guard_joinpay_formal_binding`
- `joinpay_collection_evidence_append_only` ON `zzsh_order.joinpay_collection_evidence` → `zzsh_order.guard_channel_payment_append_only`
- `joinpay_collection_evidence_guard` ON `zzsh_order.joinpay_collection_evidence` → `zzsh_order.guard_joinpay_collection_evidence`
- `joinpay_collection_observation_append_only` ON `zzsh_order.joinpay_collection_observation` → `zzsh_order.guard_channel_payment_append_only`
- `joinpay_collection_observation_guard` ON `zzsh_order.joinpay_collection_observation` → `zzsh_order.guard_joinpay_collection_observation`
- `joinpay_payout_attempt_closure` ON `zzsh_order.joinpay_payout_attempt` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_payout_attempt_guard` ON `zzsh_order.joinpay_payout_attempt` → `zzsh_order.guard_joinpay_payout_attempt`
- `joinpay_payout_attempt_immutable` ON `zzsh_order.joinpay_payout_attempt` → `zzsh_order.finance_immutable`
- `joinpay_payout_evidence_closure` ON `zzsh_order.joinpay_payout_evidence` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_payout_evidence_guard` ON `zzsh_order.joinpay_payout_evidence` → `zzsh_order.guard_joinpay_payout_evidence`
- `joinpay_payout_evidence_immutable` ON `zzsh_order.joinpay_payout_evidence` → `zzsh_order.finance_immutable`
- `joinpay_payout_observation_closure` ON `zzsh_order.joinpay_payout_observation` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_payout_observation_guard` ON `zzsh_order.joinpay_payout_observation` → `zzsh_order.guard_joinpay_payout_observation`
- `joinpay_payout_observation_immutable` ON `zzsh_order.joinpay_payout_observation` → `zzsh_order.finance_immutable`
- `joinpay_payout_observation_read_revision` ON `zzsh_order.joinpay_payout_observation` → `zzsh_order.joinpay_payout_observation_read_revision`
- `joinpay_refund_attempt_guard` ON `zzsh_order.joinpay_refund_attempt` → `zzsh_order.guard_joinpay_refund_attempt`
- `joinpay_refund_attempt_immutable` ON `zzsh_order.joinpay_refund_attempt` → `zzsh_order.finance_immutable`
- `joinpay_refund_evidence_guard` ON `zzsh_order.joinpay_refund_evidence` → `zzsh_order.guard_joinpay_refund_evidence`
- `joinpay_refund_evidence_immutable` ON `zzsh_order.joinpay_refund_evidence` → `zzsh_order.finance_immutable`
- `native_refund_evidence_closure` ON `zzsh_order.joinpay_refund_evidence` → `zzsh_order.check_native_refund_closure`
- `joinpay_refund_observation_guard` ON `zzsh_order.joinpay_refund_observation` → `zzsh_order.guard_joinpay_refund_observation`
- `joinpay_refund_observation_immutable` ON `zzsh_order.joinpay_refund_observation` → `zzsh_order.finance_immutable`
- `native_refund_observation_closure` ON `zzsh_order.joinpay_refund_observation` → `zzsh_order.check_native_refund_closure`
- `joinpay_withdrawal_intent_closure` ON `zzsh_order.joinpay_withdrawal_intent` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_withdrawal_intent_guard` ON `zzsh_order.joinpay_withdrawal_intent` → `zzsh_order.guard_joinpay_withdrawal_intent`
- `joinpay_withdrawal_read_revision` ON `zzsh_order.joinpay_withdrawal_intent` → `zzsh_order.withdrawal_read_revision`
- `a_legacy_evidence_source_owner` ON `zzsh_order.legacy_continuation_evidence` → `zzsh_order.guard_legacy_source_owner`
- `legacy_evidence_immutable` ON `zzsh_order.legacy_continuation_evidence` → `zzsh_order.guard_legacy_continuation_immutable`
- `legacy_head_update` ON `zzsh_order.legacy_continuation_version` → `zzsh_order.guard_legacy_continuation_head`
- `legacy_result_complete` ON `zzsh_order.legacy_continuation_version` → `zzsh_order.check_legacy_continuation_result`
- `legacy_duty_contract_immutable` ON `zzsh_order.legacy_duty_finance_contract` → `zzsh_order.finance_immutable`
- `legacy_duty_fact_batch` ON `zzsh_order.legacy_duty_finance_fact` → `zzsh_order.check_legacy_duty_batch`
- `legacy_duty_fact_guard` ON `zzsh_order.legacy_duty_finance_fact` → `zzsh_order.guard_legacy_duty_finance_fact`
- `legacy_duty_fact_immutable` ON `zzsh_order.legacy_duty_finance_fact` → `zzsh_order.finance_immutable`
- `a_legacy_register_source_owner` ON `zzsh_order.legacy_inflight_register` → `zzsh_order.guard_legacy_source_owner`
- `legacy_inflight_register_immutable` ON `zzsh_order.legacy_inflight_register` → `zzsh_order.guard_legacy_continuation_immutable`
- `a_legacy_duty_source_owner` ON `zzsh_order.legacy_order_duty` → `zzsh_order.guard_legacy_source_owner`
- `legacy_duty_guard` ON `zzsh_order.legacy_order_duty` → `zzsh_order.guard_legacy_duty`
- `legacy_duty_revision_complete` ON `zzsh_order.legacy_order_duty` → `zzsh_order.check_legacy_duty_revision`
- `a_legacy_admission_source_owner` ON `zzsh_order.legacy_order_duty_admission` → `zzsh_order.guard_legacy_source_owner`
- `legacy_duty_admission_complete` ON `zzsh_order.legacy_order_duty_admission` → `zzsh_order.check_legacy_duty_admission`
- `legacy_duty_admission_immutable` ON `zzsh_order.legacy_order_duty_admission` → `zzsh_order.guard_legacy_continuation_immutable`
- `legacy_duty_revision_immutable` ON `zzsh_order.legacy_order_duty_revision` → `zzsh_order.guard_legacy_continuation_immutable`
- `legacy_order_read_audit` ON `zzsh_order.legacy_order_read_snapshot` → `zzsh_order.check_legacy_order_read_audit`
- `legacy_order_read_binding` ON `zzsh_order.legacy_order_read_snapshot` → `zzsh_order.guard_legacy_order_read_binding`
- `legacy_order_read_immutable` ON `zzsh_order.legacy_order_read_snapshot` → `zzsh_supply.guard_release_immutable`
- `legacy_guarantee_coverage_guard` ON `zzsh_order.legacy_owner_guarantee_coverage` → `zzsh_order.guard_legacy_guarantee_coverage`
- `legacy_guarantee_coverage_immutable` ON `zzsh_order.legacy_owner_guarantee_coverage` → `zzsh_order.finance_immutable`
- `legacy_guarantee_observation_guard` ON `zzsh_order.legacy_owner_guarantee_observation` → `zzsh_order.guard_legacy_guarantee_observation`
- `legacy_guarantee_observation_immutable` ON `zzsh_order.legacy_owner_guarantee_observation` → `zzsh_order.finance_immutable`
- `native_origin_resource_admission_immutable` ON `zzsh_order.native_origin_resource_admission` → `zzsh_order.finance_immutable`
- `native_origin_resource_admission_no_truncate` ON `zzsh_order.native_origin_resource_admission` → `zzsh_order.finance_immutable`
- `native_user_insert_proof_immutable` ON `zzsh_order.native_user_insert_proof` → `zzsh_order.finance_immutable`
- `native_user_insert_proof_issuer` ON `zzsh_order.native_user_insert_proof` → `zzsh_order.guard_native_user_insert_proof`
- `native_user_insert_proof_no_truncate` ON `zzsh_order.native_user_insert_proof` → `zzsh_order.finance_immutable`
- `payment_channel_observation_append_only` ON `zzsh_order.payment_channel_observation` → `zzsh_order.guard_channel_payment_append_only`
- `joinpay_formal_anchor_guard` ON `zzsh_order.payment_channel_transaction` → `zzsh_order.guard_joinpay_formal_anchor`
- `payment_channel_transaction_append_only` ON `zzsh_order.payment_channel_transaction` → `zzsh_order.guard_channel_payment_append_only`
- `payment_channel_transaction_confirmation_guard` ON `zzsh_order.payment_channel_transaction` → `zzsh_order.check_channel_transaction_confirmation`
- `applied_distribution_basis_pair` ON `zzsh_order.payment_confirmation` → `zzsh_order.check_payment_distribution_basis_pair`
- `joinpay_formal_confirmation_closure` ON `zzsh_order.payment_confirmation` → `zzsh_order.check_joinpay_formal_confirmation_closure`
- `joinpay_formal_confirmation_guard` ON `zzsh_order.payment_confirmation` → `zzsh_order.guard_joinpay_formal_confirmation`
- `payment_confirmation_applied_guard` ON `zzsh_order.payment_confirmation` → `zzsh_order.check_applied_payment`
- `payment_confirmation_immutable` ON `zzsh_order.payment_confirmation` → `zzsh_order.guard_payment_fact`
- `distribution_basis_applied_pair` ON `zzsh_order.payment_distribution_basis` → `zzsh_order.check_payment_distribution_basis_pair`
- `payment_distribution_basis_guard` ON `zzsh_order.payment_distribution_basis` → `zzsh_order.guard_payment_distribution_basis`
- `payment_distribution_basis_immutable` ON `zzsh_order.payment_distribution_basis` → `zzsh_order.finance_immutable`
- `joinpay_collection_request_closure` ON `zzsh_order.payment_request` → `zzsh_order.check_joinpay_collection_closure`
- `joinpay_collection_request_guard` ON `zzsh_order.payment_request` → `zzsh_order.guard_joinpay_collection_request`
- `payment_request_guard` ON `zzsh_order.payment_request` → `zzsh_order.guard_payment_request`
- `payment_request_insert_guard` ON `zzsh_order.payment_request` → `zzsh_order.guard_payment_request_insert`
- `a_history_subject_lock` ON `zzsh_order.personal_finance_observation` → `zzsh_order.lock_finance_history_subject`
- `finance_observation_guard` ON `zzsh_order.personal_finance_observation` → `zzsh_order.guard_finance_observation`
- `finance_observation_immutable` ON `zzsh_order.personal_finance_observation` → `zzsh_order.finance_immutable`
- `history_coverage_guard` ON `zzsh_order.personal_finance_observation_coverage` → `zzsh_order.guard_finance_history_coverage`
- `history_coverage_immutable` ON `zzsh_order.personal_finance_observation_coverage` → `zzsh_order.finance_immutable`
- `history_coverage_read_revision` ON `zzsh_order.personal_finance_observation_coverage` → `zzsh_order.finance_history_coverage_read_revision`
- `prestart_request_closure` ON `zzsh_order.prestart_termination` → `zzsh_order.check_prestart_termination_closure`
- `prestart_termination_guard` ON `zzsh_order.prestart_termination` → `zzsh_order.guard_prestart_termination`
- `prestart_decision_closure` ON `zzsh_order.prestart_termination_decision` → `zzsh_order.check_prestart_termination_closure`
- `prestart_decision_guard` ON `zzsh_order.prestart_termination_decision` → `zzsh_order.guard_prestart_termination_decision`
- `prestart_decision_immutable` ON `zzsh_order.prestart_termination_decision` → `zzsh_order.finance_immutable`
- `prestart_opening_guard` ON `zzsh_order.rental_opening` → `zzsh_order.guard_prestart_opening`
- `rental_opening_auto_confirm_due_set` ON `zzsh_order.rental_opening` → `zzsh_order.set_rental_opening_auto_confirm_due`
- `rental_opening_guard` ON `zzsh_order.rental_opening` → `zzsh_order.guard_rental_opening`
- `prestart_opening_ack_guard` ON `zzsh_order.rental_opening_ack` → `zzsh_order.guard_prestart_opening`
- `rental_opening_ack_guard` ON `zzsh_order.rental_opening_ack` → `zzsh_order.guard_opening_ack`
- `manual_close_order_guard` ON `zzsh_order.rental_order` → `zzsh_order.guard_manual_close_order`
- `prestart_order_cancel_guard` ON `zzsh_order.rental_order` → `zzsh_order.guard_prestart_order_cancel`
- `prestart_order_closure` ON `zzsh_order.rental_order` → `zzsh_order.check_prestart_termination_closure`
- `rental_order_guard` ON `zzsh_order.rental_order` → `zzsh_order.guard_rental_order`
- `rental_order_personal_guard` ON `zzsh_order.rental_order` → `zzsh_order.guard_personal_order`
- `supply_final_funding_guard` ON `zzsh_order.rental_order` → `zzsh_order.guard_supply_final_funding`
- `earning_state_reverse_guard` ON `zzsh_order.rental_referral_earning` → `zzsh_order.check_earning_reverse_closure`
- `rental_referral_earning_guard` ON `zzsh_order.rental_referral_earning` → `zzsh_order.guard_rental_referral_earning`
- `referral_reversal_declaration_guard` ON `zzsh_order.rental_referral_reversal_source` → `zzsh_order.guard_referral_reversal_declaration`
- `referral_reversal_source_immutable` ON `zzsh_order.rental_referral_reversal_source` → `zzsh_order.finance_immutable`
- `earning_transition_reverse_guard` ON `zzsh_order.rental_referral_transition` → `zzsh_order.check_earning_reverse_closure`
- `referral_debt_read_revision` ON `zzsh_order.rental_referral_transition` → `zzsh_order.referral_debt_read_revision`
- `referral_transition_immutable` ON `zzsh_order.rental_referral_transition` → `zzsh_order.finance_immutable`
- `referral_transition_source_guard` ON `zzsh_order.rental_referral_transition` → `zzsh_order.guard_referral_transition_source`
- `settlement_decision_guard` ON `zzsh_order.settlement_decision` → `zzsh_order.guard_settlement_decision`
- `settlement_intake_guard` ON `zzsh_order.settlement_intake` → `zzsh_order.guard_settlement_intake`
- `abnormal_refund_liability_entry_batch_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_abnormal_refund_liability_batch`
- `abnormal_refund_liability_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_abnormal_refund_liability_entry`
- `earning_entry_batch_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_earning_batch`
- `earning_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_earning_entry`
- `finance_entry_batch_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_finance_batch`
- `finance_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_finance_entry`
- `guarantee_entry_batch_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_guarantee_batch`
- `guarantee_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_guarantee_entry`
- `joinpay_withdrawal_entry_closure` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_joinpay_withdrawal_closure`
- `joinpay_withdrawal_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_joinpay_withdrawal_entry`
- `ledger_immutable` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.finance_immutable`
- `legacy_duty_entry_batch` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_legacy_duty_batch`
- `legacy_duty_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_legacy_duty_entry`
- `native_refund_entry_closure` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_native_refund_closure`
- `native_refund_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_native_refund_entry`
- `prestart_entry_closure` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_prestart_termination_closure`
- `prestart_liability_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_prestart_liability_entry`
- `settlement_ledger_batch_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.check_settlement_posting_batch`
- `settlement_ledger_entry_guard` ON `zzsh_order.settlement_ledger_entry` → `zzsh_order.guard_settlement_ledger_entry`
- `native_settlement_revision` ON `zzsh_order.settlement_posting` → `zzsh_order.native_settlement_wallet_revision`
- `settlement_posting_batch_guard` ON `zzsh_order.settlement_posting` → `zzsh_order.check_settlement_posting_batch`
- `settlement_posting_guard` ON `zzsh_order.settlement_posting` → `zzsh_order.guard_settlement_posting`
- `settlement_version_guard` ON `zzsh_order.settlement_version` → `zzsh_order.guard_settlement_version`
- `wallet_coverage_immutable` ON `zzsh_order.wallet_coverage` → `zzsh_order.finance_immutable`
- `withdrawal_bank_binding_guard` ON `zzsh_order.withdrawal_bank_binding` → `zzsh_order.withdrawal_bank_binding_guard`
- `account_guarantee_proof_immutable` ON `zzsh_supply.account_guarantee_proof` → `zzsh_supply.guard_account_guarantee_proof_immutable`
- `account_guarantee_proof_insert_guard` ON `zzsh_supply.account_guarantee_proof` → `zzsh_supply.guard_account_guarantee_proof_insert`
- `a_version_identity` ON `zzsh_supply.agreement_version` → `zzsh_supply.guard_version_identity`
- `agreement_version_seal_guard` ON `zzsh_supply.agreement_version` → `zzsh_supply.guard_agreement_version_update`
- `item_semantics` ON `zzsh_supply.billable_item` → `zzsh_supply.guard_item_semantics`
- `duplicate_immutable` ON `zzsh_supply.duplicate_hint` → `zzsh_supply.guard_release_immutable`
- `full_payout_terms_version_guard` ON `zzsh_supply.full_payout_terms_version` → `zzsh_supply.guard_full_payout_terms_version`
- `listing_child` ON `zzsh_supply.inventory_line` → `zzsh_supply.guard_listing_child`
- `legacy_display_immutable` ON `zzsh_supply.legacy_listing_display_snapshot` → `zzsh_supply.guard_release_immutable`
- `legacy_display_insert` ON `zzsh_supply.legacy_listing_display_snapshot` → `zzsh_supply.guard_legacy_display_snapshot`
- `legacy_read_snapshot_immutable` ON `zzsh_supply.legacy_listing_read_snapshot` → `zzsh_supply.guard_release_immutable`
- `legacy_read_snapshot_insert` ON `zzsh_supply.legacy_listing_read_snapshot` → `zzsh_supply.guard_legacy_read_snapshot`
- `legacy_skin_holding_guard` ON `zzsh_supply.legacy_skin_holding` → `zzsh_supply.guard_legacy_skin_holding`
- `legacy_map_immutable` ON `zzsh_supply.legacy_supply_map` → `zzsh_supply.guard_release_immutable`
- `listing_child` ON `zzsh_supply.listing_entitlement` → `zzsh_supply.guard_listing_child`
- `listing_filter_config_guard` ON `zzsh_supply.listing_filter_config` → `zzsh_supply.guard_listing_filter_config`
- `listing_child` ON `zzsh_supply.listing_media` → `zzsh_supply.guard_listing_child`
- `listing_publication_consistency` ON `zzsh_supply.listing_publication` → `zzsh_supply.guard_listing_publication_consistency`
- `listing_publication_immutable` ON `zzsh_supply.listing_publication` → `zzsh_supply.guard_listing_publication_immutable`
- `listing_publication_shape` ON `zzsh_supply.listing_publication` → `zzsh_supply.guard_listing_publication_shape`
- `listing_child` ON `zzsh_supply.listing_skin` → `zzsh_supply.guard_listing_child`
- `listing_commitments` ON `zzsh_supply.listing_version` → `zzsh_supply.guard_listing_commitments`
- `listing_content` ON `zzsh_supply.listing_version` → `zzsh_supply.guard_listing_content`
- `listing_version_publication` ON `zzsh_supply.listing_version` → `zzsh_supply.guard_listing_version_publication`
- `asset_account` ON `zzsh_supply.media_asset` → `zzsh_supply.guard_asset_account`
- `avatar_policy_asset_guard` ON `zzsh_supply.media_asset` → `zzsh_supply.guard_avatar_policy_asset`
- `media_asset_mutation_guard` ON `zzsh_supply.media_asset` → `zzsh_supply.guard_media_asset_mutation`
- `public_derivative` ON `zzsh_supply.media_asset` → `zzsh_supply.guard_public_derivative`
- `a_detail_parents` ON `zzsh_supply.price_line` → `zzsh_supply.guard_detail_parents`
- `price_line_compat_guard` ON `zzsh_supply.price_line` → `zzsh_supply.guard_compat_price_line`
- `price_line_mutation_guard` ON `zzsh_supply.price_line` → `zzsh_supply.guard_price_line_mutation`
- `a_version_identity` ON `zzsh_supply.price_version` → `zzsh_supply.guard_version_identity`
- `full_payout_price_reference_guard` ON `zzsh_supply.price_version` → `zzsh_supply.guard_full_payout_price_reference`
- `price_version_compat_guard` ON `zzsh_supply.price_version` → `zzsh_supply.guard_compat_price_version`
- `price_version_seal_guard` ON `zzsh_supply.price_version` → `zzsh_supply.guard_price_version_update`
- `profile_avatar_policy_guard` ON `zzsh_supply.profile_avatar_policy` → `zzsh_supply.guard_profile_avatar_policy`
- `account_public_number_guard` ON `zzsh_supply.rental_account` → `zzsh_supply.guard_account_public_number`
- `rental_identity` ON `zzsh_supply.rental_account` → `zzsh_supply.guard_rental_identity`
- `decision_immutable` ON `zzsh_supply.review_decision` → `zzsh_supply.guard_release_immutable`
- `listing_decision` ON `zzsh_supply.review_decision` → `zzsh_supply.guard_listing_decision`
- `acceptance_immutable` ON `zzsh_supply.rule_acceptance` → `zzsh_supply.guard_release_immutable`
- `full_payout_acceptance_guard` ON `zzsh_supply.rule_acceptance` → `zzsh_supply.guard_full_payout_acceptance`
- `legacy_takeover_authorization_guard` ON `zzsh_supply.rule_acceptance` → `zzsh_supply.guard_legacy_takeover_authorization`
- `listing_acceptance` ON `zzsh_supply.rule_acceptance` → `zzsh_supply.guard_listing_acceptance`
- `release_immutable` ON `zzsh_supply.rule_release` → `zzsh_supply.guard_release_immutable`
- `rule_release_insert_guard` ON `zzsh_supply.rule_release` → `zzsh_supply.guard_rule_release_insert`
- `skin_identity_write_guard` ON `zzsh_supply.skin` → `zzsh_supply.guard_skin_identity_write`
- `skin_category_tree_guard` ON `zzsh_supply.skin_category` → `zzsh_supply.guard_skin_category_tree`
- `a_detail_parents` ON `zzsh_supply.term_option` → `zzsh_supply.guard_detail_parents`
- `term_option_mutation_guard` ON `zzsh_supply.term_option` → `zzsh_supply.guard_term_option_mutation`
- `a_version_identity` ON `zzsh_supply.term_version` → `zzsh_supply.guard_version_identity`
- `term_version_seal_guard` ON `zzsh_supply.term_version` → `zzsh_supply.guard_sealed_term_version`
