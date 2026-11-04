-- 洲洲商行业务数据库新装基线：release_production_0153
-- 本段：约束、索引与触发器。保留唯一性、外键、资金守卫、时序及不可变约束；不关闭触发器或放宽表达式。
-- 来源：canonical前154份SQL至0153_stored_opening_cached_observations；已执行的旧SQL和journal不改写。
-- 账务*_cents为CNY整数分；比例、单价与旧源文本另依各自单位，不用浮点当账务真值。
-- UNKNOWN/null不是0；历史观察、当前应付责任、账务入账、银行到账是不同事实。
-- 保留来源类型、原键、冻结版本和不可变审计；不从流水求和重造原期初。
-- schema模块导览（以下仅注释，不改变SQL或跨域依赖顺序）：
--   zzsh_auth_user：用户密码、旧凭据及会话；不得混入管理员认证域
--   zzsh_auth_admin：管理员密码、TOTP与会话；认证密钥不进入本文件
--   zzsh_iam：权限、审批、身份与会员；历史事实不伪造成当前授权
--   zzsh_supply：游戏目录、账号、规则、媒体与发布；展示不代表可交易
--   zzsh_order：订单、责任与资金账本；历史付款标记不代表新渠道到账
--   zzsh_credit：信用与保证金；金额和资格由服务端合同核定
--   zzsh_content：内容和法律文书；正文版本与接受事实分别保留
-- 正式初始投影剥离纯本地模拟对象和已下线的布局表，写入中文对象COMMENT。

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: account account_providerId_accountId_key; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.account
    ADD CONSTRAINT "account_providerId_accountId_key" UNIQUE ("providerId", "accountId");


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: twoFactor twoFactor_pkey; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_phoneNumber_key; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."user"
    ADD CONSTRAINT "user_phoneNumber_key" UNIQUE ("phoneNumber");


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: user user_username_key; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."user"
    ADD CONSTRAINT user_username_key UNIQUE (username);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: account account_providerId_accountId_key; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.account
    ADD CONSTRAINT "account_providerId_accountId_key" UNIQUE ("providerId", "accountId");


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: twoFactor twoFactor_pkey; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_phoneNumber_key; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."user"
    ADD CONSTRAINT "user_phoneNumber_key" UNIQUE ("phoneNumber");


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: user user_username_key; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."user"
    ADD CONSTRAINT user_username_key UNIQUE (username);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: carousel_item carousel_item_pkey; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.carousel_item
    ADD CONSTRAINT carousel_item_pkey PRIMARY KEY (id);


--
-- Name: content_item content_item_pkey; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_item
    ADD CONSTRAINT content_item_pkey PRIMARY KEY (id);


--
-- Name: content_version content_version_item_sequence_unique; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_item_sequence_unique UNIQUE (item_id, sequence);


--
-- Name: content_version content_version_pkey; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_pkey PRIMARY KEY (id);


--
-- Name: document_acceptance document_acceptance_identity_unique; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.document_acceptance
    ADD CONSTRAINT document_acceptance_identity_unique UNIQUE (user_id, document_type, document_version_id, document_digest, subject_type, subject_id);


--
-- Name: document_acceptance document_acceptance_pkey; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.document_acceptance
    ADD CONSTRAINT document_acceptance_pkey PRIMARY KEY (id);


--
-- Name: legal_document_version legal_document_version_pkey; Type: CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.legal_document_version
    ADD CONSTRAINT legal_document_version_pkey PRIMARY KEY (id);


--
-- Name: credit_event credit_event_pkey; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_pkey PRIMARY KEY (id);


--
-- Name: credit_event credit_event_reversal_of_id_key; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_reversal_of_id_key UNIQUE (reversal_of_id);


--
-- Name: credit_event credit_event_user_id_event_key_key; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_user_id_event_key_key UNIQUE (user_id, event_key);


--
-- Name: credit_recovery_request credit_recovery_request_pkey; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_recovery_request
    ADD CONSTRAINT credit_recovery_request_pkey PRIMARY KEY (id);


--
-- Name: credit_recovery_request credit_recovery_request_user_id_request_key_key; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_recovery_request
    ADD CONSTRAINT credit_recovery_request_user_id_request_key_key UNIQUE (user_id, request_key);


--
-- Name: user_credit_state user_credit_state_pkey; Type: CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.user_credit_state
    ADD CONSTRAINT user_credit_state_pkey PRIMARY KEY (user_id);


--
-- Name: admin_auth_captcha_used admin_auth_captcha_used_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_auth_captcha_used
    ADD CONSTRAINT admin_auth_captcha_used_pkey PRIMARY KEY (signature);


--
-- Name: admin_auth_failure admin_auth_failure_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_auth_failure
    ADD CONSTRAINT admin_auth_failure_pkey PRIMARY KEY (id);


--
-- Name: admin_auth_lockout admin_auth_lockout_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_auth_lockout
    ADD CONSTRAINT admin_auth_lockout_pkey PRIMARY KEY (scope, subject);


--
-- Name: admin_backup_code_generation admin_backup_code_generation_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_backup_code_generation
    ADD CONSTRAINT admin_backup_code_generation_pkey PRIMARY KEY (admin_user_id);


--
-- Name: admin_permission admin_permission_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_permission
    ADD CONSTRAINT admin_permission_pkey PRIMARY KEY (code);


--
-- Name: admin_recovery_notification_target admin_recovery_notification_target_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_recovery_notification_target
    ADD CONSTRAINT admin_recovery_notification_target_pkey PRIMARY KEY (id);


--
-- Name: admin_recovery_request admin_recovery_request_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_recovery_request
    ADD CONSTRAINT admin_recovery_request_pkey PRIMARY KEY (id);


--
-- Name: admin_role admin_role_code_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_role
    ADD CONSTRAINT admin_role_code_key UNIQUE (code);


--
-- Name: admin_role_permission admin_role_permission_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_role_permission
    ADD CONSTRAINT admin_role_permission_pkey PRIMARY KEY (role_id, permission_code);


--
-- Name: admin_role admin_role_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_role
    ADD CONSTRAINT admin_role_pkey PRIMARY KEY (id);


--
-- Name: admin_security_command admin_security_command_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_security_command
    ADD CONSTRAINT admin_security_command_pkey PRIMARY KEY (admin_user_id, command_id);


--
-- Name: admin_security_notification_outbox admin_security_notification_outbox_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_security_notification_outbox
    ADD CONSTRAINT admin_security_notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: admin_security admin_security_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_security
    ADD CONSTRAINT admin_security_pkey PRIMARY KEY (admin_user_id);


--
-- Name: admin_user_permission admin_user_permission_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_permission
    ADD CONSTRAINT admin_user_permission_pkey PRIMARY KEY (admin_user_id, permission_code);


--
-- Name: admin_user_role admin_user_role_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_role
    ADD CONSTRAINT admin_user_role_pkey PRIMARY KEY (admin_user_id, role_id);


--
-- Name: approval_decision approval_decision_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_decision
    ADD CONSTRAINT approval_decision_pkey PRIMARY KEY (id);


--
-- Name: approval_decision approval_decision_request_id_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_decision
    ADD CONSTRAINT approval_decision_request_id_key UNIQUE (request_id);


--
-- Name: approval_execution approval_execution_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_execution
    ADD CONSTRAINT approval_execution_pkey PRIMARY KEY (id);


--
-- Name: approval_execution approval_execution_request_id_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_execution
    ADD CONSTRAINT approval_execution_request_id_key UNIQUE (request_id);


--
-- Name: approval_request_candidate approval_request_candidate_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request_candidate
    ADD CONSTRAINT approval_request_candidate_pkey PRIMARY KEY (request_id, admin_user_id);


--
-- Name: approval_request approval_request_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_pkey PRIMARY KEY (id);


--
-- Name: approval_template_candidate approval_template_candidate_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_template_candidate
    ADD CONSTRAINT approval_template_candidate_pkey PRIMARY KEY (template_id, admin_user_id);


--
-- Name: approval_template approval_template_operation_code_trigger_condition_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_template
    ADD CONSTRAINT approval_template_operation_code_trigger_condition_key UNIQUE (operation_code, trigger_condition);


--
-- Name: approval_template approval_template_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_template
    ADD CONSTRAINT approval_template_pkey PRIMARY KEY (id);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (id);


--
-- Name: im_aftersale_record im_aftersale_record_app_id_requester_user_id_operation_id_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_app_id_requester_user_id_operation_id_key UNIQUE (app_id, requester_user_id, operation_id);


--
-- Name: im_aftersale_record im_aftersale_record_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_pkey PRIMARY KEY (id);


--
-- Name: im_consultation_event im_consultation_event_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_event
    ADD CONSTRAINT im_consultation_event_pkey PRIMARY KEY (id);


--
-- Name: im_consultation im_consultation_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation
    ADD CONSTRAINT im_consultation_pkey PRIMARY KEY (id);


--
-- Name: im_consultation_scope_operation im_consultation_scope_operation_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_scope_operation
    ADD CONSTRAINT im_consultation_scope_operation_pkey PRIMARY KEY (id);


--
-- Name: im_consultation im_consultation_thread_round_unique; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation
    ADD CONSTRAINT im_consultation_thread_round_unique UNIQUE (thread_id, round_seq);


--
-- Name: im_identity_mapping im_identity_id_app_unique; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_identity_mapping
    ADD CONSTRAINT im_identity_id_app_unique UNIQUE (id, app_id);


--
-- Name: im_identity_mapping im_identity_mapping_account_unique; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_identity_mapping
    ADD CONSTRAINT im_identity_mapping_account_unique UNIQUE (provider, app_id, account_id);


--
-- Name: im_identity_mapping im_identity_mapping_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_identity_mapping
    ADD CONSTRAINT im_identity_mapping_pkey PRIMARY KEY (id);


--
-- Name: im_identity_mapping im_identity_mapping_platform_unique; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_identity_mapping
    ADD CONSTRAINT im_identity_mapping_platform_unique UNIQUE (provider, app_id, realm, identity_kind, platform_subject_id);


--
-- Name: im_read_copy_position im_read_copy_position_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_read_copy_position
    ADD CONSTRAINT im_read_copy_position_pkey PRIMARY KEY (app_id, team_id, account_id);


--
-- Name: im_read_copy_settings im_read_copy_settings_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_read_copy_settings
    ADD CONSTRAINT im_read_copy_settings_pkey PRIMARY KEY (app_id);


--
-- Name: im_support_handover im_support_handover_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_handover
    ADD CONSTRAINT im_support_handover_pkey PRIMARY KEY (id);


--
-- Name: im_support_presence im_support_presence_app_admin_unique; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_presence
    ADD CONSTRAINT im_support_presence_app_admin_unique UNIQUE (app_id, admin_user_id);


--
-- Name: im_support_presence_session im_support_presence_session_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_presence_session
    ADD CONSTRAINT im_support_presence_session_pkey PRIMARY KEY (id);


--
-- Name: im_support_round_rating im_support_round_rating_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_pkey PRIMARY KEY (id);


--
-- Name: im_support_round_rating im_support_round_rating_round_id_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_round_id_key UNIQUE (round_id);


--
-- Name: im_support_settings im_support_settings_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_settings
    ADD CONSTRAINT im_support_settings_pkey PRIMARY KEY (app_id);


--
-- Name: im_support_thread im_support_thread_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_thread
    ADD CONSTRAINT im_support_thread_pkey PRIMARY KEY (id);


--
-- Name: im_support_thread im_support_thread_round_identity; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_thread
    ADD CONSTRAINT im_support_thread_round_identity UNIQUE (id, app_id, user_id, kind);


--
-- Name: membership_entitlement membership_entitlement_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_entitlement
    ADD CONSTRAINT membership_entitlement_pkey PRIMARY KEY (id);


--
-- Name: membership_growth_contribution membership_growth_contribution_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_contribution
    ADD CONSTRAINT membership_growth_contribution_pkey PRIMARY KEY (id);


--
-- Name: membership_growth_contribution membership_growth_contribution_user_id_source_key_revision_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_contribution
    ADD CONSTRAINT membership_growth_contribution_user_id_source_key_revision_key UNIQUE (user_id, source_key, revision);


--
-- Name: membership_growth_legacy_coverage membership_growth_legacy_cove_subject_user_id_execution_key_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_coverage
    ADD CONSTRAINT membership_growth_legacy_cove_subject_user_id_execution_key_key UNIQUE (subject_user_id, execution_key);


--
-- Name: membership_growth_legacy_coverage membership_growth_legacy_covera_subject_user_id_fingerprint_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_coverage
    ADD CONSTRAINT membership_growth_legacy_covera_subject_user_id_fingerprint_key UNIQUE (subject_user_id, fingerprint);


--
-- Name: membership_growth_legacy_coverage membership_growth_legacy_coverage_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_coverage
    ADD CONSTRAINT membership_growth_legacy_coverage_pkey PRIMARY KEY (id);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admis_scope_key_execution_key_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admis_scope_key_execution_key_key UNIQUE (scope_key, execution_key);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admission_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admission_pkey PRIMARY KEY (coverage_id);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admission_success_audit_id_key; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admission_success_audit_id_key UNIQUE (success_audit_id);


--
-- Name: membership_growth_policy membership_growth_policy_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_policy
    ADD CONSTRAINT membership_growth_policy_pkey PRIMARY KEY (id);


--
-- Name: membership_growth_state membership_growth_state_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_state
    ADD CONSTRAINT membership_growth_state_pkey PRIMARY KEY (user_id);


--
-- Name: personal_finance_read_scope personal_finance_read_scope_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.personal_finance_read_scope
    ADD CONSTRAINT personal_finance_read_scope_pkey PRIMARY KEY (admin_user_id, scope_key);


--
-- Name: user_identity_display_source user_identity_display_source_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_display_source
    ADD CONSTRAINT user_identity_display_source_pkey PRIMARY KEY (user_id);


--
-- Name: user_identity_state user_identity_state_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_state
    ADD CONSTRAINT user_identity_state_pkey PRIMARY KEY (user_id);


--
-- Name: user_identity_subject user_identity_subject_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_subject
    ADD CONSTRAINT user_identity_subject_pkey PRIMARY KEY (user_id);


--
-- Name: user_identity_verification_attempt user_identity_verification_attempt_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_verification_attempt
    ADD CONSTRAINT user_identity_verification_attempt_pkey PRIMARY KEY (user_id, key_digest);


--
-- Name: user_identity_verified_profile user_identity_verified_profile_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_verified_profile
    ADD CONSTRAINT user_identity_verified_profile_pkey PRIMARY KEY (user_id);


--
-- Name: user_note user_note_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_note
    ADD CONSTRAINT user_note_pkey PRIMARY KEY (id);


--
-- Name: user_registration_fact user_registration_fact_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_registration_fact
    ADD CONSTRAINT user_registration_fact_pkey PRIMARY KEY (user_id);


--
-- Name: user_rental_membership user_rental_membership_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_rental_membership
    ADD CONSTRAINT user_rental_membership_pkey PRIMARY KEY (user_id);


--
-- Name: user_risk_flag user_risk_flag_pkey; Type: CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_risk_flag
    ADD CONSTRAINT user_risk_flag_pkey PRIMARY KEY (user_id);


--
-- Name: channel_refund_intent channel_refund_intent_payment_source_merchant_identity_id_r_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_payment_source_merchant_identity_id_r_key UNIQUE (payment_source, merchant_identity_id, refund_order_no);


--
-- Name: channel_refund_intent channel_refund_intent_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_pkey PRIMARY KEY (id);


--
-- Name: channel_refund_intent channel_refund_intent_posting_id_idempotency_key_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_posting_id_idempotency_key_key UNIQUE (posting_id, idempotency_key);


--
-- Name: channel_refund_observation channel_refund_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_observation
    ADD CONSTRAINT channel_refund_observation_pkey PRIMARY KEY (id);


--
-- Name: distribution_invite_code distribution_invite_code_match_code_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_invite_code
    ADD CONSTRAINT distribution_invite_code_match_code_key UNIQUE (match_code);


--
-- Name: distribution_invite_code distribution_invite_code_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_invite_code
    ADD CONSTRAINT distribution_invite_code_pkey PRIMARY KEY (id);


--
-- Name: distribution_invite_code distribution_invite_code_source_type_source_system_source_e_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_invite_code
    ADD CONSTRAINT distribution_invite_code_source_type_source_system_source_e_key UNIQUE (source_type, source_system, source_entity, source_id);


--
-- Name: distribution_order_admission distribution_order_admission_id_order_id_revision_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_id_order_id_revision_key UNIQUE (id, order_id, revision);


--
-- Name: distribution_order_admission distribution_order_admission_order_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_order_id_key UNIQUE (order_id);


--
-- Name: distribution_order_admission distribution_order_admission_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_pkey PRIMARY KEY (id);


--
-- Name: distribution_participant distribution_participant_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_participant
    ADD CONSTRAINT distribution_participant_pkey PRIMARY KEY (user_id);


--
-- Name: distribution_policy_head distribution_policy_head_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_head
    ADD CONSTRAINT distribution_policy_head_pkey PRIMARY KEY (scope);


--
-- Name: distribution_policy_version distribution_policy_version_id_scope_revision_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_version
    ADD CONSTRAINT distribution_policy_version_id_scope_revision_key UNIQUE (id, scope, revision);


--
-- Name: distribution_policy_version distribution_policy_version_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_version
    ADD CONSTRAINT distribution_policy_version_pkey PRIMARY KEY (id);


--
-- Name: distribution_policy_version distribution_policy_version_scope_revision_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_version
    ADD CONSTRAINT distribution_policy_version_scope_revision_key UNIQUE (scope, revision);


--
-- Name: finance_covered_event finance_covered_event_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_covered_event
    ADD CONSTRAINT finance_covered_event_pkey PRIMARY KEY (user_id, source_kind, source_type, source_entity, source_id, beneficiary_role);


--
-- Name: finance_economic_root finance_economic_root_basis_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_economic_root
    ADD CONSTRAINT finance_economic_root_basis_id_key UNIQUE (basis_id);


--
-- Name: finance_economic_root finance_economic_root_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_economic_root
    ADD CONSTRAINT finance_economic_root_pkey PRIMARY KEY (id);


--
-- Name: finance_economic_root finance_economic_root_source_kind_source_type_source_system_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_economic_root
    ADD CONSTRAINT finance_economic_root_source_kind_source_type_source_system_key UNIQUE (source_kind, source_type, source_system, source_entity, source_id, subject_user_id, beneficiary_role);


--
-- Name: finance_event finance_event_economic_root_id_kind_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_event
    ADD CONSTRAINT finance_event_economic_root_id_kind_key UNIQUE (economic_root_id, kind);


--
-- Name: settlement_ledger_entry finance_event_line_once; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT finance_event_line_once UNIQUE (finance_event_id, line_no);


--
-- Name: finance_event finance_event_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_event
    ADD CONSTRAINT finance_event_pkey PRIMARY KEY (id);


--
-- Name: finance_observation_admission finance_observation_admission_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_observation_admission
    ADD CONSTRAINT finance_observation_admission_pkey PRIMARY KEY (basis_id, source_entity, source_id);


--
-- Name: finance_opening_basis finance_opening_basis_id_user_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_opening_basis
    ADD CONSTRAINT finance_opening_basis_id_user_id_key UNIQUE (id, user_id);


--
-- Name: finance_opening_basis finance_opening_basis_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_opening_basis
    ADD CONSTRAINT finance_opening_basis_pkey PRIMARY KEY (id);


--
-- Name: finance_opening_basis finance_opening_basis_source_system_source_entity_source_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_opening_basis
    ADD CONSTRAINT finance_opening_basis_source_system_source_entity_source_id_key UNIQUE (source_system, source_entity, source_id);


--
-- Name: finance_stored_opening_review finance_stored_opening_review_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_stored_opening_review
    ADD CONSTRAINT finance_stored_opening_review_pkey PRIMARY KEY (basis_id);


--
-- Name: im_order_activity im_order_activity_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_activity
    ADD CONSTRAINT im_order_activity_pkey PRIMARY KEY (order_id);


--
-- Name: im_order_due_reminder im_order_due_reminder_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_due_reminder
    ADD CONSTRAINT im_order_due_reminder_pkey PRIMARY KEY (id);


--
-- Name: im_order_due_reminder im_order_due_reminder_unique; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_due_reminder
    ADD CONSTRAINT im_order_due_reminder_unique UNIQUE (order_id, app_id, bucket);


--
-- Name: im_order_event im_order_event_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_event
    ADD CONSTRAINT im_order_event_pkey PRIMARY KEY (id);


--
-- Name: im_order_group im_order_group_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_group_pkey PRIMARY KEY (order_id);


--
-- Name: im_order_group im_order_id_app_unique; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_id_app_unique UNIQUE (order_id, app_id);


--
-- Name: im_order_member im_order_member_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_member
    ADD CONSTRAINT im_order_member_pkey PRIMARY KEY (order_id, identity_id);


--
-- Name: im_order_operation im_order_operation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_operation
    ADD CONSTRAINT im_order_operation_pkey PRIMARY KEY (id);


--
-- Name: im_order_stage_card im_order_stage_card_card_id_unique; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_stage_card
    ADD CONSTRAINT im_order_stage_card_card_id_unique UNIQUE (card_id);


--
-- Name: im_order_stage_card im_order_stage_card_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_stage_card
    ADD CONSTRAINT im_order_stage_card_pkey PRIMARY KEY (id);


--
-- Name: im_order_stage_card im_order_stage_card_unique; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_stage_card
    ADD CONSTRAINT im_order_stage_card_unique UNIQUE (order_id, app_id, kind);


--
-- Name: im_order_unread im_order_unread_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_unread
    ADD CONSTRAINT im_order_unread_pkey PRIMARY KEY (order_id, identity_id);


--
-- Name: invitation_relation invitation_relation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.invitation_relation
    ADD CONSTRAINT invitation_relation_pkey PRIMARY KEY (id);


--
-- Name: invitation_relation invitation_relation_type_child_user_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.invitation_relation
    ADD CONSTRAINT invitation_relation_type_child_user_id_key UNIQUE (type, child_user_id);


--
-- Name: joinpay_account_observation joinpay_account_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_account_observation
    ADD CONSTRAINT joinpay_account_observation_pkey PRIMARY KEY (attempt_id);


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_id_request_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_attempt
    ADD CONSTRAINT joinpay_collection_attempt_id_request_id_key UNIQUE (id, request_id);


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_attempt
    ADD CONSTRAINT joinpay_collection_attempt_pkey PRIMARY KEY (id);


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_request_id_lease_version_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_attempt
    ADD CONSTRAINT joinpay_collection_attempt_request_id_lease_version_key UNIQUE (request_id, lease_version);


--
-- Name: joinpay_collection_binding joinpay_collection_binding_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_binding
    ADD CONSTRAINT joinpay_collection_binding_pkey PRIMARY KEY (request_id);


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_id_request_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_evidence
    ADD CONSTRAINT joinpay_collection_evidence_id_request_id_key UNIQUE (id, request_id);


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_evidence
    ADD CONSTRAINT joinpay_collection_evidence_pkey PRIMARY KEY (id);


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_request_id_operation_raw_sha256_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_evidence
    ADD CONSTRAINT joinpay_collection_evidence_request_id_operation_raw_sha256_key UNIQUE (request_id, operation, raw_sha256, profile_sha256, key_version_ref);


--
-- Name: joinpay_collection_observation joinpay_collection_observation_attempt_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_observation
    ADD CONSTRAINT joinpay_collection_observation_attempt_id_key UNIQUE (attempt_id);


--
-- Name: joinpay_collection_observation joinpay_collection_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_observation
    ADD CONSTRAINT joinpay_collection_observation_pkey PRIMARY KEY (id);


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_attempt
    ADD CONSTRAINT joinpay_payout_attempt_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_intent_id_lease_version_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_attempt
    ADD CONSTRAINT joinpay_payout_attempt_intent_id_lease_version_key UNIQUE (intent_id, lease_version);


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_attempt
    ADD CONSTRAINT joinpay_payout_attempt_pkey PRIMARY KEY (id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_intent_id_key UNIQUE (intent_id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_observation_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_observation_id_key UNIQUE (observation_id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_pkey PRIMARY KEY (id);


--
-- Name: joinpay_payout_observation joinpay_payout_observation_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_observation
    ADD CONSTRAINT joinpay_payout_observation_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_payout_observation joinpay_payout_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_observation
    ADD CONSTRAINT joinpay_payout_observation_pkey PRIMARY KEY (id);


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_attempt
    ADD CONSTRAINT joinpay_refund_attempt_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_intent_id_lease_version_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_attempt
    ADD CONSTRAINT joinpay_refund_attempt_intent_id_lease_version_key UNIQUE (intent_id, lease_version);


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_attempt
    ADD CONSTRAINT joinpay_refund_attempt_pkey PRIMARY KEY (id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_intent_id_key UNIQUE (intent_id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_observation_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_observation_id_key UNIQUE (observation_id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_pkey PRIMARY KEY (id);


--
-- Name: joinpay_refund_observation joinpay_refund_observation_id_intent_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_observation
    ADD CONSTRAINT joinpay_refund_observation_id_intent_id_key UNIQUE (id, intent_id);


--
-- Name: joinpay_refund_observation joinpay_refund_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_observation
    ADD CONSTRAINT joinpay_refund_observation_pkey PRIMARY KEY (id);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_economic_root_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_economic_root_id_key UNIQUE (economic_root_id);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_id_user_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_id_user_id_key UNIQUE (id, user_id);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_merchant_identity_id_merchant_ord_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_merchant_identity_id_merchant_ord_key UNIQUE (merchant_identity_id, merchant_order_no);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_payout_key_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_payout_key_key UNIQUE (payout_key);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_pkey PRIMARY KEY (id);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_reserve_event_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_reserve_event_id_key UNIQUE (reserve_event_id);


--
-- Name: legacy_continuation_evidence legacy_continuation_evidence_derived_from_command_version_i_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_continuation_evidence_derived_from_command_version_i_key UNIQUE (derived_from_command_version_id);


--
-- Name: legacy_continuation_evidence legacy_continuation_evidence_order_id_evidence_version_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_continuation_evidence_order_id_evidence_version_key UNIQUE (order_id, evidence_version);


--
-- Name: legacy_continuation_evidence legacy_continuation_evidence_order_id_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_continuation_evidence_order_id_id_key UNIQUE (order_id, id);


--
-- Name: legacy_continuation_evidence legacy_continuation_evidence_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_continuation_evidence_pkey PRIMARY KEY (id);


--
-- Name: legacy_continuation_version legacy_continuation_version_order_id_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_order_id_id_key UNIQUE (order_id, id);


--
-- Name: legacy_continuation_version legacy_continuation_version_order_id_revision_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_order_id_revision_key UNIQUE (order_id, revision);


--
-- Name: legacy_continuation_version legacy_continuation_version_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_pkey PRIMARY KEY (id);


--
-- Name: legacy_continuation_version legacy_continuation_version_result_evidence_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_result_evidence_id_key UNIQUE (result_evidence_id);


--
-- Name: legacy_duty_finance_contract legacy_duty_finance_contract_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_contract
    ADD CONSTRAINT legacy_duty_finance_contract_pkey PRIMARY KEY (singleton);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_event_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_event_id_key UNIQUE (event_id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_pkey PRIMARY KEY (duty_id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_root_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_root_id_key UNIQUE (root_id);


--
-- Name: legacy_inflight_register legacy_inflight_register_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_pkey PRIMARY KEY (id);


--
-- Name: legacy_inflight_register legacy_inflight_register_source_system_source_entity_legacy_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_source_system_source_entity_legacy_key UNIQUE (source_system, source_entity, legacy_id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_duty_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_duty_id_key UNIQUE (duty_id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_order_id_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_order_id_id_key UNIQUE (order_id, id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_order_id_kind_source_record_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_order_id_kind_source_record_id_key UNIQUE (order_id, kind, source_record_id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_pkey PRIMARY KEY (id);


--
-- Name: legacy_order_duty legacy_order_duty_order_id_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_order_id_id_key UNIQUE (order_id, id);


--
-- Name: legacy_order_duty legacy_order_duty_order_id_kind_source_record_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_order_id_kind_source_record_id_key UNIQUE (order_id, kind, source_record_id);


--
-- Name: legacy_order_duty legacy_order_duty_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_pkey PRIMARY KEY (id);


--
-- Name: legacy_order_duty_revision legacy_order_duty_revision_duty_id_revision_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_revision
    ADD CONSTRAINT legacy_order_duty_revision_duty_id_revision_key UNIQUE (duty_id, revision);


--
-- Name: legacy_order_duty_revision legacy_order_duty_revision_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_revision
    ADD CONSTRAINT legacy_order_duty_revision_pkey PRIMARY KEY (id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_pkey PRIMARY KEY (id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_source_system_source_entity_lega_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_source_system_source_entity_lega_key UNIQUE (source_system, source_entity, legacy_id);


--
-- Name: legacy_owner_guarantee_coverage legacy_owner_guarantee_coverage_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_coverage
    ADD CONSTRAINT legacy_owner_guarantee_coverage_pkey PRIMARY KEY (id);


--
-- Name: legacy_owner_guarantee_coverage legacy_owner_guarantee_coverage_user_id_source_cutoff_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_coverage
    ADD CONSTRAINT legacy_owner_guarantee_coverage_user_id_source_cutoff_key UNIQUE (user_id, source_cutoff);


--
-- Name: legacy_owner_guarantee_observation legacy_owner_guarantee_observ_user_id_legacy_account_id_sou_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_observation
    ADD CONSTRAINT legacy_owner_guarantee_observ_user_id_legacy_account_id_sou_key UNIQUE (user_id, legacy_account_id, source_cutoff);


--
-- Name: legacy_owner_guarantee_observation legacy_owner_guarantee_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_observation
    ADD CONSTRAINT legacy_owner_guarantee_observation_pkey PRIMARY KEY (id);


--
-- Name: native_origin_resource_admission native_origin_resource_admission_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.native_origin_resource_admission
    ADD CONSTRAINT native_origin_resource_admission_pkey PRIMARY KEY (resource_oid);


--
-- Name: native_user_insert_proof native_user_insert_proof_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.native_user_insert_proof
    ADD CONSTRAINT native_user_insert_proof_pkey PRIMARY KEY (user_id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_merchant_order_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_merchant_order_no_key UNIQUE (merchant_order_no);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_pkey PRIMARY KEY (id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_provider_provider_transaction_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_provider_provider_transaction_id_key UNIQUE (provider, provider_transaction_id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_requirement_id_request_key_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_requirement_id_request_key_key UNIQUE (requirement_id, request_key);


--
-- Name: owner_guarantee_reconciliation owner_guarantee_reconciliation_payment_id_payload_digest_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_reconciliation
    ADD CONSTRAINT owner_guarantee_reconciliation_payment_id_payload_digest_key UNIQUE (payment_id, payload_digest);


--
-- Name: owner_guarantee_reconciliation owner_guarantee_reconciliation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_reconciliation
    ADD CONSTRAINT owner_guarantee_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: owner_guarantee_reconciliation owner_guarantee_reconciliation_refund_id_payload_digest_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_reconciliation
    ADD CONSTRAINT owner_guarantee_reconciliation_refund_id_payload_digest_key UNIQUE (refund_id, payload_digest);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_pkey PRIMARY KEY (id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_provider_provider_refund_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_provider_provider_refund_id_key UNIQUE (provider, provider_refund_id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_requirement_id_request_key_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_requirement_id_request_key_key UNIQUE (requirement_id, request_key);


--
-- Name: owner_guarantee_requirement owner_guarantee_requirement_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_requirement
    ADD CONSTRAINT owner_guarantee_requirement_pkey PRIMARY KEY (id);


--
-- Name: payment_channel_observation payment_channel_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_observation
    ADD CONSTRAINT payment_channel_observation_pkey PRIMARY KEY (id);


--
-- Name: payment_channel_transaction payment_channel_transaction_channel_merchant_identity_id_ch_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_transaction
    ADD CONSTRAINT payment_channel_transaction_channel_merchant_identity_id_ch_key UNIQUE (channel, merchant_identity_id, channel_trx_no);


--
-- Name: payment_channel_transaction payment_channel_transaction_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_transaction
    ADD CONSTRAINT payment_channel_transaction_pkey PRIMARY KEY (id);


--
-- Name: payment_confirmation payment_confirmation_order_id_id_disposition_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_order_id_id_disposition_key UNIQUE (order_id, id, disposition);


--
-- Name: payment_confirmation payment_confirmation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_pkey PRIMARY KEY (id);


--
-- Name: payment_confirmation payment_confirmation_source_merchant_scope_id_provider_tran_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_source_merchant_scope_id_provider_tran_key UNIQUE (source, merchant_scope_id, provider_transaction_id);


--
-- Name: payment_distribution_basis payment_distribution_basis_order_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_order_id_key UNIQUE (order_id);


--
-- Name: payment_distribution_basis payment_distribution_basis_payment_confirmation_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_payment_confirmation_id_key UNIQUE (payment_confirmation_id);


--
-- Name: payment_distribution_basis payment_distribution_basis_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_pkey PRIMARY KEY (id);


--
-- Name: payment_request payment_request_channel_merchant_identity_id_channel_order__key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_request
    ADD CONSTRAINT payment_request_channel_merchant_identity_id_channel_order__key UNIQUE (channel, merchant_identity_id, channel_order_no);


--
-- Name: payment_request payment_request_id_order_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_request
    ADD CONSTRAINT payment_request_id_order_id_key UNIQUE (id, order_id);


--
-- Name: payment_request payment_request_order_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_request
    ADD CONSTRAINT payment_request_order_id_key UNIQUE (order_id);


--
-- Name: payment_request payment_request_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_request
    ADD CONSTRAINT payment_request_pkey PRIMARY KEY (id);


--
-- Name: personal_finance_observation_coverage personal_finance_observation__user_id_source_kind_source_sy_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation_coverage
    ADD CONSTRAINT personal_finance_observation__user_id_source_kind_source_sy_key UNIQUE (user_id, source_kind, source_system, source_cutoff);


--
-- Name: personal_finance_observation_coverage personal_finance_observation_coverage_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation_coverage
    ADD CONSTRAINT personal_finance_observation_coverage_pkey PRIMARY KEY (id);


--
-- Name: personal_finance_observation personal_finance_observation_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation
    ADD CONSTRAINT personal_finance_observation_pkey PRIMARY KEY (id);


--
-- Name: personal_finance_observation personal_finance_observation_source_type_source_system_sour_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation
    ADD CONSTRAINT personal_finance_observation_source_type_source_system_sour_key UNIQUE (source_type, source_system, source_entity, source_id);


--
-- Name: prestart_termination_decision prestart_termination_decision_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination_decision
    ADD CONSTRAINT prestart_termination_decision_pkey PRIMARY KEY (id);


--
-- Name: prestart_termination_decision prestart_termination_decision_termination_id_result_revisio_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination_decision
    ADD CONSTRAINT prestart_termination_decision_termination_id_result_revisio_key UNIQUE (termination_id, result_revision);


--
-- Name: prestart_termination prestart_termination_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_pkey PRIMARY KEY (id);


--
-- Name: rental_opening_ack rental_opening_ack_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening_ack
    ADD CONSTRAINT rental_opening_ack_pkey PRIMARY KEY (opening_id, party);


--
-- Name: rental_opening rental_opening_order_id_version_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening
    ADD CONSTRAINT rental_opening_order_id_version_no_key UNIQUE (order_id, version_no);


--
-- Name: rental_opening rental_opening_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening
    ADD CONSTRAINT rental_opening_pkey PRIMARY KEY (id);


--
-- Name: rental_order rental_order_confirmation_unique; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_confirmation_unique UNIQUE (confirmation_id);


--
-- Name: rental_order rental_order_display_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_display_no_key UNIQUE (display_no);


--
-- Name: rental_order rental_order_payment_pair; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_payment_pair UNIQUE (id, paid_confirmation_id);


--
-- Name: rental_order rental_order_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_pkey PRIMARY KEY (id);


--
-- Name: rental_referral_earning rental_referral_earning_economic_key_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_economic_key_key UNIQUE (economic_key);


--
-- Name: rental_referral_earning rental_referral_earning_economic_root_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_economic_root_id_key UNIQUE (economic_root_id);


--
-- Name: rental_referral_earning rental_referral_earning_order_id_beneficiary_user_id_benefi_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_order_id_beneficiary_user_id_benefi_key UNIQUE (order_id, beneficiary_user_id, beneficiary_role);


--
-- Name: rental_referral_earning rental_referral_earning_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_pkey PRIMARY KEY (id);


--
-- Name: rental_referral_reversal_source rental_referral_reversal_source_earning_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_reversal_source
    ADD CONSTRAINT rental_referral_reversal_source_earning_id_key UNIQUE (earning_id);


--
-- Name: rental_referral_reversal_source rental_referral_reversal_source_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_reversal_source
    ADD CONSTRAINT rental_referral_reversal_source_pkey PRIMARY KEY (id);


--
-- Name: rental_referral_transition rental_referral_transition_earning_id_action_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_earning_id_action_key UNIQUE (earning_id, action);


--
-- Name: rental_referral_transition rental_referral_transition_finance_event_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_finance_event_id_key UNIQUE (finance_event_id);


--
-- Name: rental_referral_transition rental_referral_transition_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_pkey PRIMARY KEY (id);


--
-- Name: settlement_decision settlement_decision_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_decision
    ADD CONSTRAINT settlement_decision_pkey PRIMARY KEY (id);


--
-- Name: settlement_decision settlement_decision_settlement_version_id_party_action_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_decision
    ADD CONSTRAINT settlement_decision_settlement_version_id_party_action_key UNIQUE (settlement_version_id, party, action);


--
-- Name: settlement_intake settlement_intake_order_id_version_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_intake
    ADD CONSTRAINT settlement_intake_order_id_version_no_key UNIQUE (order_id, version_no);


--
-- Name: settlement_intake settlement_intake_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_intake
    ADD CONSTRAINT settlement_intake_pkey PRIMARY KEY (id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_pkey PRIMARY KEY (id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_posting_id_line_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_posting_id_line_no_key UNIQUE (posting_id, line_no);


--
-- Name: settlement_posting settlement_posting_order_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_order_id_key UNIQUE (order_id);


--
-- Name: settlement_posting settlement_posting_payment_confirmation_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_payment_confirmation_id_key UNIQUE (payment_confirmation_id);


--
-- Name: settlement_posting settlement_posting_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_pkey PRIMARY KEY (id);


--
-- Name: settlement_posting settlement_posting_settlement_version_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_settlement_version_id_key UNIQUE (settlement_version_id);


--
-- Name: settlement_version settlement_version_approval_request_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_approval_request_id_key UNIQUE (approval_request_id);


--
-- Name: settlement_version settlement_version_order_id_version_no_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_order_id_version_no_key UNIQUE (order_id, version_no);


--
-- Name: settlement_version settlement_version_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_pkey PRIMARY KEY (id);


--
-- Name: wallet_coverage wallet_coverage_basis_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_basis_id_key UNIQUE (basis_id);


--
-- Name: wallet_coverage wallet_coverage_opening_event_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_opening_event_id_key UNIQUE (opening_event_id);


--
-- Name: wallet_coverage wallet_coverage_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_pkey PRIMARY KEY (user_id);


--
-- Name: wallet_revision wallet_revision_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_revision
    ADD CONSTRAINT wallet_revision_pkey PRIMARY KEY (user_id);


--
-- Name: withdrawal_bank_binding withdrawal_bank_binding_pkey; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.withdrawal_bank_binding
    ADD CONSTRAINT withdrawal_bank_binding_pkey PRIMARY KEY (id);


--
-- Name: withdrawal_bank_binding withdrawal_bank_binding_user_id_key; Type: CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.withdrawal_bank_binding
    ADD CONSTRAINT withdrawal_bank_binding_user_id_key UNIQUE (user_id);


--
-- Name: account_display_no_counter account_display_no_counter_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_display_no_counter
    ADD CONSTRAINT account_display_no_counter_pkey PRIMARY KEY (business_date);


--
-- Name: account_guarantee_proof account_guarantee_proof_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_pkey PRIMARY KEY (id);


--
-- Name: account_guarantee_proof account_guarantee_proof_version_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_version_unique UNIQUE (account_id, version_no);


--
-- Name: admin_supply_scope admin_supply_scope_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.admin_supply_scope
    ADD CONSTRAINT admin_supply_scope_pkey PRIMARY KEY (admin_user_id, game_id);


--
-- Name: agreement_version agreement_version_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.agreement_version
    ADD CONSTRAINT agreement_version_pkey PRIMARY KEY (id);


--
-- Name: media_asset asset_account_required; Type: CHECK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE zzsh_supply.media_asset
    ADD CONSTRAINT asset_account_required CHECK (((ownership_kind <> 'USER_SUPPLY'::text) OR (account_id IS NOT NULL))) NOT VALID;


--
-- Name: billable_item billable_item_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.billable_item
    ADD CONSTRAINT billable_item_game_code_unique UNIQUE (game_id, code);


--
-- Name: billable_item billable_item_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.billable_item
    ADD CONSTRAINT billable_item_pkey PRIMARY KEY (id);


--
-- Name: duplicate_hint duplicate_hint_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.duplicate_hint
    ADD CONSTRAINT duplicate_hint_pkey PRIMARY KEY (id);


--
-- Name: entitlement entitlement_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.entitlement
    ADD CONSTRAINT entitlement_game_code_unique UNIQUE (game_id, code);


--
-- Name: entitlement entitlement_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.entitlement
    ADD CONSTRAINT entitlement_pkey PRIMARY KEY (id);


--
-- Name: favorite favorite_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.favorite
    ADD CONSTRAINT favorite_pkey PRIMARY KEY (user_id, account_id);


--
-- Name: firearm_alias firearm_alias_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_pkey PRIMARY KEY (id);


--
-- Name: firearm_alias firearm_alias_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_unique UNIQUE (game_id, firearm_id, locale, name);


--
-- Name: firearm_classification firearm_classification_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_game_code_unique UNIQUE (game_id, code);


--
-- Name: firearm_classification firearm_classification_game_id_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_game_id_unique UNIQUE (game_id, id);


--
-- Name: firearm_classification firearm_classification_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_pkey PRIMARY KEY (id);


--
-- Name: firearm firearm_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_game_code_unique UNIQUE (game_id, code);


--
-- Name: firearm firearm_game_id_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_game_id_unique UNIQUE (game_id, id);


--
-- Name: firearm firearm_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_pkey PRIMARY KEY (id);


--
-- Name: full_payout_terms_version full_payout_terms_version_game_id_policy_ref_policy_version_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.full_payout_terms_version
    ADD CONSTRAINT full_payout_terms_version_game_id_policy_ref_policy_version_key UNIQUE (game_id, policy_ref, policy_version);


--
-- Name: full_payout_terms_version full_payout_terms_version_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.full_payout_terms_version
    ADD CONSTRAINT full_payout_terms_version_pkey PRIMARY KEY (id);


--
-- Name: game game_code_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game
    ADD CONSTRAINT game_code_key UNIQUE (code);


--
-- Name: game game_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game
    ADD CONSTRAINT game_pkey PRIMARY KEY (id);


--
-- Name: game_service_operation game_service_operation_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game_service_operation
    ADD CONSTRAINT game_service_operation_pkey PRIMARY KEY (id);


--
-- Name: game_service_operation game_service_operation_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game_service_operation
    ADD CONSTRAINT game_service_operation_unique UNIQUE (game_id, service_code);


--
-- Name: gunsmith_code gunsmith_code_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.gunsmith_code
    ADD CONSTRAINT gunsmith_code_pkey PRIMARY KEY (id);


--
-- Name: idempotency_record idempotency_record_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.idempotency_record
    ADD CONSTRAINT idempotency_record_pkey PRIMARY KEY (scope_key, key);


--
-- Name: inventory_line inventory_line_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.inventory_line
    ADD CONSTRAINT inventory_line_pkey PRIMARY KEY (version_id, item_id);


--
-- Name: legacy_listing_display_snapshot legacy_listing_display_snapshot_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_display_snapshot
    ADD CONSTRAINT legacy_listing_display_snapshot_pkey PRIMARY KEY (account_id, schema_version);


--
-- Name: legacy_listing_read_snapshot legacy_listing_read_snapshot_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_read_snapshot
    ADD CONSTRAINT legacy_listing_read_snapshot_pkey PRIMARY KEY (account_id);


--
-- Name: legacy_skin_holding legacy_skin_holding_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_skin_holding
    ADD CONSTRAINT legacy_skin_holding_pkey PRIMARY KEY (account_id);


--
-- Name: legacy_supply_map legacy_supply_map_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_supply_map
    ADD CONSTRAINT legacy_supply_map_pkey PRIMARY KEY (source_system, source_entity, legacy_id);


--
-- Name: listing_entitlement listing_entitlement_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_entitlement
    ADD CONSTRAINT listing_entitlement_pkey PRIMARY KEY (version_id, entitlement_id);


--
-- Name: listing_filter_config listing_filter_config_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_filter_config
    ADD CONSTRAINT listing_filter_config_pkey PRIMARY KEY (game_id, revision);


--
-- Name: listing_media listing_media_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_media
    ADD CONSTRAINT listing_media_pkey PRIMARY KEY (version_id, asset_id);


--
-- Name: listing_media listing_media_version_id_position_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_media
    ADD CONSTRAINT listing_media_version_id_position_key UNIQUE (version_id, "position");


--
-- Name: listing_publication listing_publication_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_pkey PRIMARY KEY (id);


--
-- Name: listing_publication listing_publication_version_id_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_version_id_key UNIQUE (version_id);


--
-- Name: listing_skin listing_skin_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_skin
    ADD CONSTRAINT listing_skin_pkey PRIMARY KEY (version_id, skin_id);


--
-- Name: listing_version listing_version_account_id_sequence_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_version
    ADD CONSTRAINT listing_version_account_id_sequence_key UNIQUE (account_id, sequence);


--
-- Name: listing_version listing_version_id_account_id_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_version
    ADD CONSTRAINT listing_version_id_account_id_key UNIQUE (id, account_id);


--
-- Name: listing_version listing_version_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_version
    ADD CONSTRAINT listing_version_pkey PRIMARY KEY (id);


--
-- Name: media_asset media_asset_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_pkey PRIMARY KEY (id);


--
-- Name: media_upload_intent media_upload_intent_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_pkey PRIMARY KEY (id);


--
-- Name: media_upload_intent media_upload_intent_token_hash_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_token_hash_key UNIQUE (token_hash);


--
-- Name: price_line price_line_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_line
    ADD CONSTRAINT price_line_pkey PRIMARY KEY (id);


--
-- Name: price_line price_line_version_item_tier_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_line
    ADD CONSTRAINT price_line_version_item_tier_unique UNIQUE (price_version_id, item_id, customer_tier);


--
-- Name: price_version price_version_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_version
    ADD CONSTRAINT price_version_pkey PRIMARY KEY (id);


--
-- Name: profile_avatar profile_avatar_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar
    ADD CONSTRAINT profile_avatar_pkey PRIMARY KEY (realm, subject_id);


--
-- Name: profile_avatar_policy profile_avatar_policy_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar_policy
    ADD CONSTRAINT profile_avatar_policy_pkey PRIMARY KEY (singleton);


--
-- Name: rental_account rental_account_owner_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rental_account
    ADD CONSTRAINT rental_account_owner_unique UNIQUE (id, owner_user_id);


--
-- Name: rental_account rental_account_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rental_account
    ADD CONSTRAINT rental_account_pkey PRIMARY KEY (id);


--
-- Name: review_decision review_decision_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.review_decision
    ADD CONSTRAINT review_decision_pkey PRIMARY KEY (id);


--
-- Name: review_decision review_decision_version_id_key; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.review_decision
    ADD CONSTRAINT review_decision_version_id_key UNIQUE (version_id);


--
-- Name: rule_acceptance rule_acceptance_identity_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_identity_unique UNIQUE (owner_user_id, listing_version_id, rule_release_id, accepted_content_hash);


--
-- Name: rule_acceptance rule_acceptance_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_pkey PRIMARY KEY (id);


--
-- Name: rule_release rule_release_game_generation_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_game_generation_unique UNIQUE (game_id, generation);


--
-- Name: rule_release rule_release_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_pkey PRIMARY KEY (id);


--
-- Name: skin_category skin_category_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_category
    ADD CONSTRAINT skin_category_game_code_unique UNIQUE (game_id, code);


--
-- Name: skin_category skin_category_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_category
    ADD CONSTRAINT skin_category_pkey PRIMARY KEY (id);


--
-- Name: skin skin_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_game_code_unique UNIQUE (game_id, code);


--
-- Name: skin_owner skin_owner_game_kind_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_owner
    ADD CONSTRAINT skin_owner_game_kind_code_unique UNIQUE (game_id, kind, code);


--
-- Name: skin_owner skin_owner_game_kind_id_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_owner
    ADD CONSTRAINT skin_owner_game_kind_id_unique UNIQUE (game_id, kind, id);


--
-- Name: skin_owner skin_owner_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_owner
    ADD CONSTRAINT skin_owner_pkey PRIMARY KEY (id);


--
-- Name: skin skin_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_pkey PRIMARY KEY (id);


--
-- Name: skin_rarity skin_rarity_game_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_rarity
    ADD CONSTRAINT skin_rarity_game_code_unique UNIQUE (game_id, code);


--
-- Name: skin_rarity skin_rarity_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_rarity
    ADD CONSTRAINT skin_rarity_pkey PRIMARY KEY (id);


--
-- Name: term_option term_option_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_option
    ADD CONSTRAINT term_option_pkey PRIMARY KEY (id);


--
-- Name: term_option term_option_version_code_unique; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_option
    ADD CONSTRAINT term_option_version_code_unique UNIQUE (version_id, code);


--
-- Name: term_version term_version_pkey; Type: CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_version
    ADD CONSTRAINT term_version_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX "account_userId_idx" ON zzsh_auth_admin.account USING btree ("userId");


--
-- Name: admin_account_user_id_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX admin_account_user_id_idx ON zzsh_auth_admin.account USING btree ("userId");


--
-- Name: admin_session_user_id_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX admin_session_user_id_idx ON zzsh_auth_admin.session USING btree ("userId");


--
-- Name: admin_two_factor_secret_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX admin_two_factor_secret_idx ON zzsh_auth_admin."twoFactor" USING btree (secret);


--
-- Name: admin_two_factor_user_id_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX admin_two_factor_user_id_idx ON zzsh_auth_admin."twoFactor" USING btree ("userId");


--
-- Name: admin_verification_identifier_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX admin_verification_identifier_idx ON zzsh_auth_admin.verification USING btree (identifier);


--
-- Name: session_userId_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX "session_userId_idx" ON zzsh_auth_admin.session USING btree ("userId");


--
-- Name: twoFactor_secret_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX "twoFactor_secret_idx" ON zzsh_auth_admin."twoFactor" USING btree (secret);


--
-- Name: twoFactor_userId_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX "twoFactor_userId_idx" ON zzsh_auth_admin."twoFactor" USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: zzsh_auth_admin; Owner: -
--

CREATE INDEX verification_identifier_idx ON zzsh_auth_admin.verification USING btree (identifier);


--
-- Name: user_account_user_id_idx; Type: INDEX; Schema: zzsh_auth_user; Owner: -
--

CREATE INDEX user_account_user_id_idx ON zzsh_auth_user.account USING btree ("userId");


--
-- Name: user_session_user_id_idx; Type: INDEX; Schema: zzsh_auth_user; Owner: -
--

CREATE INDEX user_session_user_id_idx ON zzsh_auth_user.session USING btree ("userId");


--
-- Name: user_two_factor_secret_idx; Type: INDEX; Schema: zzsh_auth_user; Owner: -
--

CREATE INDEX user_two_factor_secret_idx ON zzsh_auth_user."twoFactor" USING btree (secret);


--
-- Name: user_two_factor_user_id_idx; Type: INDEX; Schema: zzsh_auth_user; Owner: -
--

CREATE INDEX user_two_factor_user_id_idx ON zzsh_auth_user."twoFactor" USING btree ("userId");


--
-- Name: user_verification_identifier_idx; Type: INDEX; Schema: zzsh_auth_user; Owner: -
--

CREATE INDEX user_verification_identifier_idx ON zzsh_auth_user.verification USING btree (identifier);


--
-- Name: carousel_item_slot_idx; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE INDEX carousel_item_slot_idx ON zzsh_content.carousel_item USING btree (slot_code, sort_order DESC, id DESC);


--
-- Name: content_item_public_idx; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE INDEX content_item_public_idx ON zzsh_content.content_item USING btree (type, game_id, sort_order DESC, id DESC);


--
-- Name: content_item_resource_key_unique; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE UNIQUE INDEX content_item_resource_key_unique ON zzsh_content.content_item USING btree (resource_key) WHERE (resource_key IS NOT NULL);


--
-- Name: content_version_item_idx; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE INDEX content_version_item_idx ON zzsh_content.content_version USING btree (item_id, sequence DESC);


--
-- Name: content_version_single_draft; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE UNIQUE INDEX content_version_single_draft ON zzsh_content.content_version USING btree (item_id) WHERE (state = 'DRAFT'::text);


--
-- Name: content_version_single_published; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE UNIQUE INDEX content_version_single_published ON zzsh_content.content_version USING btree (item_id) WHERE (state = 'PUBLISHED'::text);


--
-- Name: document_acceptance_subject_idx; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE INDEX document_acceptance_subject_idx ON zzsh_content.document_acceptance USING btree (subject_type, subject_id, document_type, accepted_at DESC);


--
-- Name: legal_document_current_idx; Type: INDEX; Schema: zzsh_content; Owner: -
--

CREATE INDEX legal_document_current_idx ON zzsh_content.legal_document_version USING btree (doc_type, status, effective_at DESC, sealed_at DESC);


--
-- Name: admin_auth_captcha_used_expiry_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_auth_captcha_used_expiry_idx ON zzsh_iam.admin_auth_captcha_used USING btree (expires_at);


--
-- Name: admin_auth_failure_lookup_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_auth_failure_lookup_idx ON zzsh_iam.admin_auth_failure USING btree (scope, subject, occurred_at);


--
-- Name: admin_recovery_notification_target_active_user_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX admin_recovery_notification_target_active_user_idx ON zzsh_iam.admin_recovery_notification_target USING btree (admin_user_id) WHERE active;


--
-- Name: admin_recovery_request_target_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_recovery_request_target_idx ON zzsh_iam.admin_recovery_request USING btree (target_admin_user_id, status);


--
-- Name: admin_recovery_request_token_hash_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX admin_recovery_request_token_hash_idx ON zzsh_iam.admin_recovery_request USING btree (recovery_token_hash) WHERE (recovery_token_hash IS NOT NULL);


--
-- Name: admin_security_notification_outbox_pending_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_security_notification_outbox_pending_idx ON zzsh_iam.admin_security_notification_outbox USING btree (status, next_attempt_at, created_at);


--
-- Name: admin_user_permission_code_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_user_permission_code_idx ON zzsh_iam.admin_user_permission USING btree (permission_code);


--
-- Name: admin_user_role_role_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX admin_user_role_role_idx ON zzsh_iam.admin_user_role USING btree (role_id);


--
-- Name: approval_decision_approver_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_decision_approver_idx ON zzsh_iam.approval_decision USING btree (approver_admin_id, created_at DESC);


--
-- Name: approval_execution_executor_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_execution_executor_idx ON zzsh_iam.approval_execution USING btree (executed_by, created_at DESC);


--
-- Name: approval_request_candidate_admin_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_request_candidate_admin_idx ON zzsh_iam.approval_request_candidate USING btree (admin_user_id, request_id);


--
-- Name: approval_request_pending_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_request_pending_idx ON zzsh_iam.approval_request USING btree (status, expires_at, created_at DESC, id DESC);


--
-- Name: approval_request_requester_status_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_request_requester_status_idx ON zzsh_iam.approval_request USING btree (requested_by, status, created_at DESC, id DESC);


--
-- Name: approval_template_candidate_admin_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX approval_template_candidate_admin_idx ON zzsh_iam.approval_template_candidate USING btree (admin_user_id);


--
-- Name: audit_event_actor_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX audit_event_actor_idx ON zzsh_iam.audit_event USING btree (actor_type, actor_id);


--
-- Name: audit_event_object_action_outcome_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX audit_event_object_action_outcome_idx ON zzsh_iam.audit_event USING btree (object_id, action, outcome);


--
-- Name: audit_event_occurred_at_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX audit_event_occurred_at_idx ON zzsh_iam.audit_event USING btree (occurred_at);


--
-- Name: im_aftersale_one_pending; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_aftersale_one_pending ON zzsh_iam.im_aftersale_record USING btree (app_id, order_source, order_id, requester_user_id) WHERE (state = 'PENDING'::text);


--
-- Name: im_aftersale_queue; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_aftersale_queue ON zzsh_iam.im_aftersale_record USING btree (app_id, state, created_at DESC, id DESC);


--
-- Name: im_aftersale_user_recent; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_aftersale_user_recent ON zzsh_iam.im_aftersale_record USING btree (app_id, requester_user_id, order_id, created_at DESC, id DESC);


--
-- Name: im_consultation_app_queue_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_app_queue_idx ON zzsh_iam.im_consultation USING btree (app_id, state, kind, assigned_admin_id, updated_at DESC, id);


--
-- Name: im_consultation_app_user_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_app_user_idx ON zzsh_iam.im_consultation USING btree (app_id, user_id, updated_at DESC, id);


--
-- Name: im_consultation_event_consultation_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_event_consultation_idx ON zzsh_iam.im_consultation_event USING btree (consultation_id, created_at, id);


--
-- Name: im_consultation_queue_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_queue_idx ON zzsh_iam.im_consultation USING btree (state, kind, assigned_admin_id, updated_at DESC, id);


--
-- Name: im_consultation_scope_operation_active_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_consultation_scope_operation_active_idx ON zzsh_iam.im_consultation_scope_operation USING btree (app_id, consultation_id) WHERE (state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'UNKNOWN'::text]));


--
-- Name: im_consultation_scope_operation_due_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_scope_operation_due_idx ON zzsh_iam.im_consultation_scope_operation USING btree (app_id, state, next_retry_at, updated_at) WHERE (state = ANY (ARRAY['PENDING'::text, 'UNKNOWN'::text, 'RUNNING'::text]));


--
-- Name: im_consultation_thread_open_unique; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_consultation_thread_open_unique ON zzsh_iam.im_consultation USING btree (thread_id) WHERE (state <> 'CLOSED'::text);


--
-- Name: im_consultation_user_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_consultation_user_idx ON zzsh_iam.im_consultation USING btree (user_id, updated_at DESC, id);


--
-- Name: im_identity_mapping_pending_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_identity_mapping_pending_idx ON zzsh_iam.im_identity_mapping USING btree (status, next_retry_at, attempt_lease_until, updated_at, id) WHERE (status = 'PENDING'::text);


--
-- Name: im_identity_mapping_scope_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_identity_mapping_scope_idx ON zzsh_iam.im_identity_mapping USING btree (provider, app_id, realm, identity_kind, status, updated_at, id);


--
-- Name: im_support_consultation_rotation; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_consultation_rotation ON zzsh_iam.im_support_presence USING btree (app_id, last_consultation_assigned_at, admin_user_id);


--
-- Name: im_support_handover_from_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_handover_from_idx ON zzsh_iam.im_support_handover USING btree (app_id, from_admin_id, created_at DESC);


--
-- Name: im_support_handover_object_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_handover_object_idx ON zzsh_iam.im_support_handover USING btree (object_type, object_id, created_at DESC);


--
-- Name: im_support_handover_recent_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_handover_recent_idx ON zzsh_iam.im_support_handover USING btree (app_id, created_at DESC, id DESC);


--
-- Name: im_support_handover_to_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_handover_to_idx ON zzsh_iam.im_support_handover USING btree (app_id, to_admin_id, created_at DESC);


--
-- Name: im_support_order_rotation; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_order_rotation ON zzsh_iam.im_support_presence USING btree (app_id, last_order_assigned_at, admin_user_id);


--
-- Name: im_support_presence_session_open_unique; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_support_presence_session_open_unique ON zzsh_iam.im_support_presence_session USING btree (app_id, admin_user_id) WHERE (ended_at IS NULL);


--
-- Name: im_support_presence_session_owner_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_presence_session_owner_idx ON zzsh_iam.im_support_presence_session USING btree (app_id, admin_user_id, started_at DESC);


--
-- Name: im_support_presence_session_stale_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_presence_session_stale_idx ON zzsh_iam.im_support_presence_session USING btree (app_id, last_heartbeat_at) WHERE (ended_at IS NULL);


--
-- Name: im_support_presence_session_window_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_presence_session_window_idx ON zzsh_iam.im_support_presence_session USING btree (app_id, started_at, ended_at);


--
-- Name: im_support_round_rating_agent_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_round_rating_agent_idx ON zzsh_iam.im_support_round_rating USING btree (app_id, assigned_admin_id, submitted_at);


--
-- Name: im_support_round_rating_day_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_round_rating_day_idx ON zzsh_iam.im_support_round_rating USING btree (app_id, submitted_at);


--
-- Name: im_support_thread_scope_state_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX im_support_thread_scope_state_idx ON zzsh_iam.im_support_thread USING btree (app_id, message_scope_state, updated_at);


--
-- Name: im_support_thread_scope_unique; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_support_thread_scope_unique ON zzsh_iam.im_support_thread USING btree (app_id, message_scope_id) WHERE (message_scope_id IS NOT NULL);


--
-- Name: im_support_thread_user_kind_unique; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX im_support_thread_user_kind_unique ON zzsh_iam.im_support_thread USING btree (app_id, user_id, kind);


--
-- Name: joinpay_payout_claim_audit_once; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX joinpay_payout_claim_audit_once ON zzsh_iam.audit_event USING btree (((details ->> 'attemptId'::text))) WHERE (action = 'joinpay.payout.claimed'::text);


--
-- Name: joinpay_payout_observed_audit_once; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX joinpay_payout_observed_audit_once ON zzsh_iam.audit_event USING btree (((details ->> 'observationId'::text))) WHERE (action = 'joinpay.payout.observed'::text);


--
-- Name: joinpay_withdrawal_money_audit_once; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE UNIQUE INDEX joinpay_withdrawal_money_audit_once ON zzsh_iam.audit_event USING btree (object_id, action) WHERE (action = ANY (ARRAY['joinpay.withdrawal.reserved'::text, 'joinpay.withdrawal.paid'::text, 'joinpay.withdrawal.released'::text]));


--
-- Name: membership_entitlement_subject_scope_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX membership_entitlement_subject_scope_idx ON zzsh_iam.membership_entitlement USING btree (user_id, game_id, scope_key, starts_at, ends_at);


--
-- Name: membership_growth_contribution_user_effective_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX membership_growth_contribution_user_effective_idx ON zzsh_iam.membership_growth_contribution USING btree (user_id, effective_at DESC);


--
-- Name: membership_growth_contribution_user_game_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX membership_growth_contribution_user_game_idx ON zzsh_iam.membership_growth_contribution USING btree (user_id, game_id, effective_at DESC);


--
-- Name: membership_growth_legacy_coverage_receipt; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX membership_growth_legacy_coverage_receipt ON zzsh_iam.membership_growth_legacy_coverage USING btree (subject_user_id, receipt_digest);


--
-- Name: membership_growth_legacy_coverage_subject_scope; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX membership_growth_legacy_coverage_subject_scope ON zzsh_iam.membership_growth_legacy_coverage USING btree (subject_user_id, cutoff DESC, created_at DESC, id COLLATE "C" DESC);


--
-- Name: user_identity_state_account_status_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX user_identity_state_account_status_idx ON zzsh_iam.user_identity_state USING btree (account_status, updated_at DESC);


--
-- Name: user_identity_subject_digest_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX user_identity_subject_digest_idx ON zzsh_iam.user_identity_subject USING btree (subject_digest);


--
-- Name: user_identity_verification_attempt_rate_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX user_identity_verification_attempt_rate_idx ON zzsh_iam.user_identity_verification_attempt USING btree (user_id, created_at);


--
-- Name: user_note_visible_by_user; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX user_note_visible_by_user ON zzsh_iam.user_note USING btree (user_id, created_at DESC, id COLLATE "C" DESC) WHERE (deleted_at IS NULL);


--
-- Name: zzsh_iam_audit_event_user_migration_latest_idx; Type: INDEX; Schema: zzsh_iam; Owner: -
--

CREATE INDEX zzsh_iam_audit_event_user_migration_latest_idx ON zzsh_iam.audit_event USING btree (object_id, occurred_at DESC, id DESC) WHERE ((action = 'user.legacy_owner.migrated'::text) AND (object_type = 'user'::text) AND (outcome = 'SUCCESS'::text));


--
-- Name: channel_refund_funds_budget; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX channel_refund_funds_budget ON zzsh_order.channel_refund_intent USING btree (payment_source, merchant_identity_id, original_payment_trx_no);


--
-- Name: finance_observation_coverage_latest; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX finance_observation_coverage_latest ON zzsh_order.personal_finance_observation_coverage USING btree (user_id, source_kind, source_cutoff DESC, id DESC);


--
-- Name: im_order_activity_recent; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_activity_recent ON zzsh_order.im_order_activity USING btree (last_message_at DESC);


--
-- Name: im_order_dispatch_waiting; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_dispatch_waiting ON zzsh_order.im_order_group USING btree (app_id, created_at, order_id) WHERE (provision_state = 'WAITING'::text);


--
-- Name: im_order_due_reminder_due_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_due_reminder_due_idx ON zzsh_order.im_order_due_reminder USING btree (app_id, state, next_attempt_at, created_at);


--
-- Name: im_order_due_reminder_lease_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_due_reminder_lease_idx ON zzsh_order.im_order_due_reminder USING btree (app_id, state, lease_until) WHERE (state = 'SENDING'::text);


--
-- Name: im_order_event_approval_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_event_approval_unique ON zzsh_order.im_order_event USING btree (app_id, team_id, sender_account_id, message_client_id) WHERE (type = 'send_approved'::text);


--
-- Name: im_order_event_delivery_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_event_delivery_unique ON zzsh_order.im_order_event USING btree (app_id, team_id, message_server_id) WHERE (type = 'message_delivered'::text);


--
-- Name: im_order_event_key; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_event_key ON zzsh_order.im_order_event USING btree (order_id, event_key);


--
-- Name: im_order_event_order_type; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_event_order_type ON zzsh_order.im_order_event USING btree (order_id, type, recorded_at);


--
-- Name: im_order_event_pending; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_event_pending ON zzsh_order.im_order_event USING btree (type, status, recorded_at);


--
-- Name: im_order_group_add_due; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_group_add_due ON zzsh_order.im_order_group USING btree (escalation_state, next_add_due_at, order_id) WHERE (next_add_due_at IS NOT NULL);


--
-- Name: im_order_group_reminder_due; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_group_reminder_due ON zzsh_order.im_order_group USING btree (escalation_state, remind_due_at, order_id) WHERE (remind_due_at IS NOT NULL);


--
-- Name: im_order_one_buyer; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_one_buyer ON zzsh_order.im_order_member USING btree (order_id) WHERE (party = 'BUYER'::text);


--
-- Name: im_order_one_owner; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_one_owner ON zzsh_order.im_order_member USING btree (order_id) WHERE (party = 'OWNER'::text);


--
-- Name: im_order_operation_create_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_operation_create_unique ON zzsh_order.im_order_operation USING btree (order_id) WHERE (kind = 'CREATE'::text);


--
-- Name: im_order_operation_due; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_operation_due ON zzsh_order.im_order_operation USING btree (app_id, state, next_retry_at);


--
-- Name: im_order_operation_escalation_due; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_operation_escalation_due ON zzsh_order.im_order_operation USING btree (app_id, kind, state, next_retry_at, order_id) WHERE (kind = ANY (ARRAY['ADD_MEMBER'::text, 'BOT_NOTICE'::text]));


--
-- Name: im_order_operation_round_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_operation_round_unique ON zzsh_order.im_order_operation USING btree (order_id, kind, round) WHERE (kind = ANY (ARRAY['ADD_MEMBER'::text, 'BOT_NOTICE'::text]));


--
-- Name: im_order_operation_unresolved_structure_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_operation_unresolved_structure_unique ON zzsh_order.im_order_operation USING btree (order_id) WHERE ((kind = ANY (ARRAY['CREATE'::text, 'ADD_MEMBER'::text])) AND (state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'NEEDS_REVIEW'::text])));


--
-- Name: im_order_stage_card_due_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_stage_card_due_idx ON zzsh_order.im_order_stage_card USING btree (app_id, state, next_attempt_at, created_at);


--
-- Name: im_order_stage_card_lease_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_stage_card_lease_idx ON zzsh_order.im_order_stage_card USING btree (app_id, state, lease_until) WHERE (state = 'SENDING'::text);


--
-- Name: im_order_team_unique; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX im_order_team_unique ON zzsh_order.im_order_group USING btree (app_id, team_id) WHERE (team_id IS NOT NULL);


--
-- Name: im_order_unread_identity; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX im_order_unread_identity ON zzsh_order.im_order_unread USING btree (identity_id);


--
-- Name: invitation_relation_parent_read; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX invitation_relation_parent_read ON zzsh_order.invitation_relation USING btree (parent_user_id, type, id);


--
-- Name: joinpay_abnormal_refund_key; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX joinpay_abnormal_refund_key ON zzsh_order.channel_refund_intent USING btree (payment_confirmation_id, idempotency_key) WHERE ((basis_kind = 'REVIEW_CONFIRMATION'::text) AND (payment_source = 'JOINPAY'::text));


--
-- Name: joinpay_account_observation_scope_time; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX joinpay_account_observation_scope_time ON zzsh_order.joinpay_account_observation USING btree (merchant_identity_id, operation, recorded_at DESC, attempt_id);


--
-- Name: joinpay_payout_submit_once; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX joinpay_payout_submit_once ON zzsh_order.joinpay_payout_attempt USING btree (intent_id) WHERE (operation = 'SUBMIT'::text);


--
-- Name: joinpay_refund_submit_once; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX joinpay_refund_submit_once ON zzsh_order.joinpay_refund_attempt USING btree (intent_id) WHERE (operation = 'SUBMIT'::text);


--
-- Name: joinpay_refund_transaction_once; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX joinpay_refund_transaction_once ON zzsh_order.channel_refund_intent USING btree (payment_source, merchant_identity_id, provider_refund_trx_no) WHERE ((payment_source = 'JOINPAY'::text) AND (provider_refund_trx_no IS NOT NULL));


--
-- Name: joinpay_withdrawal_platform_once; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX joinpay_withdrawal_platform_once ON zzsh_order.joinpay_withdrawal_intent USING btree (merchant_identity_id, platform_serial_no) WHERE (platform_serial_no IS NOT NULL);


--
-- Name: legacy_continuation_one_head; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX legacy_continuation_one_head ON zzsh_order.legacy_continuation_version USING btree (order_id) WHERE (superseded_at IS NULL);


--
-- Name: legacy_continuation_one_import; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX legacy_continuation_one_import ON zzsh_order.legacy_continuation_evidence USING btree (order_id) WHERE (source_kind = 'SOURCE_IMPORT'::text);


--
-- Name: legacy_duty_finance_subject; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_duty_finance_subject ON zzsh_order.legacy_duty_finance_fact USING btree (subject_user_id, created_at DESC, duty_id COLLATE "C" DESC);


--
-- Name: legacy_guarantee_coverage_latest; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_guarantee_coverage_latest ON zzsh_order.legacy_owner_guarantee_coverage USING btree (user_id, source_cutoff DESC, id COLLATE "C" DESC);


--
-- Name: legacy_guarantee_history_user_page; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_guarantee_history_user_page ON zzsh_order.legacy_owner_guarantee_observation USING btree (user_id, source_cutoff, imported_at DESC, id COLLATE "C" DESC);


--
-- Name: legacy_inflight_account_disposition; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_inflight_account_disposition ON zzsh_order.legacy_inflight_register USING btree (account_id, disposition);


--
-- Name: legacy_order_duty_party_state; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_duty_party_state ON zzsh_order.legacy_order_duty USING btree (counterparty_user_id, status, maturity_at, id);


--
-- Name: legacy_order_read_account; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_read_account ON zzsh_order.legacy_order_read_snapshot USING btree (account_id);


--
-- Name: legacy_order_read_no; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_read_no ON zzsh_order.legacy_order_read_snapshot USING btree (original_order_no);


--
-- Name: legacy_order_read_owner; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_read_owner ON zzsh_order.legacy_order_read_snapshot USING btree (owner_user_id, source_created_at DESC NULLS LAST, id DESC);


--
-- Name: legacy_order_read_renter; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_read_renter ON zzsh_order.legacy_order_read_snapshot USING btree (renter_user_id, source_created_at DESC NULLS LAST, id DESC);


--
-- Name: legacy_order_read_scope; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX legacy_order_read_scope ON zzsh_order.legacy_order_read_snapshot USING btree (game_id, source_created_at DESC NULLS LAST, id DESC);


--
-- Name: owner_guarantee_requirement_binding_uq; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX owner_guarantee_requirement_binding_uq ON zzsh_order.owner_guarantee_requirement USING btree (owner_user_id, account_id, price_version_id, COALESCE(listing_version_id, ''::text));


--
-- Name: payment_confirmation_one_applied; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX payment_confirmation_one_applied ON zzsh_order.payment_confirmation USING btree (order_id) WHERE (disposition = 'APPLIED'::text);


--
-- Name: prestart_refund_original_key; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX prestart_refund_original_key ON zzsh_order.channel_refund_intent USING btree (payment_confirmation_id, idempotency_key) WHERE ((basis_kind = 'PRESTART_TERMINATION'::text) AND (payment_source = 'JOINPAY'::text));


--
-- Name: prestart_termination_one_active; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX prestart_termination_one_active ON zzsh_order.prestart_termination USING btree (order_id) WHERE (state <> 'REJECTED'::text);


--
-- Name: referral_earning_due; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX referral_earning_due ON zzsh_order.rental_referral_earning USING btree (due_at, id) WHERE (state = 'PENDING'::text);


--
-- Name: referral_earning_self; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX referral_earning_self ON zzsh_order.rental_referral_earning USING btree (beneficiary_user_id, created_at, id);


--
-- Name: rental_opening_auto_confirm_due_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX rental_opening_auto_confirm_due_idx ON zzsh_order.rental_opening USING btree (auto_confirm_due_at, id) WHERE (status = 'DRAFT'::text);


--
-- Name: rental_opening_one_confirmed; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX rental_opening_one_confirmed ON zzsh_order.rental_opening USING btree (order_id) WHERE (status = 'CONFIRMED'::text);


--
-- Name: rental_order_admin_list; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX rental_order_admin_list ON zzsh_order.rental_order USING btree (game_id, status, id);


--
-- Name: rental_order_expiry_scan; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX rental_order_expiry_scan ON zzsh_order.rental_order USING btree (hold_until, id) WHERE (status = 'PENDING_PAYMENT'::text);


--
-- Name: rental_order_owner_list; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX rental_order_owner_list ON zzsh_order.rental_order USING btree (owner_user_id, created_at DESC, id DESC);


--
-- Name: rental_order_renter_list; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX rental_order_renter_list ON zzsh_order.rental_order USING btree (renter_user_id, created_at DESC, id DESC);


--
-- Name: rental_order_single_occupancy; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX rental_order_single_occupancy ON zzsh_order.rental_order USING btree (account_id) WHERE (status = ANY (ARRAY['PENDING_PAYMENT'::text, 'PAID'::text]));


--
-- Name: settlement_intake_one_open; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX settlement_intake_one_open ON zzsh_order.settlement_intake USING btree (order_id) WHERE (status = 'OPEN'::text);


--
-- Name: settlement_ledger_source_payment_once; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX settlement_ledger_source_payment_once ON zzsh_order.settlement_ledger_entry USING btree (source_payment_confirmation_id) WHERE (source_payment_confirmation_id IS NOT NULL);


--
-- Name: settlement_version_current; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE UNIQUE INDEX settlement_version_current ON zzsh_order.settlement_version USING btree (order_id) WHERE (superseded_at IS NULL);


--
-- Name: zzsh_order_personal_finance_observation_user_kind_event_id_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX zzsh_order_personal_finance_observation_user_kind_event_id_idx ON zzsh_order.personal_finance_observation USING btree (user_id, source_kind, source_event_at, id COLLATE "C");


--
-- Name: zzsh_order_settlement_ledger_entry_counterparty_created_id_idx; Type: INDEX; Schema: zzsh_order; Owner: -
--

CREATE INDEX zzsh_order_settlement_ledger_entry_counterparty_created_id_idx ON zzsh_order.settlement_ledger_entry USING btree (counterparty_user_id, created_at, id COLLATE "C");


--
-- Name: admin_supply_scope_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX admin_supply_scope_game_idx ON zzsh_supply.admin_supply_scope USING btree (game_id, admin_user_id);


--
-- Name: agreement_version_game_status_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX agreement_version_game_status_idx ON zzsh_supply.agreement_version USING btree (game_id, status, created_at DESC);


--
-- Name: billable_item_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX billable_item_game_idx ON zzsh_supply.billable_item USING btree (game_id, sort_order, code);


--
-- Name: entitlement_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX entitlement_game_idx ON zzsh_supply.entitlement USING btree (game_id, sort_order, code);


--
-- Name: favorite_user_page; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX favorite_user_page ON zzsh_supply.favorite USING btree (user_id, created_at DESC, account_id DESC);


--
-- Name: firearm_alias_search_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX firearm_alias_search_idx ON zzsh_supply.firearm_alias USING btree (game_id, firearm_id, enabled, name);


--
-- Name: firearm_alias_source_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX firearm_alias_source_unique ON zzsh_supply.firearm_alias USING btree (game_id, source_namespace, source_token) WHERE ((source_namespace IS NOT NULL) AND (source_token IS NOT NULL));


--
-- Name: firearm_classification_source_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX firearm_classification_source_unique ON zzsh_supply.firearm_classification USING btree (game_id, source_namespace, source_token) WHERE ((source_namespace IS NOT NULL) AND (source_token IS NOT NULL));


--
-- Name: firearm_game_sort_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX firearm_game_sort_idx ON zzsh_supply.firearm USING btree (game_id, updated_at DESC, id DESC);


--
-- Name: firearm_source_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX firearm_source_unique ON zzsh_supply.firearm USING btree (game_id, source_namespace, source_token) WHERE ((source_namespace IS NOT NULL) AND (source_token IS NOT NULL));


--
-- Name: game_service_operation_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX game_service_operation_game_idx ON zzsh_supply.game_service_operation USING btree (game_id, service_code);


--
-- Name: gunsmith_code_game_code_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX gunsmith_code_game_code_unique ON zzsh_supply.gunsmith_code USING btree (game_id, code);


--
-- Name: gunsmith_code_public_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX gunsmith_code_public_idx ON zzsh_supply.gunsmith_code USING btree (game_id, firearm_id, status, updated_at DESC, id DESC);


--
-- Name: gunsmith_code_source_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX gunsmith_code_source_unique ON zzsh_supply.gunsmith_code USING btree (game_id, source_namespace, source_token) WHERE ((source_namespace IS NOT NULL) AND (source_token IS NOT NULL));


--
-- Name: legacy_account_number_lookup; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX legacy_account_number_lookup ON zzsh_supply.legacy_listing_read_snapshot USING btree (((snapshot ->> 'resourceNo'::text)));


--
-- Name: legacy_skin_holding_observation_version_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX legacy_skin_holding_observation_version_idx ON zzsh_supply.legacy_skin_holding USING btree (observation_version_id);


--
-- Name: listing_publication_account_time_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX listing_publication_account_time_idx ON zzsh_supply.listing_publication USING btree (account_id, published_at DESC, id);


--
-- Name: listing_review_queue; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX listing_review_queue ON zzsh_supply.listing_version USING btree (review_state, submitted_at, id);


--
-- Name: media_asset_game_id_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX media_asset_game_id_unique ON zzsh_supply.media_asset USING btree (game_id, id);


--
-- Name: media_asset_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX media_asset_game_idx ON zzsh_supply.media_asset USING btree (game_id, purpose, created_at DESC);


--
-- Name: media_asset_review_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX media_asset_review_idx ON zzsh_supply.media_asset USING btree (review_state, ownership_kind, created_at DESC, id DESC);


--
-- Name: price_version_game_status_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX price_version_game_status_idx ON zzsh_supply.price_version USING btree (game_id, status, created_at DESC);


--
-- Name: profile_avatar_pending_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX profile_avatar_pending_idx ON zzsh_supply.profile_avatar USING btree (realm, updated_at DESC) WHERE (pending_asset_id IS NOT NULL);


--
-- Name: rental_account_owner_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX rental_account_owner_game_idx ON zzsh_supply.rental_account USING btree (owner_user_id, game_id, created_at DESC);


--
-- Name: rental_account_public_number_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX rental_account_public_number_unique ON zzsh_supply.rental_account USING btree (display_no) WHERE (display_no IS NOT NULL);


--
-- Name: rule_release_game_generation_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX rule_release_game_generation_idx ON zzsh_supply.rule_release USING btree (game_id, generation DESC);


--
-- Name: skin_category_game_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX skin_category_game_idx ON zzsh_supply.skin_category USING btree (game_id, sort_order, code);


--
-- Name: skin_game_category_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX skin_game_category_idx ON zzsh_supply.skin USING btree (game_id, category_id, sort_order, code);


--
-- Name: skin_source_identity_unique; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE UNIQUE INDEX skin_source_identity_unique ON zzsh_supply.skin USING btree (game_id, source_namespace COLLATE "C", source_field COLLATE "C", source_token COLLATE "C") WHERE (source_namespace IS NOT NULL);


--
-- Name: term_version_game_status_idx; Type: INDEX; Schema: zzsh_supply; Owner: -
--

CREATE INDEX term_version_game_status_idx ON zzsh_supply.term_version USING btree (game_id, status, created_at DESC);


--
-- Name: user admin_auth_creation_audit; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_auth_creation_audit ON zzsh_auth_admin.user：执行 zzsh_iam.record_auth_user_created。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_auth_creation_audit AFTER INSERT ON zzsh_auth_admin."user" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_auth_user_created();


--
-- Name: account admin_clear_legacy_password; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_clear_legacy_password ON zzsh_auth_admin.account：执行 zzsh_iam.clear_legacy_password_on_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_clear_legacy_password BEFORE UPDATE OF password ON zzsh_auth_admin.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.clear_legacy_password_on_change();


--
-- Name: account admin_password_change_audit; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_password_change_audit ON zzsh_auth_admin.account：执行 zzsh_iam.record_password_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_password_change_audit AFTER UPDATE OF password ON zzsh_auth_admin.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_password_change();


--
-- Name: account admin_password_change_requirement; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_password_change_requirement ON zzsh_auth_admin.account：执行 zzsh_iam.clear_admin_password_change_requirement。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_password_change_requirement AFTER UPDATE OF password ON zzsh_auth_admin.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.clear_admin_password_change_requirement();


--
-- Name: account admin_recovery_revoke_on_password_change; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_recovery_revoke_on_password_change ON zzsh_auth_admin.account：执行 zzsh_iam.revoke_admin_recovery_on_password_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_recovery_revoke_on_password_change AFTER UPDATE OF password ON zzsh_auth_admin.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.revoke_admin_recovery_on_password_change();


--
-- Name: session admin_session_audit; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_session_audit ON zzsh_auth_admin.session：执行 zzsh_iam.record_security_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_session_audit AFTER INSERT OR DELETE OR UPDATE ON zzsh_auth_admin.session FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_security_change();


--
-- Name: twoFactor admin_two_factor_audit; Type: TRIGGER; Schema: zzsh_auth_admin; Owner: -
--

-- 触发器 admin_two_factor_audit ON zzsh_auth_admin.twoFactor：执行 zzsh_iam.record_security_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_two_factor_audit AFTER INSERT OR DELETE OR UPDATE ON zzsh_auth_admin."twoFactor" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_security_change();


--
-- Name: user native_user_insert_proof_capture; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 native_user_insert_proof_capture ON zzsh_auth_user.user：执行 zzsh_order.capture_native_user_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_user_insert_proof_capture AFTER INSERT ON zzsh_auth_user."user" FOR EACH ROW EXECUTE FUNCTION zzsh_order.capture_native_user_insert();


--
-- Name: user user_auth_creation_audit; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_auth_creation_audit ON zzsh_auth_user.user：执行 zzsh_iam.record_auth_user_created。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_auth_creation_audit AFTER INSERT ON zzsh_auth_user."user" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_auth_user_created();


--
-- Name: account user_clear_legacy_password; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_clear_legacy_password ON zzsh_auth_user.account：执行 zzsh_iam.clear_legacy_password_on_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_clear_legacy_password BEFORE UPDATE OF password ON zzsh_auth_user.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.clear_legacy_password_on_change();


--
-- Name: account user_password_change_audit; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_password_change_audit ON zzsh_auth_user.account：执行 zzsh_iam.record_password_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_password_change_audit AFTER UPDATE OF password ON zzsh_auth_user.account FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_password_change();


--
-- Name: user user_rental_membership_init; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_rental_membership_init ON zzsh_auth_user.user：执行 zzsh_iam.initialize_rental_membership。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_rental_membership_init AFTER INSERT ON zzsh_auth_user."user" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.initialize_rental_membership();


--
-- Name: session user_session_audit; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_session_audit ON zzsh_auth_user.session：执行 zzsh_iam.record_security_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_session_audit AFTER INSERT OR DELETE OR UPDATE ON zzsh_auth_user.session FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_security_change();


--
-- Name: twoFactor user_two_factor_audit; Type: TRIGGER; Schema: zzsh_auth_user; Owner: -
--

-- 触发器 user_two_factor_audit ON zzsh_auth_user.twoFactor：执行 zzsh_iam.record_security_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_two_factor_audit AFTER INSERT OR DELETE OR UPDATE ON zzsh_auth_user."twoFactor" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_security_change();


--
-- Name: content_version content_resource_version_guard; Type: TRIGGER; Schema: zzsh_content; Owner: -
--

-- 触发器 content_resource_version_guard ON zzsh_content.content_version：执行 zzsh_content.guard_resource_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER content_resource_version_guard BEFORE INSERT OR UPDATE ON zzsh_content.content_version FOR EACH ROW EXECUTE FUNCTION zzsh_content.guard_resource_version();


--
-- Name: content_version content_update_settings_guard; Type: TRIGGER; Schema: zzsh_content; Owner: -
--

-- 触发器 content_update_settings_guard ON zzsh_content.content_version：执行 zzsh_content.guard_update_settings。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER content_update_settings_guard BEFORE INSERT OR UPDATE ON zzsh_content.content_version FOR EACH ROW EXECUTE FUNCTION zzsh_content.guard_update_settings();


--
-- Name: document_acceptance document_acceptance_immutable; Type: TRIGGER; Schema: zzsh_content; Owner: -
--

-- 触发器 document_acceptance_immutable ON zzsh_content.document_acceptance：执行 zzsh_content.guard_document_acceptance_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER document_acceptance_immutable BEFORE DELETE OR UPDATE ON zzsh_content.document_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_content.guard_document_acceptance_mutation();


--
-- Name: legal_document_version legal_document_version_guard; Type: TRIGGER; Schema: zzsh_content; Owner: -
--

-- 触发器 legal_document_version_guard ON zzsh_content.legal_document_version：执行 zzsh_content.guard_legal_document_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legal_document_version_guard BEFORE DELETE OR UPDATE ON zzsh_content.legal_document_version FOR EACH ROW EXECUTE FUNCTION zzsh_content.guard_legal_document_version();


--
-- Name: credit_event credit_event_guard; Type: TRIGGER; Schema: zzsh_credit; Owner: -
--

-- 触发器 credit_event_guard ON zzsh_credit.credit_event：执行 zzsh_credit.guard_credit_event_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER credit_event_guard BEFORE INSERT ON zzsh_credit.credit_event FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_event_insert();


--
-- Name: credit_event credit_event_immutable; Type: TRIGGER; Schema: zzsh_credit; Owner: -
--

-- 触发器 credit_event_immutable ON zzsh_credit.credit_event：执行 zzsh_credit.guard_credit_state_update。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER credit_event_immutable BEFORE DELETE OR UPDATE ON zzsh_credit.credit_event FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_state_update();


--
-- Name: user_credit_state user_credit_state_guard; Type: TRIGGER; Schema: zzsh_credit; Owner: -
--

-- 触发器 user_credit_state_guard ON zzsh_credit.user_credit_state：执行 zzsh_credit.guard_credit_state_update。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_credit_state_guard BEFORE DELETE OR UPDATE ON zzsh_credit.user_credit_state FOR EACH ROW EXECUTE FUNCTION zzsh_credit.guard_credit_state_update();


--
-- Name: admin_security admin_first_activation_evidence; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 admin_first_activation_evidence ON zzsh_iam.admin_security：执行 zzsh_iam.protect_admin_first_activation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_first_activation_evidence BEFORE INSERT OR UPDATE ON zzsh_iam.admin_security FOR EACH ROW EXECUTE FUNCTION zzsh_iam.protect_admin_first_activation();


--
-- Name: admin_security admin_security_audit; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 admin_security_audit ON zzsh_iam.admin_security：执行 zzsh_iam.record_security_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER admin_security_audit AFTER INSERT OR DELETE OR UPDATE ON zzsh_iam.admin_security FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_security_change();


--
-- Name: approval_request approval_request_snapshot_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 approval_request_snapshot_guard ON zzsh_iam.approval_request：执行 zzsh_iam.protect_approval_request_snapshot。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER approval_request_snapshot_guard BEFORE UPDATE ON zzsh_iam.approval_request FOR EACH ROW EXECUTE FUNCTION zzsh_iam.protect_approval_request_snapshot();


--
-- Name: audit_event audit_purge_record_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 audit_purge_record_guard ON zzsh_iam.audit_event：执行 zzsh_iam.guard_audit_purge_record。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER audit_purge_record_guard BEFORE DELETE ON zzsh_iam.audit_event FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_audit_purge_record();


--
-- Name: im_consultation im_aftersale_follow_consultation; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_aftersale_follow_consultation ON zzsh_iam.im_consultation：执行 zzsh_iam.sync_aftersale_consultation_handler。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_aftersale_follow_consultation AFTER INSERT OR UPDATE OF state, assigned_admin_id ON zzsh_iam.im_consultation FOR EACH ROW EXECUTE FUNCTION zzsh_iam.sync_aftersale_consultation_handler();


--
-- Name: im_consultation im_consultation_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_consultation_mutation_guard ON zzsh_iam.im_consultation：执行 zzsh_iam.guard_im_consultation_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_consultation_mutation_guard BEFORE UPDATE ON zzsh_iam.im_consultation FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_consultation_mutation();


--
-- Name: im_consultation_scope_operation im_consultation_scope_operation_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_consultation_scope_operation_mutation_guard ON zzsh_iam.im_consultation_scope_operation：执行 zzsh_iam.guard_im_consultation_scope_operation_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_consultation_scope_operation_mutation_guard BEFORE UPDATE ON zzsh_iam.im_consultation_scope_operation FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_consultation_scope_operation_mutation();


--
-- Name: im_identity_mapping im_identity_mapping_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_identity_mapping_mutation_guard ON zzsh_iam.im_identity_mapping：执行 zzsh_iam.guard_im_identity_mapping_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_identity_mapping_mutation_guard BEFORE UPDATE ON zzsh_iam.im_identity_mapping FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_identity_mapping_mutation();


--
-- Name: im_support_presence im_support_presence_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_support_presence_mutation_guard ON zzsh_iam.im_support_presence：执行 zzsh_iam.guard_im_support_presence_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_support_presence_mutation_guard BEFORE UPDATE ON zzsh_iam.im_support_presence FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_support_presence_mutation();


--
-- Name: im_support_round_rating im_support_round_rating_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_support_round_rating_mutation_guard ON zzsh_iam.im_support_round_rating：执行 zzsh_iam.guard_im_support_round_rating_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_support_round_rating_mutation_guard BEFORE DELETE OR UPDATE ON zzsh_iam.im_support_round_rating FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_support_round_rating_mutation();


--
-- Name: im_support_thread im_support_thread_mutation_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 im_support_thread_mutation_guard ON zzsh_iam.im_support_thread：执行 zzsh_iam.guard_im_support_thread_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_support_thread_mutation_guard BEFORE UPDATE ON zzsh_iam.im_support_thread FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_im_support_thread_mutation();


--
-- Name: audit_event joinpay_withdrawal_audit_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 joinpay_withdrawal_audit_guard ON zzsh_iam.audit_event：执行 zzsh_order.guard_joinpay_withdrawal_audit。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_audit_guard BEFORE INSERT ON zzsh_iam.audit_event FOR EACH ROW WHEN ((new.action = ANY (ARRAY['joinpay.withdrawal.reserved'::text, 'joinpay.withdrawal.paid'::text, 'joinpay.withdrawal.released'::text, 'joinpay.payout.claimed'::text, 'joinpay.payout.observed'::text]))) EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_audit();


--
-- Name: membership_growth_legacy_coverage legacy_growth_coverage_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 legacy_growth_coverage_guard ON zzsh_iam.membership_growth_legacy_coverage：执行 zzsh_iam.guard_legacy_growth_coverage。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_growth_coverage_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_iam.membership_growth_legacy_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_coverage();


--
-- Name: membership_growth_legacy_coverage legacy_growth_coverage_no_truncate; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 legacy_growth_coverage_no_truncate ON zzsh_iam.membership_growth_legacy_coverage：执行 zzsh_iam.guard_legacy_growth_coverage。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_growth_coverage_no_truncate BEFORE TRUNCATE ON zzsh_iam.membership_growth_legacy_coverage FOR EACH STATEMENT EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_coverage();


--
-- Name: membership_growth_legacy_read_admission legacy_growth_read_admission_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 legacy_growth_read_admission_guard ON zzsh_iam.membership_growth_legacy_read_admission：执行 zzsh_iam.guard_legacy_growth_read_admission。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_growth_read_admission_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_iam.membership_growth_legacy_read_admission FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_read_admission();


--
-- Name: membership_growth_legacy_read_admission legacy_growth_read_admission_no_truncate; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 legacy_growth_read_admission_no_truncate ON zzsh_iam.membership_growth_legacy_read_admission：执行 zzsh_iam.guard_legacy_growth_read_admission。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_growth_read_admission_no_truncate BEFORE TRUNCATE ON zzsh_iam.membership_growth_legacy_read_admission FOR EACH STATEMENT EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_read_admission();


--
-- Name: audit_event native_origin_excludes_legacy_source; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 native_origin_excludes_legacy_source ON zzsh_iam.audit_event：执行 zzsh_order.check_native_origin_excludes_legacy。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_origin_excludes_legacy_source AFTER INSERT ON zzsh_iam.audit_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.action = 'user.legacy_owner.migrated'::text) AND (new.outcome = 'SUCCESS'::text))) EXECUTE FUNCTION zzsh_order.check_native_origin_excludes_legacy();


--
-- Name: user_rental_membership rental_membership_guard; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 rental_membership_guard ON zzsh_iam.user_rental_membership：执行 zzsh_iam.guard_rental_membership。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_membership_guard BEFORE INSERT OR UPDATE ON zzsh_iam.user_rental_membership FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_rental_membership();


--
-- Name: user_identity_state user_identity_state_audit; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 user_identity_state_audit ON zzsh_iam.user_identity_state：执行 zzsh_iam.record_user_identity_state_change。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_identity_state_audit AFTER INSERT OR UPDATE ON zzsh_iam.user_identity_state FOR EACH ROW EXECUTE FUNCTION zzsh_iam.record_user_identity_state_change();


--
-- Name: user_note user_note_append_only; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 user_note_append_only ON zzsh_iam.user_note：执行 zzsh_iam.guard_user_note_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_note_append_only BEFORE UPDATE ON zzsh_iam.user_note FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_user_note_append_only();


--
-- Name: audit_event user_registration_fact_after_migration; Type: TRIGGER; Schema: zzsh_iam; Owner: -
--

-- 触发器 user_registration_fact_after_migration ON zzsh_iam.audit_event：执行 zzsh_iam.refresh_user_registration_fact。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER user_registration_fact_after_migration AFTER INSERT ON zzsh_iam.audit_event FOR EACH ROW WHEN (((new.action = 'user.legacy_owner.migrated'::text) AND (new.object_type = 'user'::text) AND (new.outcome = 'SUCCESS'::text) AND (new.object_id IS NOT NULL))) EXECUTE FUNCTION zzsh_iam.refresh_user_registration_fact();


--
-- Name: personal_finance_observation a_history_subject_lock; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 a_history_subject_lock ON zzsh_order.personal_finance_observation：执行 zzsh_order.lock_finance_history_subject。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_history_subject_lock BEFORE INSERT ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.lock_finance_history_subject();


--
-- Name: legacy_order_duty_admission a_legacy_admission_source_owner; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 a_legacy_admission_source_owner ON zzsh_order.legacy_order_duty_admission：执行 zzsh_order.guard_legacy_source_owner。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_legacy_admission_source_owner BEFORE INSERT ON zzsh_order.legacy_order_duty_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();


--
-- Name: legacy_order_duty a_legacy_duty_source_owner; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 a_legacy_duty_source_owner ON zzsh_order.legacy_order_duty：执行 zzsh_order.guard_legacy_source_owner。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_legacy_duty_source_owner BEFORE INSERT ON zzsh_order.legacy_order_duty FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();


--
-- Name: legacy_continuation_evidence a_legacy_evidence_source_owner; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 a_legacy_evidence_source_owner ON zzsh_order.legacy_continuation_evidence：执行 zzsh_order.guard_legacy_source_owner。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_legacy_evidence_source_owner BEFORE INSERT ON zzsh_order.legacy_continuation_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();


--
-- Name: legacy_inflight_register a_legacy_register_source_owner; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 a_legacy_register_source_owner ON zzsh_order.legacy_inflight_register：执行 zzsh_order.guard_legacy_source_owner。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_legacy_register_source_owner BEFORE INSERT ON zzsh_order.legacy_inflight_register FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();


--
-- Name: settlement_ledger_entry abnormal_refund_liability_entry_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 abnormal_refund_liability_entry_batch_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_abnormal_refund_liability_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER abnormal_refund_liability_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'abnormalRefundLiabilityId'::text))) EXECUTE FUNCTION zzsh_order.check_abnormal_refund_liability_batch();


--
-- Name: settlement_ledger_entry abnormal_refund_liability_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 abnormal_refund_liability_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_abnormal_refund_liability_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER abnormal_refund_liability_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'abnormalRefundLiabilityId'::text))) EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_entry();


--
-- Name: finance_event abnormal_refund_liability_event_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 abnormal_refund_liability_event_batch_guard ON zzsh_order.finance_event：执行 zzsh_order.check_abnormal_refund_liability_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER abnormal_refund_liability_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'REFUND_LIABILITY_RECOGNIZED'::text)) EXECUTE FUNCTION zzsh_order.check_abnormal_refund_liability_batch();


--
-- Name: finance_event abnormal_refund_liability_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 abnormal_refund_liability_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_abnormal_refund_liability_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER abnormal_refund_liability_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'REFUND_LIABILITY_RECOGNIZED'::text)) EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_event();


--
-- Name: finance_economic_root abnormal_refund_liability_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 abnormal_refund_liability_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_abnormal_refund_liability_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER abnormal_refund_liability_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_ABNORMAL_REFUND'::text)) EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_root();


--
-- Name: payment_confirmation applied_distribution_basis_pair; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 applied_distribution_basis_pair ON zzsh_order.payment_confirmation：执行 zzsh_order.check_payment_distribution_basis_pair。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER applied_distribution_basis_pair AFTER INSERT ON zzsh_order.payment_confirmation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_payment_distribution_basis_pair();


--
-- Name: channel_refund_intent channel_refund_joinpay_delete_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 channel_refund_joinpay_delete_guard ON zzsh_order.channel_refund_intent：执行 zzsh_order.guard_joinpay_refund_intent。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER channel_refund_joinpay_delete_guard BEFORE DELETE ON zzsh_order.channel_refund_intent FOR EACH ROW WHEN ((old.payment_source = 'JOINPAY'::text)) EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_intent();


--
-- Name: channel_refund_intent channel_refund_joinpay_write_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 channel_refund_joinpay_write_guard ON zzsh_order.channel_refund_intent：执行 zzsh_order.guard_joinpay_refund_intent。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER channel_refund_joinpay_write_guard BEFORE INSERT OR UPDATE ON zzsh_order.channel_refund_intent FOR EACH ROW WHEN ((new.payment_source = 'JOINPAY'::text)) EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_intent();


--
-- Name: channel_refund_observation channel_refund_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 channel_refund_observation_guard ON zzsh_order.channel_refund_observation：执行 zzsh_order.guard_channel_refund_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER channel_refund_observation_guard BEFORE DELETE OR UPDATE ON zzsh_order.channel_refund_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_refund_observation();


--
-- Name: finance_covered_event covered_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 covered_event_guard ON zzsh_order.finance_covered_event：执行 zzsh_order.guard_covered_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER covered_event_guard BEFORE INSERT ON zzsh_order.finance_covered_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_covered_event();


--
-- Name: finance_covered_event covered_event_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 covered_event_immutable ON zzsh_order.finance_covered_event：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER covered_event_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_covered_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_covered_event covered_event_set_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 covered_event_set_guard ON zzsh_order.finance_covered_event：执行 zzsh_order.check_opening_coverage_set。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER covered_event_set_guard AFTER INSERT ON zzsh_order.finance_covered_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_opening_coverage_set();


--
-- Name: payment_distribution_basis distribution_basis_applied_pair; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_basis_applied_pair ON zzsh_order.payment_distribution_basis：执行 zzsh_order.check_payment_distribution_basis_pair。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER distribution_basis_applied_pair AFTER INSERT ON zzsh_order.payment_distribution_basis DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_payment_distribution_basis_pair();


--
-- Name: distribution_invite_code distribution_code_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_code_immutable ON zzsh_order.distribution_invite_code：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_code_immutable BEFORE DELETE OR UPDATE ON zzsh_order.distribution_invite_code FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: distribution_order_admission distribution_order_admission_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_order_admission_guard ON zzsh_order.distribution_order_admission：执行 zzsh_order.guard_distribution_order_admission。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_order_admission_guard BEFORE INSERT ON zzsh_order.distribution_order_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_order_admission();


--
-- Name: distribution_order_admission distribution_order_admission_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_order_admission_immutable ON zzsh_order.distribution_order_admission：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_order_admission_immutable BEFORE DELETE OR UPDATE ON zzsh_order.distribution_order_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: distribution_participant distribution_participant_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_participant_guard ON zzsh_order.distribution_participant：执行 zzsh_order.guard_distribution_participant。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_participant_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.distribution_participant FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_participant();


--
-- Name: distribution_participant distribution_participant_knowledge_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_participant_knowledge_guard ON zzsh_order.distribution_participant：执行 zzsh_order.check_distribution_relation_knowledge。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER distribution_participant_knowledge_guard AFTER INSERT OR UPDATE ON zzsh_order.distribution_participant DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();


--
-- Name: distribution_policy_head distribution_policy_head_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_policy_head_guard ON zzsh_order.distribution_policy_head：执行 zzsh_order.guard_distribution_policy_head。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_policy_head_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.distribution_policy_head FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_policy_head();


--
-- Name: distribution_policy_version distribution_policy_version_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_policy_version_guard ON zzsh_order.distribution_policy_version：执行 zzsh_order.guard_distribution_policy_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_policy_version_guard BEFORE INSERT ON zzsh_order.distribution_policy_version FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_policy_version();


--
-- Name: distribution_policy_version distribution_policy_version_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 distribution_policy_version_immutable ON zzsh_order.distribution_policy_version：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER distribution_policy_version_immutable BEFORE DELETE OR UPDATE ON zzsh_order.distribution_policy_version FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: settlement_ledger_entry earning_entry_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_entry_batch_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_earning_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'earningId'::text))) EXECUTE FUNCTION zzsh_order.check_earning_batch();


--
-- Name: settlement_ledger_entry earning_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_earning_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER earning_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'earningId'::text))) EXECUTE FUNCTION zzsh_order.guard_earning_entry();


--
-- Name: finance_event earning_event_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_event_batch_guard ON zzsh_order.finance_event：执行 zzsh_order.check_earning_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['EARNING_PENDING'::text, 'EARNING_SETTLED'::text, 'EARNING_REVOKED'::text]))) EXECUTE FUNCTION zzsh_order.check_earning_batch();


--
-- Name: finance_event earning_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_earning_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER earning_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['EARNING_PENDING'::text, 'EARNING_SETTLED'::text, 'EARNING_REVOKED'::text]))) EXECUTE FUNCTION zzsh_order.guard_earning_event();


--
-- Name: finance_event earning_event_reverse_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_event_reverse_guard ON zzsh_order.finance_event：执行 zzsh_order.check_earning_reverse_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_event_reverse_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['EARNING_PENDING'::text, 'EARNING_SETTLED'::text, 'EARNING_REVOKED'::text]))) EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();


--
-- Name: finance_economic_root earning_root_reverse_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_root_reverse_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.check_earning_reverse_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_root_reverse_guard AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_RENTAL_REFERRAL'::text)) EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();


--
-- Name: rental_referral_earning earning_state_reverse_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_state_reverse_guard ON zzsh_order.rental_referral_earning：执行 zzsh_order.check_earning_reverse_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_state_reverse_guard AFTER INSERT OR UPDATE ON zzsh_order.rental_referral_earning DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();


--
-- Name: rental_referral_transition earning_transition_reverse_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 earning_transition_reverse_guard ON zzsh_order.rental_referral_transition：执行 zzsh_order.check_earning_reverse_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER earning_transition_reverse_guard AFTER INSERT ON zzsh_order.rental_referral_transition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_earning_reverse_closure();


--
-- Name: finance_economic_root economic_root_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 economic_root_immutable ON zzsh_order.finance_economic_root：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER economic_root_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_economic_root FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: settlement_ledger_entry finance_entry_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_finance_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (NOT (new.details ? 'intentId'::text)) AND (NOT (new.details ? 'earningId'::text)) AND (NOT (new.details ? 'guaranteeId'::text)) AND (NOT (new.details ? 'legacyDutyId'::text)) AND (NOT (new.details ? 'nativeRefundIntentId'::text)) AND (NOT (new.details ? 'joinpayWithdrawalIntentId'::text)) AND (NOT (new.details ? 'abnormalRefundLiabilityId'::text)) AND (NOT (new.details ? 'prestartTerminationId'::text)))) EXECUTE FUNCTION zzsh_order.check_finance_batch();


--
-- Name: settlement_ledger_entry finance_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_finance_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (NOT (new.details ? 'intentId'::text)) AND (NOT (new.details ? 'earningId'::text)) AND (NOT (new.details ? 'guaranteeId'::text)) AND (NOT (new.details ? 'legacyDutyId'::text)) AND (NOT (new.details ? 'nativeRefundIntentId'::text)) AND (NOT (new.details ? 'joinpayWithdrawalIntentId'::text)) AND (NOT (new.details ? 'abnormalRefundLiabilityId'::text)) AND (NOT (new.details ? 'prestartTerminationId'::text)))) EXECUTE FUNCTION zzsh_order.guard_finance_entry();


--
-- Name: finance_event finance_event_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_event_batch_guard ON zzsh_order.finance_event：执行 zzsh_order.check_finance_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER finance_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'OPENING'::text)) EXECUTE FUNCTION zzsh_order.check_finance_batch();


--
-- Name: finance_event finance_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_finance_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'OPENING'::text)) EXECUTE FUNCTION zzsh_order.guard_finance_event();


--
-- Name: finance_event finance_event_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_event_immutable ON zzsh_order.finance_event：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_event_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_event finance_event_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_event_revision ON zzsh_order.finance_event：执行 zzsh_order.finance_event_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_event_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'OPENING'::text)) EXECUTE FUNCTION zzsh_order.finance_event_wallet_revision();


--
-- Name: personal_finance_observation finance_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_observation_guard ON zzsh_order.personal_finance_observation：执行 zzsh_order.guard_finance_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_observation_guard BEFORE INSERT ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_observation();


--
-- Name: personal_finance_observation finance_observation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_observation_immutable ON zzsh_order.personal_finance_observation：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_observation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_economic_root finance_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 finance_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_finance_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER finance_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'LEGACY_OPENING'::text)) EXECUTE FUNCTION zzsh_order.guard_finance_root();


--
-- Name: settlement_ledger_entry guarantee_entry_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 guarantee_entry_batch_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_guarantee_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER guarantee_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'guaranteeId'::text))) EXECUTE FUNCTION zzsh_order.check_guarantee_batch();


--
-- Name: settlement_ledger_entry guarantee_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 guarantee_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_guarantee_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER guarantee_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'guaranteeId'::text))) EXECUTE FUNCTION zzsh_order.guard_guarantee_entry();


--
-- Name: finance_event guarantee_event_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 guarantee_event_batch_guard ON zzsh_order.finance_event：执行 zzsh_order.check_guarantee_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER guarantee_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['GUARANTEE_CAPTURE'::text, 'GUARANTEE_REFUND'::text]))) EXECUTE FUNCTION zzsh_order.check_guarantee_batch();


--
-- Name: finance_event guarantee_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 guarantee_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_guarantee_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER guarantee_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['GUARANTEE_CAPTURE'::text, 'GUARANTEE_REFUND'::text]))) EXECUTE FUNCTION zzsh_order.guard_guarantee_event();


--
-- Name: finance_economic_root guarantee_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 guarantee_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_guarantee_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER guarantee_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_GUARANTEE'::text)) EXECUTE FUNCTION zzsh_order.guard_guarantee_root();


--
-- Name: personal_finance_observation_coverage history_coverage_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 history_coverage_guard ON zzsh_order.personal_finance_observation_coverage：执行 zzsh_order.guard_finance_history_coverage。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER history_coverage_guard BEFORE INSERT ON zzsh_order.personal_finance_observation_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_history_coverage();


--
-- Name: personal_finance_observation_coverage history_coverage_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 history_coverage_immutable ON zzsh_order.personal_finance_observation_coverage：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER history_coverage_immutable BEFORE DELETE OR UPDATE ON zzsh_order.personal_finance_observation_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: personal_finance_observation_coverage history_coverage_read_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 history_coverage_read_revision ON zzsh_order.personal_finance_observation_coverage：执行 zzsh_order.finance_history_coverage_read_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER history_coverage_read_revision AFTER INSERT ON zzsh_order.personal_finance_observation_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_history_coverage_read_revision();


--
-- Name: im_order_event im_order_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_event_guard ON zzsh_order.im_order_event：执行 zzsh_order.guard_order_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_event_guard BEFORE DELETE OR UPDATE ON zzsh_order.im_order_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_event();


--
-- Name: im_order_group im_order_group_dispatch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_group_dispatch_guard ON zzsh_order.im_order_group：执行 zzsh_order.guard_im_order_dispatch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_group_dispatch_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.im_order_group FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_im_order_dispatch();


--
-- Name: im_order_group im_order_group_first_response_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_group_first_response_guard ON zzsh_order.im_order_group：执行 zzsh_order.guard_first_response_binding。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_group_first_response_guard BEFORE INSERT OR UPDATE ON zzsh_order.im_order_group FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_first_response_binding();


--
-- Name: im_order_group im_order_group_responsible_fill; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_group_responsible_fill ON zzsh_order.im_order_group：执行 zzsh_order.fill_order_responsible。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_group_responsible_fill BEFORE INSERT OR UPDATE ON zzsh_order.im_order_group FOR EACH ROW EXECUTE FUNCTION zzsh_order.fill_order_responsible();


--
-- Name: im_order_group im_order_group_responsible_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_group_responsible_guard ON zzsh_order.im_order_group：执行 zzsh_order.guard_order_responsible。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_group_responsible_guard BEFORE UPDATE OF responsible_admin_id ON zzsh_order.im_order_group FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_responsible();


--
-- Name: im_order_member im_order_member_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_member_guard ON zzsh_order.im_order_member：执行 zzsh_order.guard_order_member。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_member_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.im_order_member FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_member();


--
-- Name: im_order_member im_order_member_joined_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_member_joined_guard ON zzsh_order.im_order_member：执行 zzsh_order.check_order_member_joined。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER im_order_member_joined_guard AFTER INSERT OR UPDATE ON zzsh_order.im_order_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_member_joined();


--
-- Name: im_order_operation im_order_operation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_operation_guard ON zzsh_order.im_order_operation：执行 zzsh_order.guard_order_operation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER im_order_operation_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.im_order_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_operation();


--
-- Name: im_order_operation im_order_operation_success_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_operation_success_guard ON zzsh_order.im_order_operation：执行 zzsh_order.check_order_operation_success。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER im_order_operation_success_guard AFTER UPDATE ON zzsh_order.im_order_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_operation_success();


--
-- Name: im_order_group im_order_team_ready_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 im_order_team_ready_guard ON zzsh_order.im_order_group：执行 zzsh_order.check_order_team_ready。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER im_order_team_ready_guard AFTER UPDATE ON zzsh_order.im_order_group DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_team_ready();


--
-- Name: invitation_relation invitation_relation_cycle_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 invitation_relation_cycle_guard ON zzsh_order.invitation_relation：执行 zzsh_order.guard_invitation_relation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER invitation_relation_cycle_guard BEFORE INSERT ON zzsh_order.invitation_relation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_invitation_relation();


--
-- Name: invitation_relation invitation_relation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 invitation_relation_immutable ON zzsh_order.invitation_relation：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER invitation_relation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.invitation_relation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: invitation_relation invitation_relation_knowledge_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 invitation_relation_knowledge_guard ON zzsh_order.invitation_relation：执行 zzsh_order.check_distribution_relation_knowledge。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER invitation_relation_knowledge_guard AFTER INSERT ON zzsh_order.invitation_relation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();


--
-- Name: invitation_relation invitation_relation_source_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 invitation_relation_source_guard ON zzsh_order.invitation_relation：执行 zzsh_order.guard_native_invitation_source。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER invitation_relation_source_guard BEFORE INSERT ON zzsh_order.invitation_relation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_native_invitation_source();


--
-- Name: joinpay_account_observation joinpay_account_observation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_account_observation_immutable ON zzsh_order.joinpay_account_observation：执行 zzsh_order.guard_joinpay_account_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_account_observation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_account_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_account_observation();


--
-- Name: joinpay_account_observation joinpay_account_observation_insert; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_account_observation_insert ON zzsh_order.joinpay_account_observation：执行 zzsh_order.guard_joinpay_account_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_account_observation_insert BEFORE INSERT ON zzsh_order.joinpay_account_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_account_observation();


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_attempt_append_only ON zzsh_order.joinpay_collection_attempt：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_attempt_append_only BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_collection_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_attempt_guard ON zzsh_order.joinpay_collection_attempt：执行 zzsh_order.guard_joinpay_collection_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_collection_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();


--
-- Name: joinpay_collection_binding joinpay_collection_binding_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_binding_append_only ON zzsh_order.joinpay_collection_binding：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_binding_append_only BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_collection_binding FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: joinpay_collection_binding joinpay_collection_binding_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_binding_guard ON zzsh_order.joinpay_collection_binding：执行 zzsh_order.guard_joinpay_collection_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_insert();


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_evidence_append_only ON zzsh_order.joinpay_collection_evidence：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_evidence_append_only BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_collection_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_evidence_guard ON zzsh_order.joinpay_collection_evidence：执行 zzsh_order.guard_joinpay_collection_evidence。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_collection_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_evidence();


--
-- Name: joinpay_collection_observation joinpay_collection_observation_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_observation_append_only ON zzsh_order.joinpay_collection_observation：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_observation_append_only BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_collection_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: joinpay_collection_observation joinpay_collection_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_observation_guard ON zzsh_order.joinpay_collection_observation：执行 zzsh_order.guard_joinpay_collection_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_observation_guard BEFORE INSERT ON zzsh_order.joinpay_collection_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_observation();


--
-- Name: payment_request joinpay_collection_request_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_request_closure ON zzsh_order.payment_request：执行 zzsh_order.check_joinpay_collection_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_collection_request_closure AFTER INSERT OR UPDATE ON zzsh_order.payment_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_collection_closure();


--
-- Name: payment_request joinpay_collection_request_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_collection_request_guard ON zzsh_order.payment_request：执行 zzsh_order.guard_joinpay_collection_request。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_collection_request_guard BEFORE UPDATE ON zzsh_order.payment_request FOR EACH ROW WHEN ((old.evidence_level = 'JOINPAY_CANDIDATE'::text)) EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_request();


--
-- Name: payment_channel_transaction joinpay_formal_anchor_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_formal_anchor_guard ON zzsh_order.payment_channel_transaction：执行 zzsh_order.guard_joinpay_formal_anchor。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_formal_anchor_guard BEFORE INSERT ON zzsh_order.payment_channel_transaction FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_anchor();


--
-- Name: joinpay_collection_binding joinpay_formal_binding_admission_pair; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_formal_binding_admission_pair ON zzsh_order.joinpay_collection_binding：执行 zzsh_order.check_joinpay_native_admission_pair。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_formal_binding_admission_pair AFTER INSERT ON zzsh_order.joinpay_collection_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();


--
-- Name: joinpay_collection_binding joinpay_formal_binding_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_formal_binding_guard ON zzsh_order.joinpay_collection_binding：执行 zzsh_order.guard_joinpay_formal_binding。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_formal_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_binding();


--
-- Name: payment_confirmation joinpay_formal_confirmation_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_formal_confirmation_closure ON zzsh_order.payment_confirmation：执行 zzsh_order.check_joinpay_formal_confirmation_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_formal_confirmation_closure AFTER INSERT ON zzsh_order.payment_confirmation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure();


--
-- Name: payment_confirmation joinpay_formal_confirmation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_formal_confirmation_guard ON zzsh_order.payment_confirmation：执行 zzsh_order.guard_joinpay_formal_confirmation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_formal_confirmation_guard BEFORE INSERT ON zzsh_order.payment_confirmation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_confirmation();


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_attempt_closure ON zzsh_order.joinpay_payout_attempt：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_payout_attempt_closure AFTER INSERT ON zzsh_order.joinpay_payout_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_attempt_guard ON zzsh_order.joinpay_payout_attempt：执行 zzsh_order.guard_joinpay_payout_attempt。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_payout_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_attempt();


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_attempt_immutable ON zzsh_order.joinpay_payout_attempt：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_attempt_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_payout_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_evidence_closure ON zzsh_order.joinpay_payout_evidence：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_payout_evidence_closure AFTER INSERT ON zzsh_order.joinpay_payout_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_evidence_guard ON zzsh_order.joinpay_payout_evidence：执行 zzsh_order.guard_joinpay_payout_evidence。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_payout_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_evidence();


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_evidence_immutable ON zzsh_order.joinpay_payout_evidence：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_evidence_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_payout_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: joinpay_payout_observation joinpay_payout_observation_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_observation_closure ON zzsh_order.joinpay_payout_observation：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_payout_observation_closure AFTER INSERT ON zzsh_order.joinpay_payout_observation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: joinpay_payout_observation joinpay_payout_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_observation_guard ON zzsh_order.joinpay_payout_observation：执行 zzsh_order.guard_joinpay_payout_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_observation_guard BEFORE INSERT ON zzsh_order.joinpay_payout_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_observation();


--
-- Name: joinpay_payout_observation joinpay_payout_observation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_observation_immutable ON zzsh_order.joinpay_payout_observation：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_observation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_payout_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: joinpay_payout_observation joinpay_payout_observation_read_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_payout_observation_read_revision ON zzsh_order.joinpay_payout_observation：执行 zzsh_order.joinpay_payout_observation_read_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_payout_observation_read_revision AFTER INSERT ON zzsh_order.joinpay_payout_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.joinpay_payout_observation_read_revision();


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_attempt_guard ON zzsh_order.joinpay_refund_attempt：执行 zzsh_order.guard_joinpay_refund_attempt。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_refund_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_attempt();


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_attempt_immutable ON zzsh_order.joinpay_refund_attempt：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_attempt_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_refund_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_evidence_guard ON zzsh_order.joinpay_refund_evidence：执行 zzsh_order.guard_joinpay_refund_evidence。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_refund_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_evidence();


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_evidence_immutable ON zzsh_order.joinpay_refund_evidence：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_evidence_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_refund_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: joinpay_refund_observation joinpay_refund_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_observation_guard ON zzsh_order.joinpay_refund_observation：执行 zzsh_order.guard_joinpay_refund_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_observation_guard BEFORE INSERT ON zzsh_order.joinpay_refund_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_observation();


--
-- Name: joinpay_refund_observation joinpay_refund_observation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_refund_observation_immutable ON zzsh_order.joinpay_refund_observation：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_refund_observation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.joinpay_refund_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: settlement_ledger_entry joinpay_withdrawal_entry_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_entry_closure ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'joinpayWithdrawalIntentId'::text))) EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: settlement_ledger_entry joinpay_withdrawal_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_joinpay_withdrawal_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'joinpayWithdrawalIntentId'::text))) EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_entry();


--
-- Name: finance_event joinpay_withdrawal_event_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_event_closure ON zzsh_order.finance_event：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['JOINPAY_WITHDRAWAL_RESERVED'::text, 'JOINPAY_WITHDRAWAL_PAID'::text, 'JOINPAY_WITHDRAWAL_RELEASED'::text]))) EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: finance_event joinpay_withdrawal_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_joinpay_withdrawal_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['JOINPAY_WITHDRAWAL_RESERVED'::text, 'JOINPAY_WITHDRAWAL_PAID'::text, 'JOINPAY_WITHDRAWAL_RELEASED'::text]))) EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_event();


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_intent_closure ON zzsh_order.joinpay_withdrawal_intent：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_intent_closure AFTER INSERT OR UPDATE ON zzsh_order.joinpay_withdrawal_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_intent_guard ON zzsh_order.joinpay_withdrawal_intent：执行 zzsh_order.guard_joinpay_withdrawal_intent。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_intent_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.joinpay_withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_intent();


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_read_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_read_revision ON zzsh_order.joinpay_withdrawal_intent：执行 zzsh_order.withdrawal_read_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_read_revision AFTER UPDATE ON zzsh_order.joinpay_withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_read_revision();


--
-- Name: finance_economic_root joinpay_withdrawal_root_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_root_closure ON zzsh_order.finance_economic_root：执行 zzsh_order.check_joinpay_withdrawal_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_root_closure AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'JOINPAY_WITHDRAWAL'::text)) EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();


--
-- Name: finance_economic_root joinpay_withdrawal_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_joinpay_withdrawal_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'JOINPAY_WITHDRAWAL'::text)) EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_root();


--
-- Name: finance_event joinpay_withdrawal_wallet_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 joinpay_withdrawal_wallet_revision ON zzsh_order.finance_event：执行 zzsh_order.withdrawal_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER joinpay_withdrawal_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['JOINPAY_WITHDRAWAL_RESERVED'::text, 'JOINPAY_WITHDRAWAL_PAID'::text, 'JOINPAY_WITHDRAWAL_RELEASED'::text]))) EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();


--
-- Name: settlement_ledger_entry ledger_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 ledger_immutable ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER ledger_immutable BEFORE DELETE OR UPDATE ON zzsh_order.settlement_ledger_entry FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: legacy_order_duty_admission legacy_duty_admission_complete; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_admission_complete ON zzsh_order.legacy_order_duty_admission：执行 zzsh_order.check_legacy_duty_admission。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_duty_admission_complete AFTER INSERT ON zzsh_order.legacy_order_duty_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_admission();


--
-- Name: legacy_order_duty_admission legacy_duty_admission_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_admission_immutable ON zzsh_order.legacy_order_duty_admission：执行 zzsh_order.guard_legacy_continuation_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_admission_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_order_duty_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();


--
-- Name: legacy_duty_finance_contract legacy_duty_contract_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_contract_immutable ON zzsh_order.legacy_duty_finance_contract：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_contract_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_duty_finance_contract FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: settlement_ledger_entry legacy_duty_entry_batch; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_entry_batch ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_legacy_duty_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_duty_entry_batch AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'legacyDutyId'::text))) EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();


--
-- Name: settlement_ledger_entry legacy_duty_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_legacy_duty_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'legacyDutyId'::text))) EXECUTE FUNCTION zzsh_order.guard_legacy_duty_entry();


--
-- Name: finance_event legacy_duty_event_batch; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_event_batch ON zzsh_order.finance_event：执行 zzsh_order.check_legacy_duty_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_duty_event_batch AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'LEGACY_DUTY_SETTLED'::text)) EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();


--
-- Name: finance_event legacy_duty_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_legacy_duty_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'LEGACY_DUTY_SETTLED'::text)) EXECUTE FUNCTION zzsh_order.guard_legacy_duty_event();


--
-- Name: legacy_duty_finance_fact legacy_duty_fact_batch; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_fact_batch ON zzsh_order.legacy_duty_finance_fact：执行 zzsh_order.check_legacy_duty_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_duty_fact_batch AFTER INSERT ON zzsh_order.legacy_duty_finance_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();


--
-- Name: legacy_duty_finance_fact legacy_duty_fact_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_fact_guard ON zzsh_order.legacy_duty_finance_fact：执行 zzsh_order.guard_legacy_duty_finance_fact。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_fact_guard BEFORE INSERT ON zzsh_order.legacy_duty_finance_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_duty_finance_fact();


--
-- Name: legacy_duty_finance_fact legacy_duty_fact_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_fact_immutable ON zzsh_order.legacy_duty_finance_fact：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_fact_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_duty_finance_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: legacy_order_duty legacy_duty_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_guard ON zzsh_order.legacy_order_duty：执行 zzsh_order.guard_legacy_duty。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.legacy_order_duty FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_duty();


--
-- Name: legacy_order_duty legacy_duty_revision_complete; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_revision_complete ON zzsh_order.legacy_order_duty：执行 zzsh_order.check_legacy_duty_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_duty_revision_complete AFTER UPDATE ON zzsh_order.legacy_order_duty DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_revision();


--
-- Name: legacy_order_duty_revision legacy_duty_revision_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_revision_immutable ON zzsh_order.legacy_order_duty_revision：执行 zzsh_order.guard_legacy_continuation_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_revision_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_order_duty_revision FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();


--
-- Name: finance_economic_root legacy_duty_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_legacy_duty_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'LEGACY_CONTINUATION_DUTY'::text)) EXECUTE FUNCTION zzsh_order.guard_legacy_duty_root();


--
-- Name: finance_event legacy_duty_wallet_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_duty_wallet_revision ON zzsh_order.finance_event：执行 zzsh_order.withdrawal_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_duty_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'LEGACY_DUTY_SETTLED'::text)) EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();


--
-- Name: legacy_continuation_evidence legacy_evidence_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_evidence_immutable ON zzsh_order.legacy_continuation_evidence：执行 zzsh_order.guard_legacy_continuation_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_evidence_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_continuation_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();


--
-- Name: legacy_owner_guarantee_coverage legacy_guarantee_coverage_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_guarantee_coverage_guard ON zzsh_order.legacy_owner_guarantee_coverage：执行 zzsh_order.guard_legacy_guarantee_coverage。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_guarantee_coverage_guard BEFORE INSERT ON zzsh_order.legacy_owner_guarantee_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_guarantee_coverage();


--
-- Name: legacy_owner_guarantee_coverage legacy_guarantee_coverage_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_guarantee_coverage_immutable ON zzsh_order.legacy_owner_guarantee_coverage：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_guarantee_coverage_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_owner_guarantee_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: legacy_owner_guarantee_observation legacy_guarantee_observation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_guarantee_observation_guard ON zzsh_order.legacy_owner_guarantee_observation：执行 zzsh_order.guard_legacy_guarantee_observation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_guarantee_observation_guard BEFORE INSERT ON zzsh_order.legacy_owner_guarantee_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_guarantee_observation();


--
-- Name: legacy_owner_guarantee_observation legacy_guarantee_observation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_guarantee_observation_immutable ON zzsh_order.legacy_owner_guarantee_observation：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_guarantee_observation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_owner_guarantee_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: legacy_continuation_version legacy_head_update; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_head_update ON zzsh_order.legacy_continuation_version：执行 zzsh_order.guard_legacy_continuation_head。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_head_update BEFORE DELETE OR UPDATE ON zzsh_order.legacy_continuation_version FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_head();


--
-- Name: legacy_inflight_register legacy_inflight_register_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_inflight_register_immutable ON zzsh_order.legacy_inflight_register：执行 zzsh_order.guard_legacy_continuation_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_inflight_register_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_inflight_register FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();


--
-- Name: legacy_order_read_snapshot legacy_order_read_audit; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_order_read_audit ON zzsh_order.legacy_order_read_snapshot：执行 zzsh_order.check_legacy_order_read_audit。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_order_read_audit AFTER INSERT ON zzsh_order.legacy_order_read_snapshot DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_order_read_audit();


--
-- Name: legacy_order_read_snapshot legacy_order_read_binding; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_order_read_binding ON zzsh_order.legacy_order_read_snapshot：执行 zzsh_order.guard_legacy_order_read_binding。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_order_read_binding BEFORE INSERT ON zzsh_order.legacy_order_read_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_order_read_binding();


--
-- Name: legacy_order_read_snapshot legacy_order_read_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_order_read_immutable ON zzsh_order.legacy_order_read_snapshot：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_order_read_immutable BEFORE DELETE OR UPDATE ON zzsh_order.legacy_order_read_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: legacy_continuation_version legacy_result_complete; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 legacy_result_complete ON zzsh_order.legacy_continuation_version：执行 zzsh_order.check_legacy_continuation_result。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER legacy_result_complete AFTER INSERT ON zzsh_order.legacy_continuation_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_continuation_result();


--
-- Name: rental_order manual_close_order_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 manual_close_order_guard ON zzsh_order.rental_order：执行 zzsh_order.guard_manual_close_order。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER manual_close_order_guard BEFORE UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_manual_close_order();


--
-- Name: distribution_order_admission native_admission_formal_binding_pair; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_admission_formal_binding_pair ON zzsh_order.distribution_order_admission：执行 zzsh_order.check_joinpay_native_admission_pair。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_admission_formal_binding_pair AFTER INSERT ON zzsh_order.distribution_order_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();


--
-- Name: finance_economic_root native_earning_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_earning_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_native_earning_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_earning_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_RENTAL_REFERRAL'::text)) EXECUTE FUNCTION zzsh_order.guard_native_earning_root();


--
-- Name: distribution_invite_code native_invite_code_proof; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_invite_code_proof ON zzsh_order.distribution_invite_code：执行 zzsh_order.guard_native_invite_code_proof。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_invite_code_proof BEFORE INSERT ON zzsh_order.distribution_invite_code FOR EACH ROW WHEN ((new.source_type = 'NATIVE_REGISTRATION'::text)) EXECUTE FUNCTION zzsh_order.guard_native_invite_code_proof();


--
-- Name: finance_opening_basis native_origin_basis_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_basis_guard ON zzsh_order.finance_opening_basis：执行 zzsh_order.guard_native_origin_basis。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_origin_basis_guard BEFORE INSERT ON zzsh_order.finance_opening_basis FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_GENESIS'::text)) EXECUTE FUNCTION zzsh_order.guard_native_origin_basis();


--
-- Name: finance_opening_basis native_origin_complete_batch; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_complete_batch ON zzsh_order.finance_opening_basis：执行 zzsh_order.check_native_origin_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_origin_complete_batch AFTER INSERT ON zzsh_order.finance_opening_basis DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_GENESIS'::text)) EXECUTE FUNCTION zzsh_order.check_native_origin_closure();


--
-- Name: finance_opening_basis native_origin_excludes_legacy_basis; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_excludes_legacy_basis ON zzsh_order.finance_opening_basis：执行 zzsh_order.check_native_origin_excludes_legacy。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_origin_excludes_legacy_basis AFTER INSERT ON zzsh_order.finance_opening_basis DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_GENESIS'::text)) EXECUTE FUNCTION zzsh_order.check_native_origin_excludes_legacy();


--
-- Name: native_origin_resource_admission native_origin_resource_admission_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_resource_admission_immutable ON zzsh_order.native_origin_resource_admission：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_origin_resource_admission_immutable BEFORE DELETE OR UPDATE ON zzsh_order.native_origin_resource_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: native_origin_resource_admission native_origin_resource_admission_no_truncate; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_resource_admission_no_truncate ON zzsh_order.native_origin_resource_admission：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_origin_resource_admission_no_truncate BEFORE TRUNCATE ON zzsh_order.native_origin_resource_admission FOR EACH STATEMENT EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_economic_root native_origin_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_origin_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_native_origin_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_origin_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_GENESIS'::text)) EXECUTE FUNCTION zzsh_order.guard_native_origin_root();


--
-- Name: settlement_ledger_entry native_refund_entry_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_entry_closure ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'nativeRefundIntentId'::text))) EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: settlement_ledger_entry native_refund_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_native_refund_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_refund_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (((new.finance_event_id IS NOT NULL) AND (new.details ? 'nativeRefundIntentId'::text))) EXECUTE FUNCTION zzsh_order.guard_native_refund_entry();


--
-- Name: finance_event native_refund_event_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_event_closure ON zzsh_order.finance_event：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'REFUND_PAID'::text)) EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: finance_event native_refund_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_native_refund_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_refund_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'REFUND_PAID'::text)) EXECUTE FUNCTION zzsh_order.guard_native_refund_event();


--
-- Name: joinpay_refund_evidence native_refund_evidence_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_evidence_closure ON zzsh_order.joinpay_refund_evidence：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_evidence_closure AFTER INSERT ON zzsh_order.joinpay_refund_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: channel_refund_intent native_refund_intent_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_intent_closure ON zzsh_order.channel_refund_intent：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_intent_closure AFTER INSERT OR UPDATE ON zzsh_order.channel_refund_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.payment_source = 'JOINPAY'::text)) EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: joinpay_refund_observation native_refund_observation_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_observation_closure ON zzsh_order.joinpay_refund_observation：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_observation_closure AFTER INSERT ON zzsh_order.joinpay_refund_observation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: finance_economic_root native_refund_root_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_root_closure ON zzsh_order.finance_economic_root：执行 zzsh_order.check_native_refund_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER native_refund_root_closure AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_RENTAL_REFUND'::text)) EXECUTE FUNCTION zzsh_order.check_native_refund_closure();


--
-- Name: finance_economic_root native_refund_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_native_refund_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_refund_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_RENTAL_REFUND'::text)) EXECUTE FUNCTION zzsh_order.guard_native_refund_root();


--
-- Name: finance_event native_refund_wallet_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_refund_wallet_revision ON zzsh_order.finance_event：执行 zzsh_order.withdrawal_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_refund_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = 'REFUND_PAID'::text)) EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();


--
-- Name: settlement_posting native_settlement_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_settlement_revision ON zzsh_order.settlement_posting：执行 zzsh_order.native_settlement_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_settlement_revision AFTER INSERT ON zzsh_order.settlement_posting FOR EACH ROW EXECUTE FUNCTION zzsh_order.native_settlement_wallet_revision();


--
-- Name: native_user_insert_proof native_user_insert_proof_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_user_insert_proof_immutable ON zzsh_order.native_user_insert_proof：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_user_insert_proof_immutable BEFORE DELETE OR UPDATE ON zzsh_order.native_user_insert_proof FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: native_user_insert_proof native_user_insert_proof_issuer; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_user_insert_proof_issuer ON zzsh_order.native_user_insert_proof：执行 zzsh_order.guard_native_user_insert_proof。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_user_insert_proof_issuer BEFORE INSERT ON zzsh_order.native_user_insert_proof FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_native_user_insert_proof();


--
-- Name: native_user_insert_proof native_user_insert_proof_no_truncate; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 native_user_insert_proof_no_truncate ON zzsh_order.native_user_insert_proof：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER native_user_insert_proof_no_truncate BEFORE TRUNCATE ON zzsh_order.native_user_insert_proof FOR EACH STATEMENT EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_observation_admission observation_admission_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 observation_admission_guard ON zzsh_order.finance_observation_admission：执行 zzsh_order.guard_observation_admission。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER observation_admission_guard BEFORE INSERT ON zzsh_order.finance_observation_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_observation_admission();


--
-- Name: finance_observation_admission observation_admission_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 observation_admission_immutable ON zzsh_order.finance_observation_admission：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER observation_admission_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_observation_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_opening_basis opening_basis_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 opening_basis_guard ON zzsh_order.finance_opening_basis：执行 zzsh_order.guard_opening_basis。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER opening_basis_guard BEFORE INSERT ON zzsh_order.finance_opening_basis FOR EACH ROW WHEN ((new.source_kind = 'LEGACY_OPENING'::text)) EXECUTE FUNCTION zzsh_order.guard_opening_basis();


--
-- Name: finance_opening_basis opening_basis_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 opening_basis_immutable ON zzsh_order.finance_opening_basis：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER opening_basis_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_opening_basis FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_opening_basis opening_coverage_set_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 opening_coverage_set_guard ON zzsh_order.finance_opening_basis：执行 zzsh_order.check_opening_coverage_set。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER opening_coverage_set_guard AFTER INSERT ON zzsh_order.finance_opening_basis DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_opening_coverage_set();


--
-- Name: payment_channel_observation payment_channel_observation_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_channel_observation_append_only ON zzsh_order.payment_channel_observation：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_channel_observation_append_only BEFORE DELETE OR UPDATE ON zzsh_order.payment_channel_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: payment_channel_transaction payment_channel_transaction_append_only; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_channel_transaction_append_only ON zzsh_order.payment_channel_transaction：执行 zzsh_order.guard_channel_payment_append_only。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_channel_transaction_append_only BEFORE DELETE OR UPDATE ON zzsh_order.payment_channel_transaction FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();


--
-- Name: payment_channel_transaction payment_channel_transaction_confirmation_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_channel_transaction_confirmation_guard ON zzsh_order.payment_channel_transaction：执行 zzsh_order.check_channel_transaction_confirmation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER payment_channel_transaction_confirmation_guard AFTER INSERT ON zzsh_order.payment_channel_transaction DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_channel_transaction_confirmation();


--
-- Name: payment_confirmation payment_confirmation_applied_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_confirmation_applied_guard ON zzsh_order.payment_confirmation：执行 zzsh_order.check_applied_payment。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER payment_confirmation_applied_guard AFTER INSERT ON zzsh_order.payment_confirmation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_applied_payment();


--
-- Name: payment_confirmation payment_confirmation_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_confirmation_immutable ON zzsh_order.payment_confirmation：执行 zzsh_order.guard_payment_fact。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_confirmation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.payment_confirmation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_fact();


--
-- Name: payment_distribution_basis payment_distribution_basis_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_distribution_basis_guard ON zzsh_order.payment_distribution_basis：执行 zzsh_order.guard_payment_distribution_basis。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_distribution_basis_guard BEFORE INSERT ON zzsh_order.payment_distribution_basis FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_distribution_basis();


--
-- Name: payment_distribution_basis payment_distribution_basis_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_distribution_basis_immutable ON zzsh_order.payment_distribution_basis：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_distribution_basis_immutable BEFORE DELETE OR UPDATE ON zzsh_order.payment_distribution_basis FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: payment_request payment_request_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_request_guard ON zzsh_order.payment_request：执行 zzsh_order.guard_payment_request。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_request_guard BEFORE DELETE OR UPDATE ON zzsh_order.payment_request FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request();


--
-- Name: payment_request payment_request_insert_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 payment_request_insert_guard ON zzsh_order.payment_request：执行 zzsh_order.guard_payment_request_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER payment_request_insert_guard BEFORE INSERT ON zzsh_order.payment_request FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_request_insert();


--
-- Name: prestart_termination_decision prestart_decision_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_decision_closure ON zzsh_order.prestart_termination_decision：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_decision_closure AFTER INSERT ON zzsh_order.prestart_termination_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: prestart_termination_decision prestart_decision_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_decision_guard ON zzsh_order.prestart_termination_decision：执行 zzsh_order.guard_prestart_termination_decision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_decision_guard BEFORE INSERT ON zzsh_order.prestart_termination_decision FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_termination_decision();


--
-- Name: prestart_termination_decision prestart_decision_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_decision_immutable ON zzsh_order.prestart_termination_decision：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_decision_immutable BEFORE DELETE OR UPDATE ON zzsh_order.prestart_termination_decision FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: settlement_ledger_entry prestart_entry_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_entry_closure ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.details ? 'prestartTerminationId'::text)) EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: finance_event prestart_event_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_event_closure ON zzsh_order.finance_event：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'REFUND_LIABILITY_RECOGNIZED'::text)) EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: settlement_ledger_entry prestart_liability_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_liability_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_prestart_liability_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_liability_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN ((new.details ? 'prestartTerminationId'::text)) EXECUTE FUNCTION zzsh_order.guard_prestart_liability_entry();


--
-- Name: finance_event prestart_liability_event_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_liability_event_guard ON zzsh_order.finance_event：执行 zzsh_order.guard_prestart_liability_event。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_liability_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_liability_event();


--
-- Name: finance_economic_root prestart_liability_root_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_liability_root_guard ON zzsh_order.finance_economic_root：执行 zzsh_order.guard_prestart_liability_root。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_liability_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_PRESTART_REFUND'::text)) EXECUTE FUNCTION zzsh_order.guard_prestart_liability_root();


--
-- Name: rental_opening_ack prestart_opening_ack_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_opening_ack_guard ON zzsh_order.rental_opening_ack：执行 zzsh_order.guard_prestart_opening。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_opening_ack_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_opening_ack FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_opening();


--
-- Name: rental_opening prestart_opening_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_opening_guard ON zzsh_order.rental_opening：执行 zzsh_order.guard_prestart_opening。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_opening_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_opening FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_opening();


--
-- Name: rental_order prestart_order_cancel_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_order_cancel_guard ON zzsh_order.rental_order：执行 zzsh_order.guard_prestart_order_cancel。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_order_cancel_guard BEFORE UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_order_cancel();


--
-- Name: rental_order prestart_order_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_order_closure ON zzsh_order.rental_order：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_order_closure AFTER UPDATE ON zzsh_order.rental_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.cancel_reason = ANY (ARRAY['PRESTART_TERMINATED'::text, 'SUPPORT_CANCELLED_REFUND'::text]))) EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: prestart_termination prestart_request_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_request_closure ON zzsh_order.prestart_termination：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_request_closure AFTER INSERT OR UPDATE ON zzsh_order.prestart_termination DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: finance_economic_root prestart_root_closure; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_root_closure ON zzsh_order.finance_economic_root：执行 zzsh_order.check_prestart_termination_closure。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER prestart_root_closure AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_kind = 'NATIVE_PRESTART_REFUND'::text)) EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();


--
-- Name: prestart_termination prestart_termination_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 prestart_termination_guard ON zzsh_order.prestart_termination：执行 zzsh_order.guard_prestart_termination。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER prestart_termination_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.prestart_termination FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_termination();


--
-- Name: rental_referral_transition referral_debt_read_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 referral_debt_read_revision ON zzsh_order.rental_referral_transition：执行 zzsh_order.referral_debt_read_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER referral_debt_read_revision AFTER INSERT ON zzsh_order.rental_referral_transition FOR EACH ROW WHEN ((new.finance_event_id IS NULL)) EXECUTE FUNCTION zzsh_order.referral_debt_read_revision();


--
-- Name: rental_referral_reversal_source referral_reversal_declaration_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 referral_reversal_declaration_guard ON zzsh_order.rental_referral_reversal_source：执行 zzsh_order.guard_referral_reversal_declaration。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER referral_reversal_declaration_guard BEFORE INSERT ON zzsh_order.rental_referral_reversal_source FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_reversal_declaration();


--
-- Name: rental_referral_reversal_source referral_reversal_source_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 referral_reversal_source_immutable ON zzsh_order.rental_referral_reversal_source：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER referral_reversal_source_immutable BEFORE DELETE OR UPDATE ON zzsh_order.rental_referral_reversal_source FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: rental_referral_transition referral_transition_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 referral_transition_immutable ON zzsh_order.rental_referral_transition：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER referral_transition_immutable BEFORE DELETE OR UPDATE ON zzsh_order.rental_referral_transition FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: rental_referral_transition referral_transition_source_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 referral_transition_source_guard ON zzsh_order.rental_referral_transition：执行 zzsh_order.guard_referral_transition_source。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER referral_transition_source_guard BEFORE INSERT ON zzsh_order.rental_referral_transition FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_transition_source();


--
-- Name: rental_opening_ack rental_opening_ack_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_opening_ack_guard ON zzsh_order.rental_opening_ack：执行 zzsh_order.guard_opening_ack。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_opening_ack_guard BEFORE DELETE OR UPDATE ON zzsh_order.rental_opening_ack FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_opening_ack();


--
-- Name: rental_opening rental_opening_auto_confirm_due_set; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_opening_auto_confirm_due_set ON zzsh_order.rental_opening：执行 zzsh_order.set_rental_opening_auto_confirm_due。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_opening_auto_confirm_due_set BEFORE INSERT ON zzsh_order.rental_opening FOR EACH ROW EXECUTE FUNCTION zzsh_order.set_rental_opening_auto_confirm_due();


--
-- Name: rental_opening rental_opening_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_opening_guard ON zzsh_order.rental_opening：执行 zzsh_order.guard_rental_opening。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_opening_guard BEFORE DELETE OR UPDATE ON zzsh_order.rental_opening FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_rental_opening();


--
-- Name: rental_order rental_order_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_order_guard ON zzsh_order.rental_order：执行 zzsh_order.guard_rental_order。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_order_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_rental_order();


--
-- Name: rental_order rental_order_personal_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_order_personal_guard ON zzsh_order.rental_order：执行 zzsh_order.guard_personal_order。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_personal_order();


--
-- Name: rental_referral_earning rental_referral_earning_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 rental_referral_earning_guard ON zzsh_order.rental_referral_earning：执行 zzsh_order.guard_rental_referral_earning。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_referral_earning_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.rental_referral_earning FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_rental_referral_earning();


--
-- Name: settlement_decision settlement_decision_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_decision_guard ON zzsh_order.settlement_decision：执行 zzsh_order.guard_settlement_decision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER settlement_decision_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.settlement_decision FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_decision();


--
-- Name: settlement_intake settlement_intake_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_intake_guard ON zzsh_order.settlement_intake：执行 zzsh_order.guard_settlement_intake。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER settlement_intake_guard BEFORE DELETE OR UPDATE ON zzsh_order.settlement_intake FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_intake();


--
-- Name: settlement_ledger_entry settlement_ledger_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_ledger_batch_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.check_settlement_posting_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER settlement_ledger_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_settlement_posting_batch();


--
-- Name: settlement_ledger_entry settlement_ledger_entry_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_ledger_entry_guard ON zzsh_order.settlement_ledger_entry：执行 zzsh_order.guard_settlement_ledger_entry。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER settlement_ledger_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN ((new.posting_id IS NOT NULL)) EXECUTE FUNCTION zzsh_order.guard_settlement_ledger_entry();


--
-- Name: settlement_posting settlement_posting_batch_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_posting_batch_guard ON zzsh_order.settlement_posting：执行 zzsh_order.check_settlement_posting_batch。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER settlement_posting_batch_guard AFTER INSERT ON zzsh_order.settlement_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_settlement_posting_batch();


--
-- Name: settlement_posting settlement_posting_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_posting_guard ON zzsh_order.settlement_posting：执行 zzsh_order.guard_settlement_posting。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER settlement_posting_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.settlement_posting FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_posting();


--
-- Name: settlement_version settlement_version_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 settlement_version_guard ON zzsh_order.settlement_version：执行 zzsh_order.guard_settlement_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER settlement_version_guard BEFORE DELETE OR UPDATE ON zzsh_order.settlement_version FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_version();


--
-- Name: finance_stored_opening_review stored_opening_observations_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 stored_opening_observations_guard ON zzsh_order.finance_stored_opening_review：执行 zzsh_order.check_stored_opening_observations。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER stored_opening_observations_guard AFTER INSERT ON zzsh_order.finance_stored_opening_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_stored_opening_observations();


--
-- Name: finance_stored_opening_review stored_opening_review_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 stored_opening_review_guard ON zzsh_order.finance_stored_opening_review：执行 zzsh_order.guard_stored_opening_review。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER stored_opening_review_guard BEFORE INSERT ON zzsh_order.finance_stored_opening_review FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_stored_opening_review();


--
-- Name: finance_stored_opening_review stored_opening_review_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 stored_opening_review_immutable ON zzsh_order.finance_stored_opening_review：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER stored_opening_review_immutable BEFORE DELETE OR UPDATE ON zzsh_order.finance_stored_opening_review FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: finance_stored_opening_review stored_opening_source_proof_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 stored_opening_source_proof_guard ON zzsh_order.finance_stored_opening_review：执行 zzsh_order.guard_stored_opening_source_proof。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER stored_opening_source_proof_guard BEFORE INSERT ON zzsh_order.finance_stored_opening_review FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_stored_opening_source_proof();


--
-- Name: rental_order supply_final_funding_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 supply_final_funding_guard ON zzsh_order.rental_order：执行 zzsh_order.guard_supply_final_funding。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER supply_final_funding_guard BEFORE INSERT ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_supply_final_funding();


--
-- Name: wallet_coverage wallet_coverage_immutable; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 wallet_coverage_immutable ON zzsh_order.wallet_coverage：执行 zzsh_order.finance_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER wallet_coverage_immutable BEFORE DELETE OR UPDATE ON zzsh_order.wallet_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();


--
-- Name: withdrawal_bank_binding withdrawal_bank_binding_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 withdrawal_bank_binding_guard ON zzsh_order.withdrawal_bank_binding：执行 zzsh_order.withdrawal_bank_binding_guard。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER withdrawal_bank_binding_guard BEFORE INSERT OR UPDATE ON zzsh_order.withdrawal_bank_binding FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_bank_binding_guard();


--
-- Name: finance_covered_event withdrawal_return_covered_guard; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 withdrawal_return_covered_guard ON zzsh_order.finance_covered_event：执行 zzsh_order.guard_withdrawal_return_covered。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER withdrawal_return_covered_guard BEFORE INSERT ON zzsh_order.finance_covered_event FOR EACH ROW WHEN ((new.source_kind = 'LEGACY_WITHDRAWAL_RETURN'::text)) EXECUTE FUNCTION zzsh_order.guard_withdrawal_return_covered();


--
-- Name: finance_event withdrawal_revision; Type: TRIGGER; Schema: zzsh_order; Owner: -
--

-- 触发器 withdrawal_revision ON zzsh_order.finance_event：执行 zzsh_order.withdrawal_wallet_revision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER withdrawal_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['RESERVE'::text, 'RELEASE'::text, 'PAYOUT'::text, 'EARNING_PENDING'::text, 'EARNING_SETTLED'::text, 'EARNING_REVOKED'::text]))) EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();


--
-- Name: price_line a_detail_parents; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 a_detail_parents ON zzsh_supply.price_line：执行 zzsh_supply.guard_detail_parents。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_detail_parents BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.price_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_detail_parents();


--
-- Name: term_option a_detail_parents; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 a_detail_parents ON zzsh_supply.term_option：执行 zzsh_supply.guard_detail_parents。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_detail_parents BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.term_option FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_detail_parents();


--
-- Name: agreement_version a_version_identity; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 a_version_identity ON zzsh_supply.agreement_version：执行 zzsh_supply.guard_version_identity。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.agreement_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();


--
-- Name: price_version a_version_identity; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 a_version_identity ON zzsh_supply.price_version：执行 zzsh_supply.guard_version_identity。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();


--
-- Name: term_version a_version_identity; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 a_version_identity ON zzsh_supply.term_version：执行 zzsh_supply.guard_version_identity。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER a_version_identity BEFORE UPDATE ON zzsh_supply.term_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_version_identity();


--
-- Name: rule_acceptance acceptance_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 acceptance_immutable ON zzsh_supply.rule_acceptance：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER acceptance_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: account_guarantee_proof account_guarantee_proof_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 account_guarantee_proof_immutable ON zzsh_supply.account_guarantee_proof：执行 zzsh_supply.guard_account_guarantee_proof_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER account_guarantee_proof_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.account_guarantee_proof FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_guarantee_proof_immutable();


--
-- Name: account_guarantee_proof account_guarantee_proof_insert_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 account_guarantee_proof_insert_guard ON zzsh_supply.account_guarantee_proof：执行 zzsh_supply.guard_account_guarantee_proof_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER account_guarantee_proof_insert_guard BEFORE INSERT ON zzsh_supply.account_guarantee_proof FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_guarantee_proof_insert();


--
-- Name: rental_account account_public_number_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 account_public_number_guard ON zzsh_supply.rental_account：执行 zzsh_supply.guard_account_public_number。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER account_public_number_guard BEFORE INSERT OR UPDATE ON zzsh_supply.rental_account FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_public_number();


--
-- Name: agreement_version agreement_version_seal_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 agreement_version_seal_guard ON zzsh_supply.agreement_version：执行 zzsh_supply.guard_agreement_version_update。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER agreement_version_seal_guard BEFORE UPDATE ON zzsh_supply.agreement_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_agreement_version_update();


--
-- Name: media_asset asset_account; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 asset_account ON zzsh_supply.media_asset：执行 zzsh_supply.guard_asset_account。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER asset_account BEFORE UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_asset_account();


--
-- Name: media_asset avatar_policy_asset_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 avatar_policy_asset_guard ON zzsh_supply.media_asset：执行 zzsh_supply.guard_avatar_policy_asset。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER avatar_policy_asset_guard BEFORE INSERT OR UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_avatar_policy_asset();


--
-- Name: review_decision decision_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 decision_immutable ON zzsh_supply.review_decision：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER decision_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.review_decision FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: duplicate_hint duplicate_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 duplicate_immutable ON zzsh_supply.duplicate_hint：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER duplicate_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.duplicate_hint FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: rule_acceptance full_payout_acceptance_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 full_payout_acceptance_guard ON zzsh_supply.rule_acceptance：执行 zzsh_supply.guard_full_payout_acceptance。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER full_payout_acceptance_guard BEFORE INSERT ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_full_payout_acceptance();


--
-- Name: price_version full_payout_price_reference_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 full_payout_price_reference_guard ON zzsh_supply.price_version：执行 zzsh_supply.guard_full_payout_price_reference。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER full_payout_price_reference_guard BEFORE INSERT OR UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_full_payout_price_reference();


--
-- Name: full_payout_terms_version full_payout_terms_version_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 full_payout_terms_version_guard ON zzsh_supply.full_payout_terms_version：执行 zzsh_supply.guard_full_payout_terms_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER full_payout_terms_version_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.full_payout_terms_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_full_payout_terms_version();


--
-- Name: billable_item item_semantics; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 item_semantics ON zzsh_supply.billable_item：执行 zzsh_supply.guard_item_semantics。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER item_semantics BEFORE UPDATE ON zzsh_supply.billable_item FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_item_semantics();


--
-- Name: legacy_listing_display_snapshot legacy_display_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_display_immutable ON zzsh_supply.legacy_listing_display_snapshot：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_display_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.legacy_listing_display_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: legacy_listing_display_snapshot legacy_display_insert; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_display_insert ON zzsh_supply.legacy_listing_display_snapshot：执行 zzsh_supply.guard_legacy_display_snapshot。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_display_insert BEFORE INSERT ON zzsh_supply.legacy_listing_display_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_display_snapshot();


--
-- Name: legacy_supply_map legacy_map_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_map_immutable ON zzsh_supply.legacy_supply_map：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_map_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.legacy_supply_map FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: legacy_listing_read_snapshot legacy_read_snapshot_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_read_snapshot_immutable ON zzsh_supply.legacy_listing_read_snapshot：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_read_snapshot_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.legacy_listing_read_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: legacy_listing_read_snapshot legacy_read_snapshot_insert; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_read_snapshot_insert ON zzsh_supply.legacy_listing_read_snapshot：执行 zzsh_supply.guard_legacy_read_snapshot。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_read_snapshot_insert BEFORE INSERT ON zzsh_supply.legacy_listing_read_snapshot FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_read_snapshot();


--
-- Name: legacy_skin_holding legacy_skin_holding_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_skin_holding_guard ON zzsh_supply.legacy_skin_holding：执行 zzsh_supply.guard_legacy_skin_holding。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_skin_holding_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.legacy_skin_holding FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_skin_holding();


--
-- Name: rule_acceptance legacy_takeover_authorization_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 legacy_takeover_authorization_guard ON zzsh_supply.rule_acceptance：执行 zzsh_supply.guard_legacy_takeover_authorization。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER legacy_takeover_authorization_guard BEFORE INSERT ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_takeover_authorization();


--
-- Name: rule_acceptance listing_acceptance; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_acceptance ON zzsh_supply.rule_acceptance：执行 zzsh_supply.guard_listing_acceptance。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_acceptance BEFORE INSERT ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_acceptance();


--
-- Name: inventory_line listing_child; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_child ON zzsh_supply.inventory_line：执行 zzsh_supply.guard_listing_child。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_child BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.inventory_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();


--
-- Name: listing_entitlement listing_child; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_child ON zzsh_supply.listing_entitlement：执行 zzsh_supply.guard_listing_child。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_child BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.listing_entitlement FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();


--
-- Name: listing_media listing_child; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_child ON zzsh_supply.listing_media：执行 zzsh_supply.guard_listing_child。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_child BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.listing_media FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();


--
-- Name: listing_skin listing_child; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_child ON zzsh_supply.listing_skin：执行 zzsh_supply.guard_listing_child。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_child BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.listing_skin FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();


--
-- Name: listing_version listing_commitments; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_commitments ON zzsh_supply.listing_version：执行 zzsh_supply.guard_listing_commitments。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_commitments BEFORE INSERT OR UPDATE ON zzsh_supply.listing_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_commitments();


--
-- Name: listing_version listing_content; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_content ON zzsh_supply.listing_version：执行 zzsh_supply.guard_listing_content。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_content BEFORE UPDATE ON zzsh_supply.listing_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_content();


--
-- Name: review_decision listing_decision; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_decision ON zzsh_supply.review_decision：执行 zzsh_supply.guard_listing_decision。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_decision BEFORE INSERT ON zzsh_supply.review_decision FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_decision();


--
-- Name: listing_filter_config listing_filter_config_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_filter_config_guard ON zzsh_supply.listing_filter_config：执行 zzsh_supply.guard_listing_filter_config。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_filter_config_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.listing_filter_config FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_filter_config();


--
-- Name: listing_publication listing_publication_consistency; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_publication_consistency ON zzsh_supply.listing_publication：执行 zzsh_supply.guard_listing_publication_consistency。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER listing_publication_consistency AFTER INSERT OR DELETE OR UPDATE ON zzsh_supply.listing_publication DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_consistency();


--
-- Name: listing_publication listing_publication_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_publication_immutable ON zzsh_supply.listing_publication：执行 zzsh_supply.guard_listing_publication_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_publication_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.listing_publication FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_immutable();


--
-- Name: listing_publication listing_publication_shape; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_publication_shape ON zzsh_supply.listing_publication：执行 zzsh_supply.guard_listing_publication_shape。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER listing_publication_shape BEFORE INSERT ON zzsh_supply.listing_publication FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_shape();


--
-- Name: listing_version listing_version_publication; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 listing_version_publication ON zzsh_supply.listing_version：执行 zzsh_supply.guard_listing_version_publication。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE CONSTRAINT TRIGGER listing_version_publication AFTER INSERT OR UPDATE ON zzsh_supply.listing_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_version_publication();


--
-- Name: media_asset media_asset_mutation_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 media_asset_mutation_guard ON zzsh_supply.media_asset：执行 zzsh_supply.guard_media_asset_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER media_asset_mutation_guard BEFORE UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_media_asset_mutation();


--
-- Name: price_line price_line_compat_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 price_line_compat_guard ON zzsh_supply.price_line：执行 zzsh_supply.guard_compat_price_line。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER price_line_compat_guard BEFORE INSERT OR UPDATE ON zzsh_supply.price_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_compat_price_line();


--
-- Name: price_line price_line_mutation_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 price_line_mutation_guard ON zzsh_supply.price_line：执行 zzsh_supply.guard_price_line_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER price_line_mutation_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.price_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_price_line_mutation();


--
-- Name: price_version price_version_compat_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 price_version_compat_guard ON zzsh_supply.price_version：执行 zzsh_supply.guard_compat_price_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER price_version_compat_guard BEFORE UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_compat_price_version();


--
-- Name: price_version price_version_seal_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 price_version_seal_guard ON zzsh_supply.price_version：执行 zzsh_supply.guard_price_version_update。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER price_version_seal_guard BEFORE UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_price_version_update();


--
-- Name: profile_avatar_policy profile_avatar_policy_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 profile_avatar_policy_guard ON zzsh_supply.profile_avatar_policy：执行 zzsh_supply.guard_profile_avatar_policy。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER profile_avatar_policy_guard BEFORE DELETE OR UPDATE ON zzsh_supply.profile_avatar_policy FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_profile_avatar_policy();


--
-- Name: media_asset public_derivative; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 public_derivative ON zzsh_supply.media_asset：执行 zzsh_supply.guard_public_derivative。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER public_derivative BEFORE UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_public_derivative();


--
-- Name: rule_release release_immutable; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 release_immutable ON zzsh_supply.rule_release：执行 zzsh_supply.guard_release_immutable。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER release_immutable BEFORE DELETE OR UPDATE ON zzsh_supply.rule_release FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();


--
-- Name: rental_account rental_identity; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 rental_identity ON zzsh_supply.rental_account：执行 zzsh_supply.guard_rental_identity。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rental_identity BEFORE UPDATE ON zzsh_supply.rental_account FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rental_identity();


--
-- Name: rule_release rule_release_insert_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 rule_release_insert_guard ON zzsh_supply.rule_release：执行 zzsh_supply.guard_rule_release_insert。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER rule_release_insert_guard BEFORE INSERT ON zzsh_supply.rule_release FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_release_insert();


--
-- Name: skin_category skin_category_tree_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 skin_category_tree_guard ON zzsh_supply.skin_category：执行 zzsh_supply.guard_skin_category_tree。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER skin_category_tree_guard BEFORE INSERT OR UPDATE ON zzsh_supply.skin_category FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_skin_category_tree();


--
-- Name: skin skin_identity_write_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 skin_identity_write_guard ON zzsh_supply.skin：执行 zzsh_supply.guard_skin_identity_write。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER skin_identity_write_guard BEFORE INSERT OR UPDATE ON zzsh_supply.skin FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_skin_identity_write();


--
-- Name: term_option term_option_mutation_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 term_option_mutation_guard ON zzsh_supply.term_option：执行 zzsh_supply.guard_term_option_mutation。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER term_option_mutation_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_supply.term_option FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_term_option_mutation();


--
-- Name: term_version term_version_seal_guard; Type: TRIGGER; Schema: zzsh_supply; Owner: -
--

-- 触发器 term_version_seal_guard ON zzsh_supply.term_version：执行 zzsh_supply.guard_sealed_term_version。资金、幂等和不可变约束由该函数与随后的触发器定义共同实现。
CREATE TRIGGER term_version_seal_guard BEFORE UPDATE ON zzsh_supply.term_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_sealed_term_version();


--
-- Name: account admin_account_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.account
    ADD CONSTRAINT admin_account_user_id_fkey FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: session admin_session_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin.session
    ADD CONSTRAINT admin_session_user_id_fkey FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: twoFactor admin_two_factor_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_admin; Owner: -
--

ALTER TABLE ONLY zzsh_auth_admin."twoFactor"
    ADD CONSTRAINT admin_two_factor_user_id_fkey FOREIGN KEY ("userId") REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE;


--
-- Name: twoFactor twoFactor_userId_fkey; Type: FK CONSTRAINT; Schema: zzsh_auth_user; Owner: -
--

ALTER TABLE ONLY zzsh_auth_user."twoFactor"
    ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE;


--
-- Name: carousel_item carousel_item_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.carousel_item
    ADD CONSTRAINT carousel_item_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: carousel_item carousel_item_media_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.carousel_item
    ADD CONSTRAINT carousel_item_media_id_fkey FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: content_item content_item_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_item
    ADD CONSTRAINT content_item_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: content_item content_item_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_item
    ADD CONSTRAINT content_item_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: content_version content_version_cover_media_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_cover_media_id_fkey FOREIGN KEY (cover_media_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: content_version content_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: content_version content_version_item_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_item_id_fkey FOREIGN KEY (item_id) REFERENCES zzsh_content.content_item(id);


--
-- Name: content_version content_version_published_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.content_version
    ADD CONSTRAINT content_version_published_by_admin_id_fkey FOREIGN KEY (published_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: document_acceptance document_acceptance_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.document_acceptance
    ADD CONSTRAINT document_acceptance_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legal_document_version legal_document_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.legal_document_version
    ADD CONSTRAINT legal_document_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legal_document_version legal_document_version_sealed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_content; Owner: -
--

ALTER TABLE ONLY zzsh_content.legal_document_version
    ADD CONSTRAINT legal_document_version_sealed_by_admin_id_fkey FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: credit_event credit_event_actor_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_actor_admin_id_fkey FOREIGN KEY (actor_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: credit_event credit_event_reversal_of_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_reversal_of_id_fkey FOREIGN KEY (reversal_of_id) REFERENCES zzsh_credit.credit_event(id);


--
-- Name: credit_event credit_event_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_event
    ADD CONSTRAINT credit_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: credit_recovery_request credit_recovery_request_decided_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_recovery_request
    ADD CONSTRAINT credit_recovery_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: credit_recovery_request credit_recovery_request_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_recovery_request
    ADD CONSTRAINT credit_recovery_request_event_id_fkey FOREIGN KEY (event_id) REFERENCES zzsh_credit.credit_event(id);


--
-- Name: credit_recovery_request credit_recovery_request_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.credit_recovery_request
    ADD CONSTRAINT credit_recovery_request_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: user_credit_state user_credit_state_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_credit; Owner: -
--

ALTER TABLE ONLY zzsh_credit.user_credit_state
    ADD CONSTRAINT user_credit_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: admin_recovery_notification_target admin_recovery_notification_target_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_recovery_notification_target
    ADD CONSTRAINT admin_recovery_notification_target_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: admin_recovery_request admin_recovery_request_target_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_recovery_request
    ADD CONSTRAINT admin_recovery_request_target_admin_user_id_fkey FOREIGN KEY (target_admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: admin_role_permission admin_role_permission_permission_code_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_role_permission
    ADD CONSTRAINT admin_role_permission_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES zzsh_iam.admin_permission(code);


--
-- Name: admin_role_permission admin_role_permission_role_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_role_permission
    ADD CONSTRAINT admin_role_permission_role_id_fkey FOREIGN KEY (role_id) REFERENCES zzsh_iam.admin_role(id) ON DELETE CASCADE;


--
-- Name: admin_user_permission admin_user_permission_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_permission
    ADD CONSTRAINT admin_user_permission_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: admin_user_permission admin_user_permission_permission_code_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_permission
    ADD CONSTRAINT admin_user_permission_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES zzsh_iam.admin_permission(code);


--
-- Name: admin_user_role admin_user_role_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_role
    ADD CONSTRAINT admin_user_role_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: admin_user_role admin_user_role_role_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_user_role
    ADD CONSTRAINT admin_user_role_role_id_fkey FOREIGN KEY (role_id) REFERENCES zzsh_iam.admin_role(id) ON DELETE CASCADE;


--
-- Name: approval_decision approval_decision_approver_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_decision
    ADD CONSTRAINT approval_decision_approver_admin_id_fkey FOREIGN KEY (approver_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_decision approval_decision_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_decision
    ADD CONSTRAINT approval_decision_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: approval_execution approval_execution_executed_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_execution
    ADD CONSTRAINT approval_execution_executed_by_fkey FOREIGN KEY (executed_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_execution approval_execution_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_execution
    ADD CONSTRAINT approval_execution_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: approval_request_candidate approval_request_candidate_added_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request_candidate
    ADD CONSTRAINT approval_request_candidate_added_by_fkey FOREIGN KEY (added_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_request_candidate approval_request_candidate_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request_candidate
    ADD CONSTRAINT approval_request_candidate_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_request_candidate approval_request_candidate_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request_candidate
    ADD CONSTRAINT approval_request_candidate_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: approval_request approval_request_decided_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_request approval_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_request approval_request_superseded_by_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_superseded_by_request_id_fkey FOREIGN KEY (superseded_by_request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: approval_request approval_request_supersedes_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_supersedes_request_id_fkey FOREIGN KEY (supersedes_request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: approval_request approval_request_template_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_request
    ADD CONSTRAINT approval_request_template_id_fkey FOREIGN KEY (template_id) REFERENCES zzsh_iam.approval_template(id);


--
-- Name: approval_template_candidate approval_template_candidate_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_template_candidate
    ADD CONSTRAINT approval_template_candidate_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: approval_template_candidate approval_template_candidate_template_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.approval_template_candidate
    ADD CONSTRAINT approval_template_candidate_template_id_fkey FOREIGN KEY (template_id) REFERENCES zzsh_iam.approval_template(id);


--
-- Name: im_aftersale_record im_aftersale_record_handler_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_handler_admin_id_fkey FOREIGN KEY (handler_admin_id) REFERENCES zzsh_iam.admin_security(admin_user_id);


--
-- Name: im_aftersale_record im_aftersale_record_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: im_aftersale_record im_aftersale_record_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: im_aftersale_record im_aftersale_record_resolved_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_aftersale_record
    ADD CONSTRAINT im_aftersale_record_resolved_by_admin_id_fkey FOREIGN KEY (resolved_by_admin_id) REFERENCES zzsh_iam.admin_security(admin_user_id);


--
-- Name: im_consultation im_consultation_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation
    ADD CONSTRAINT im_consultation_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_consultation_event im_consultation_event_consultation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_event
    ADD CONSTRAINT im_consultation_event_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES zzsh_iam.im_consultation(id) ON DELETE CASCADE;


--
-- Name: im_consultation_event im_consultation_event_from_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_event
    ADD CONSTRAINT im_consultation_event_from_admin_id_fkey FOREIGN KEY (from_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_consultation_event im_consultation_event_to_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_event
    ADD CONSTRAINT im_consultation_event_to_admin_id_fkey FOREIGN KEY (to_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_consultation_scope_operation im_consultation_scope_operation_consultation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation_scope_operation
    ADD CONSTRAINT im_consultation_scope_operation_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES zzsh_iam.im_consultation(id);


--
-- Name: im_consultation im_consultation_thread_scope; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation
    ADD CONSTRAINT im_consultation_thread_scope FOREIGN KEY (thread_id, app_id, user_id, kind) REFERENCES zzsh_iam.im_support_thread(id, app_id, user_id, kind) ON DELETE RESTRICT;


--
-- Name: im_consultation im_consultation_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_consultation
    ADD CONSTRAINT im_consultation_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT;


--
-- Name: im_read_copy_settings im_read_copy_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_read_copy_settings
    ADD CONSTRAINT im_read_copy_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES zzsh_iam.admin_security(admin_user_id);


--
-- Name: im_support_handover im_support_handover_from_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_handover
    ADD CONSTRAINT im_support_handover_from_admin_id_fkey FOREIGN KEY (from_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_support_handover im_support_handover_to_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_handover
    ADD CONSTRAINT im_support_handover_to_admin_id_fkey FOREIGN KEY (to_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_support_presence im_support_presence_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_presence
    ADD CONSTRAINT im_support_presence_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: im_support_presence_session im_support_presence_session_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_presence_session
    ADD CONSTRAINT im_support_presence_session_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_support_round_rating im_support_round_rating_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: im_support_round_rating im_support_round_rating_round_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_round_id_fkey FOREIGN KEY (round_id) REFERENCES zzsh_iam.im_consultation(id) ON DELETE RESTRICT;


--
-- Name: im_support_round_rating im_support_round_rating_thread_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES zzsh_iam.im_support_thread(id) ON DELETE RESTRICT;


--
-- Name: im_support_round_rating im_support_round_rating_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_round_rating
    ADD CONSTRAINT im_support_round_rating_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT;


--
-- Name: im_support_settings im_support_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_settings
    ADD CONSTRAINT im_support_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES zzsh_iam.admin_security(admin_user_id);


--
-- Name: im_support_thread im_support_thread_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.im_support_thread
    ADD CONSTRAINT im_support_thread_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT;


--
-- Name: membership_entitlement membership_entitlement_approved_policy_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_entitlement
    ADD CONSTRAINT membership_entitlement_approved_policy_id_fkey FOREIGN KEY (approved_policy_id) REFERENCES zzsh_iam.membership_growth_policy(id);


--
-- Name: membership_entitlement membership_entitlement_replaced_by_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_entitlement
    ADD CONSTRAINT membership_entitlement_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES zzsh_iam.membership_entitlement(id);


--
-- Name: membership_growth_legacy_coverage membership_growth_legacy_coverage_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_coverage
    ADD CONSTRAINT membership_growth_legacy_coverage_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admi_scope_key_execution_key_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admi_scope_key_execution_key_fkey FOREIGN KEY (scope_key, execution_key) REFERENCES zzsh_supply.idempotency_record(scope_key, key);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admission_coverage_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admission_coverage_id_fkey FOREIGN KEY (coverage_id) REFERENCES zzsh_iam.membership_growth_legacy_coverage(id);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admission_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admission_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: membership_growth_legacy_read_admission membership_growth_legacy_read_admission_success_audit_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_legacy_read_admission
    ADD CONSTRAINT membership_growth_legacy_read_admission_success_audit_id_fkey FOREIGN KEY (success_audit_id) REFERENCES zzsh_iam.audit_event(id);


--
-- Name: membership_growth_state membership_growth_state_policy_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.membership_growth_state
    ADD CONSTRAINT membership_growth_state_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES zzsh_iam.membership_growth_policy(id);


--
-- Name: personal_finance_read_scope personal_finance_read_scope_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.personal_finance_read_scope
    ADD CONSTRAINT personal_finance_read_scope_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: personal_finance_read_scope personal_finance_read_scope_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.personal_finance_read_scope
    ADD CONSTRAINT personal_finance_read_scope_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: user_identity_display_source user_identity_display_source_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_display_source
    ADD CONSTRAINT user_identity_display_source_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_state(user_id) ON DELETE CASCADE;


--
-- Name: user_identity_state user_identity_state_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_state
    ADD CONSTRAINT user_identity_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE RESTRICT;


--
-- Name: user_identity_subject user_identity_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_subject
    ADD CONSTRAINT user_identity_subject_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_state(user_id);


--
-- Name: user_identity_verification_attempt user_identity_verification_attempt_privacy_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_verification_attempt
    ADD CONSTRAINT user_identity_verification_attempt_privacy_version_id_fkey FOREIGN KEY (privacy_version_id) REFERENCES zzsh_content.legal_document_version(id);


--
-- Name: user_identity_verification_attempt user_identity_verification_attempt_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_verification_attempt
    ADD CONSTRAINT user_identity_verification_attempt_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: user_identity_verified_profile user_identity_verified_profile_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_identity_verified_profile
    ADD CONSTRAINT user_identity_verified_profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_iam.user_identity_subject(user_id);


--
-- Name: user_note user_note_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_note
    ADD CONSTRAINT user_note_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE;


--
-- Name: user_rental_membership user_rental_membership_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_rental_membership
    ADD CONSTRAINT user_rental_membership_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: user_rental_membership user_rental_membership_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_rental_membership
    ADD CONSTRAINT user_rental_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: user_risk_flag user_risk_flag_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.user_risk_flag
    ADD CONSTRAINT user_risk_flag_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id) ON DELETE CASCADE;


--
-- Name: channel_refund_intent channel_refund_intent_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: channel_refund_intent channel_refund_intent_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_payment_confirmation_id_fkey FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: channel_refund_intent channel_refund_intent_posting_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_posting_id_fkey FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id);


--
-- Name: channel_refund_intent channel_refund_intent_renter_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_intent_renter_user_id_fkey FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: channel_refund_intent channel_refund_liability_event_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_liability_event_fk FOREIGN KEY (liability_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: channel_refund_intent channel_refund_liability_root_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT channel_refund_liability_root_fk FOREIGN KEY (liability_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: channel_refund_observation channel_refund_observation_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_observation
    ADD CONSTRAINT channel_refund_observation_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id);


--
-- Name: distribution_invite_code distribution_invite_code_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_invite_code
    ADD CONSTRAINT distribution_invite_code_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: distribution_order_admission distribution_order_admission_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: distribution_order_admission distribution_order_admission_native_creation_audit_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_native_creation_audit_id_fkey FOREIGN KEY (native_creation_audit_id) REFERENCES zzsh_iam.audit_event(id);


--
-- Name: distribution_order_admission distribution_order_admission_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_order_admission
    ADD CONSTRAINT distribution_order_admission_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: distribution_participant distribution_participant_policy_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_participant
    ADD CONSTRAINT distribution_participant_policy_version_id_fkey FOREIGN KEY (policy_version_id) REFERENCES zzsh_order.distribution_policy_version(id);


--
-- Name: distribution_participant distribution_participant_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_participant
    ADD CONSTRAINT distribution_participant_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: distribution_policy_head distribution_policy_head_current_version_id_scope_revision_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_head
    ADD CONSTRAINT distribution_policy_head_current_version_id_scope_revision_fkey FOREIGN KEY (current_version_id, scope, revision) REFERENCES zzsh_order.distribution_policy_version(id, scope, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: distribution_policy_version distribution_policy_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.distribution_policy_version
    ADD CONSTRAINT distribution_policy_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: finance_covered_event finance_covered_event_basis_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_covered_event
    ADD CONSTRAINT finance_covered_event_basis_id_fkey FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id);


--
-- Name: finance_covered_event finance_covered_event_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_covered_event
    ADD CONSTRAINT finance_covered_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: finance_economic_root finance_economic_root_basis_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_economic_root
    ADD CONSTRAINT finance_economic_root_basis_id_fkey FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id);


--
-- Name: finance_economic_root finance_economic_root_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_economic_root
    ADD CONSTRAINT finance_economic_root_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: finance_event finance_event_economic_root_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_event
    ADD CONSTRAINT finance_event_economic_root_id_fkey FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id);


--
-- Name: finance_event finance_event_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_event
    ADD CONSTRAINT finance_event_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: finance_observation_admission finance_observation_admission_basis_id_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_observation_admission
    ADD CONSTRAINT finance_observation_admission_basis_id_user_id_fkey FOREIGN KEY (basis_id, user_id) REFERENCES zzsh_order.finance_opening_basis(id, user_id);


--
-- Name: finance_opening_basis finance_opening_basis_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_opening_basis
    ADD CONSTRAINT finance_opening_basis_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: finance_stored_opening_review finance_stored_opening_review_basis_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.finance_stored_opening_review
    ADD CONSTRAINT finance_stored_opening_review_basis_id_fkey FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id);


--
-- Name: im_order_activity im_order_activity_order_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_activity
    ADD CONSTRAINT im_order_activity_order_fk FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE CASCADE;


--
-- Name: im_order_due_reminder im_order_due_reminder_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_due_reminder
    ADD CONSTRAINT im_order_due_reminder_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE RESTRICT;


--
-- Name: im_order_event im_order_event_order_id_app_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_event
    ADD CONSTRAINT im_order_event_order_id_app_id_fkey FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id);


--
-- Name: im_order_event im_order_event_related_operation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_event
    ADD CONSTRAINT im_order_event_related_operation_id_fkey FOREIGN KEY (related_operation_id) REFERENCES zzsh_order.im_order_operation(id);


--
-- Name: im_order_group im_order_first_response_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_first_response_fk FOREIGN KEY (first_response_event_id) REFERENCES zzsh_order.im_order_event(id);


--
-- Name: im_order_group im_order_group_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_group_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: im_order_group im_order_group_order_id_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_group_order_id_payment_confirmation_id_fkey FOREIGN KEY (order_id, payment_confirmation_id) REFERENCES zzsh_order.rental_order(id, paid_confirmation_id);


--
-- Name: im_order_group im_order_group_responsible_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_group_responsible_admin_id_fkey FOREIGN KEY (responsible_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: im_order_member im_order_member_identity_id_app_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_member
    ADD CONSTRAINT im_order_member_identity_id_app_id_fkey FOREIGN KEY (identity_id, app_id) REFERENCES zzsh_iam.im_identity_mapping(id, app_id);


--
-- Name: im_order_member im_order_member_order_id_app_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_member
    ADD CONSTRAINT im_order_member_order_id_app_id_fkey FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id);


--
-- Name: im_order_operation im_order_operation_order_id_app_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_operation
    ADD CONSTRAINT im_order_operation_order_id_app_id_fkey FOREIGN KEY (order_id, app_id) REFERENCES zzsh_order.im_order_group(order_id, app_id);


--
-- Name: im_order_operation im_order_operation_target_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_operation
    ADD CONSTRAINT im_order_operation_target_admin_id_fkey FOREIGN KEY (target_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: im_order_stage_card im_order_stage_card_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_stage_card
    ADD CONSTRAINT im_order_stage_card_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE RESTRICT;


--
-- Name: im_order_group im_order_system_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_group
    ADD CONSTRAINT im_order_system_fk FOREIGN KEY (system_identity_id, app_id) REFERENCES zzsh_iam.im_identity_mapping(id, app_id);


--
-- Name: im_order_unread im_order_unread_identity_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_unread
    ADD CONSTRAINT im_order_unread_identity_fk FOREIGN KEY (identity_id) REFERENCES zzsh_iam.im_identity_mapping(id) ON DELETE CASCADE;


--
-- Name: im_order_unread im_order_unread_order_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.im_order_unread
    ADD CONSTRAINT im_order_unread_order_fk FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id) ON DELETE CASCADE;


--
-- Name: invitation_relation invitation_relation_child_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.invitation_relation
    ADD CONSTRAINT invitation_relation_child_user_id_fkey FOREIGN KEY (child_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: invitation_relation invitation_relation_parent_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.invitation_relation
    ADD CONSTRAINT invitation_relation_parent_user_id_fkey FOREIGN KEY (parent_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: invitation_relation invitation_relation_policy_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.invitation_relation
    ADD CONSTRAINT invitation_relation_policy_version_id_fkey FOREIGN KEY (policy_version_id) REFERENCES zzsh_order.distribution_policy_version(id);


--
-- Name: joinpay_collection_attempt joinpay_collection_attempt_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_attempt
    ADD CONSTRAINT joinpay_collection_attempt_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_order.joinpay_collection_binding(request_id);


--
-- Name: joinpay_collection_binding joinpay_collection_binding_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_binding
    ADD CONSTRAINT joinpay_collection_binding_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id);


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_origin_observation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_evidence
    ADD CONSTRAINT joinpay_collection_evidence_origin_observation_id_fkey FOREIGN KEY (origin_observation_id) REFERENCES zzsh_order.joinpay_collection_observation(id);


--
-- Name: joinpay_collection_evidence joinpay_collection_evidence_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_evidence
    ADD CONSTRAINT joinpay_collection_evidence_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id);


--
-- Name: joinpay_collection_observation joinpay_collection_observation_attempt_id_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_collection_observation
    ADD CONSTRAINT joinpay_collection_observation_attempt_id_request_id_fkey FOREIGN KEY (attempt_id, request_id) REFERENCES zzsh_order.joinpay_collection_attempt(id, request_id);


--
-- Name: joinpay_payout_attempt joinpay_payout_attempt_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_attempt
    ADD CONSTRAINT joinpay_payout_attempt_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id);


--
-- Name: joinpay_payout_evidence joinpay_payout_evidence_observation_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_evidence
    ADD CONSTRAINT joinpay_payout_evidence_observation_id_intent_id_fkey FOREIGN KEY (observation_id, intent_id) REFERENCES zzsh_order.joinpay_payout_observation(id, intent_id);


--
-- Name: joinpay_payout_observation joinpay_payout_observation_attempt_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_observation
    ADD CONSTRAINT joinpay_payout_observation_attempt_id_intent_id_fkey FOREIGN KEY (attempt_id, intent_id) REFERENCES zzsh_order.joinpay_payout_attempt(id, intent_id);


--
-- Name: joinpay_payout_observation joinpay_payout_observation_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_payout_observation
    ADD CONSTRAINT joinpay_payout_observation_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.joinpay_withdrawal_intent(id);


--
-- Name: joinpay_refund_attempt joinpay_refund_attempt_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_attempt
    ADD CONSTRAINT joinpay_refund_attempt_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id);


--
-- Name: joinpay_refund_evidence joinpay_refund_evidence_observation_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_evidence
    ADD CONSTRAINT joinpay_refund_evidence_observation_id_intent_id_fkey FOREIGN KEY (observation_id, intent_id) REFERENCES zzsh_order.joinpay_refund_observation(id, intent_id);


--
-- Name: joinpay_refund_observation joinpay_refund_observation_attempt_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_observation
    ADD CONSTRAINT joinpay_refund_observation_attempt_id_intent_id_fkey FOREIGN KEY (attempt_id, intent_id) REFERENCES zzsh_order.joinpay_refund_attempt(id, intent_id);


--
-- Name: joinpay_refund_observation joinpay_refund_observation_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_refund_observation
    ADD CONSTRAINT joinpay_refund_observation_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES zzsh_order.channel_refund_intent(id);


--
-- Name: channel_refund_intent joinpay_refund_terminal_event_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT joinpay_refund_terminal_event_fk FOREIGN KEY (terminal_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: channel_refund_intent joinpay_refund_terminal_evidence_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT joinpay_refund_terminal_evidence_fk FOREIGN KEY (terminal_evidence_id, id) REFERENCES zzsh_order.joinpay_refund_evidence(id, intent_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: channel_refund_intent joinpay_refund_terminal_root_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.channel_refund_intent
    ADD CONSTRAINT joinpay_refund_terminal_root_fk FOREIGN KEY (terminal_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_economic_root_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_economic_root_id_fkey FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_reserve_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_reserve_event_id_fkey FOREIGN KEY (reserve_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_terminal_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_terminal_event_id_fkey FOREIGN KEY (terminal_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_intent_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: joinpay_withdrawal_intent joinpay_withdrawal_terminal_evidence_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.joinpay_withdrawal_intent
    ADD CONSTRAINT joinpay_withdrawal_terminal_evidence_fk FOREIGN KEY (terminal_evidence_id, id) REFERENCES zzsh_order.joinpay_payout_evidence(id, intent_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_continuation_evidence legacy_continuation_evidence_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_continuation_evidence_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id);


--
-- Name: legacy_continuation_version legacy_continuation_version_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id);


--
-- Name: legacy_continuation_version legacy_continuation_version_order_id_input_evidence_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_order_id_input_evidence_id_fkey FOREIGN KEY (order_id, input_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_continuation_version legacy_continuation_version_order_id_result_evidence_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_version
    ADD CONSTRAINT legacy_continuation_version_order_id_result_evidence_id_fkey FOREIGN KEY (order_id, result_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_order_duty legacy_duty_admission_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_duty_admission_fk FOREIGN KEY (order_id, admission_id) REFERENCES zzsh_order.legacy_order_duty_admission(order_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_actor_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_duty_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_duty_id_fkey FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_effective_head_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_effective_head_id_fkey FOREIGN KEY (effective_head_id) REFERENCES zzsh_order.legacy_continuation_version(id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_event_id_fkey FOREIGN KEY (event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id);


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_root_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_root_id_fkey FOREIGN KEY (root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_duty_finance_fact legacy_duty_finance_fact_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_duty_finance_fact
    ADD CONSTRAINT legacy_duty_finance_fact_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_continuation_evidence legacy_evidence_derived_version_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_continuation_evidence
    ADD CONSTRAINT legacy_evidence_derived_version_fk FOREIGN KEY (order_id, derived_from_command_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_inflight_register legacy_inflight_register_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: legacy_inflight_register legacy_inflight_register_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legacy_inflight_register legacy_inflight_register_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_inflight_register legacy_inflight_register_renter_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_inflight_register
    ADD CONSTRAINT legacy_inflight_register_renter_user_id_fkey FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_counterparty_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_counterparty_user_id_fkey FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_duty_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_duty_id_fkey FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_order_duty_admission legacy_order_duty_admission_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_admission
    ADD CONSTRAINT legacy_order_duty_admission_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id);


--
-- Name: legacy_order_duty legacy_order_duty_counterparty_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_counterparty_user_id_fkey FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_order_duty legacy_order_duty_order_id_continuation_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_order_id_continuation_version_id_fkey FOREIGN KEY (order_id, continuation_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_order_duty legacy_order_duty_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty
    ADD CONSTRAINT legacy_order_duty_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.legacy_order_read_snapshot(id);


--
-- Name: legacy_order_duty_revision legacy_order_duty_revision_duty_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_revision
    ADD CONSTRAINT legacy_order_duty_revision_duty_id_fkey FOREIGN KEY (duty_id) REFERENCES zzsh_order.legacy_order_duty(id);


--
-- Name: legacy_order_duty_revision legacy_order_duty_revision_source_command_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_duty_revision
    ADD CONSTRAINT legacy_order_duty_revision_source_command_version_id_fkey FOREIGN KEY (source_command_version_id) REFERENCES zzsh_order.legacy_continuation_version(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_renter_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_renter_user_id_fkey FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_order_read_snapshot legacy_order_read_snapshot_source_system_legacy_account_en_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_order_read_snapshot
    ADD CONSTRAINT legacy_order_read_snapshot_source_system_legacy_account_en_fkey FOREIGN KEY (source_system, legacy_account_entity, legacy_account_id) REFERENCES zzsh_supply.legacy_supply_map(source_system, source_entity, legacy_id);


--
-- Name: legacy_owner_guarantee_coverage legacy_owner_guarantee_coverage_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_coverage
    ADD CONSTRAINT legacy_owner_guarantee_coverage_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: legacy_owner_guarantee_observation legacy_owner_guarantee_observation_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_observation
    ADD CONSTRAINT legacy_owner_guarantee_observation_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: legacy_owner_guarantee_observation legacy_owner_guarantee_observation_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.legacy_owner_guarantee_observation
    ADD CONSTRAINT legacy_owner_guarantee_observation_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: native_user_insert_proof native_user_insert_proof_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.native_user_insert_proof
    ADD CONSTRAINT native_user_insert_proof_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_finance_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_finance_event_id_fkey FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_ledger_entry_ref_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_ledger_entry_ref_fkey FOREIGN KEY (ledger_entry_ref) REFERENCES zzsh_order.settlement_ledger_entry(id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: owner_guarantee_payment owner_guarantee_payment_requirement_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_payment
    ADD CONSTRAINT owner_guarantee_payment_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES zzsh_order.owner_guarantee_requirement(id);


--
-- Name: owner_guarantee_reconciliation owner_guarantee_reconciliation_payment_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_reconciliation
    ADD CONSTRAINT owner_guarantee_reconciliation_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES zzsh_order.owner_guarantee_payment(id);


--
-- Name: owner_guarantee_reconciliation owner_guarantee_reconciliation_refund_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_reconciliation
    ADD CONSTRAINT owner_guarantee_reconciliation_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES zzsh_order.owner_guarantee_refund(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_finance_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_finance_event_id_fkey FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_ledger_entry_ref_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_ledger_entry_ref_fkey FOREIGN KEY (ledger_entry_ref) REFERENCES zzsh_order.settlement_ledger_entry(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_payment_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES zzsh_order.owner_guarantee_payment(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_release_decided_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_release_decided_by_fkey FOREIGN KEY (release_decided_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: owner_guarantee_refund owner_guarantee_refund_requirement_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_refund
    ADD CONSTRAINT owner_guarantee_refund_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES zzsh_order.owner_guarantee_requirement(id);


--
-- Name: owner_guarantee_requirement owner_guarantee_requirement_account_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_requirement
    ADD CONSTRAINT owner_guarantee_requirement_account_id_owner_user_id_fkey FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: owner_guarantee_requirement owner_guarantee_requirement_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.owner_guarantee_requirement
    ADD CONSTRAINT owner_guarantee_requirement_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: payment_channel_observation payment_channel_observation_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_observation
    ADD CONSTRAINT payment_channel_observation_request_id_fkey FOREIGN KEY (request_id) REFERENCES zzsh_order.payment_request(id);


--
-- Name: payment_channel_transaction payment_channel_transaction_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_transaction
    ADD CONSTRAINT payment_channel_transaction_confirmation_id_fkey FOREIGN KEY (confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: payment_channel_transaction payment_channel_transaction_native_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_transaction
    ADD CONSTRAINT payment_channel_transaction_native_order_id_fkey FOREIGN KEY (native_order_id) REFERENCES zzsh_order.rental_order(id) DEFERRABLE;


--
-- Name: payment_channel_transaction payment_channel_transaction_request_id_native_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_channel_transaction
    ADD CONSTRAINT payment_channel_transaction_request_id_native_order_id_fkey FOREIGN KEY (request_id, native_order_id) REFERENCES zzsh_order.payment_request(id, order_id);


--
-- Name: payment_confirmation payment_confirmation_joinpay_anchor_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_joinpay_anchor_id_fkey FOREIGN KEY (joinpay_anchor_id) REFERENCES zzsh_order.payment_channel_transaction(id);


--
-- Name: payment_confirmation payment_confirmation_joinpay_evidence_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_joinpay_evidence_fk FOREIGN KEY (joinpay_evidence_id, joinpay_request_id) REFERENCES zzsh_order.joinpay_collection_evidence(id, request_id);


--
-- Name: payment_confirmation payment_confirmation_joinpay_request_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_joinpay_request_fk FOREIGN KEY (joinpay_request_id, order_id) REFERENCES zzsh_order.payment_request(id, order_id);


--
-- Name: payment_confirmation payment_confirmation_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_confirmation
    ADD CONSTRAINT payment_confirmation_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: payment_distribution_basis payment_distribution_basis_admission_id_order_id_admission_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_admission_id_order_id_admission_fkey FOREIGN KEY (admission_id, order_id, admission_revision) REFERENCES zzsh_order.distribution_order_admission(id, order_id, revision);


--
-- Name: payment_distribution_basis payment_distribution_basis_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: payment_distribution_basis payment_distribution_basis_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_distribution_basis
    ADD CONSTRAINT payment_distribution_basis_payment_confirmation_id_fkey FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: payment_request payment_request_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.payment_request
    ADD CONSTRAINT payment_request_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: personal_finance_observation personal_finance_observation_basis_id_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation
    ADD CONSTRAINT personal_finance_observation_basis_id_user_id_fkey FOREIGN KEY (basis_id, user_id) REFERENCES zzsh_order.finance_opening_basis(id, user_id);


--
-- Name: personal_finance_observation_coverage personal_finance_observation_coverage_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation_coverage
    ADD CONSTRAINT personal_finance_observation_coverage_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: personal_finance_observation personal_finance_observation_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.personal_finance_observation
    ADD CONSTRAINT personal_finance_observation_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: prestart_termination_decision prestart_termination_decision_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination_decision
    ADD CONSTRAINT prestart_termination_decision_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: prestart_termination_decision prestart_termination_decision_session_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination_decision
    ADD CONSTRAINT prestart_termination_decision_session_id_fkey FOREIGN KEY (session_id) REFERENCES zzsh_auth_admin.session(id);


--
-- Name: prestart_termination_decision prestart_termination_decision_termination_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination_decision
    ADD CONSTRAINT prestart_termination_decision_termination_id_fkey FOREIGN KEY (termination_id) REFERENCES zzsh_order.prestart_termination(id);


--
-- Name: prestart_termination prestart_termination_liability_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_liability_event_id_fkey FOREIGN KEY (liability_event_id) REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: prestart_termination prestart_termination_liability_root_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_liability_root_id_fkey FOREIGN KEY (liability_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: prestart_termination prestart_termination_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: prestart_termination prestart_termination_requested_by_admin_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_requested_by_admin_fk FOREIGN KEY (requested_by_admin_user_id) REFERENCES zzsh_auth_admin."user"(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: prestart_termination prestart_termination_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.prestart_termination
    ADD CONSTRAINT prestart_termination_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rental_opening_ack rental_opening_ack_opening_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening_ack
    ADD CONSTRAINT rental_opening_ack_opening_id_fkey FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id);


--
-- Name: rental_opening_ack rental_opening_ack_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening_ack
    ADD CONSTRAINT rental_opening_ack_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rental_opening rental_opening_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening
    ADD CONSTRAINT rental_opening_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: rental_opening rental_opening_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_opening
    ADD CONSTRAINT rental_opening_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: rental_order rental_order_account_owner_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_account_owner_fk FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: rental_order rental_order_applied_payment_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_applied_payment_fk FOREIGN KEY (id, paid_confirmation_id, payment_disposition) REFERENCES zzsh_order.payment_confirmation(order_id, id, disposition);


--
-- Name: rental_order rental_order_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: rental_order rental_order_listing_account_fk; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_listing_account_fk FOREIGN KEY (listing_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: rental_order rental_order_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rental_order rental_order_renter_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_renter_user_id_fkey FOREIGN KEY (renter_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rental_order rental_order_rule_release_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_order
    ADD CONSTRAINT rental_order_rule_release_id_fkey FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: rental_referral_earning rental_referral_earning_beneficiary_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_beneficiary_user_id_fkey FOREIGN KEY (beneficiary_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rental_referral_earning rental_referral_earning_economic_root_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_economic_root_id_fkey FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id);


--
-- Name: rental_referral_earning rental_referral_earning_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: rental_referral_earning rental_referral_earning_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_payment_confirmation_id_fkey FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: rental_referral_earning rental_referral_earning_posting_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_earning
    ADD CONSTRAINT rental_referral_earning_posting_id_fkey FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id);


--
-- Name: rental_referral_reversal_source rental_referral_reversal_source_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_reversal_source
    ADD CONSTRAINT rental_referral_reversal_source_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: rental_referral_reversal_source rental_referral_reversal_source_earning_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_reversal_source
    ADD CONSTRAINT rental_referral_reversal_source_earning_id_fkey FOREIGN KEY (earning_id) REFERENCES zzsh_order.rental_referral_earning(id);


--
-- Name: rental_referral_transition rental_referral_transition_earning_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_earning_id_fkey FOREIGN KEY (earning_id) REFERENCES zzsh_order.rental_referral_earning(id);


--
-- Name: rental_referral_transition rental_referral_transition_finance_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_finance_event_id_fkey FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id);


--
-- Name: rental_referral_transition rental_referral_transition_reversal_source_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.rental_referral_transition
    ADD CONSTRAINT rental_referral_transition_reversal_source_id_fkey FOREIGN KEY (reversal_source_id) REFERENCES zzsh_order.rental_referral_reversal_source(id);


--
-- Name: settlement_decision settlement_decision_settlement_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_decision
    ADD CONSTRAINT settlement_decision_settlement_version_id_fkey FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id);


--
-- Name: settlement_intake settlement_intake_opening_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_intake
    ADD CONSTRAINT settlement_intake_opening_id_fkey FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id);


--
-- Name: settlement_intake settlement_intake_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_intake
    ADD CONSTRAINT settlement_intake_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: settlement_intake settlement_intake_settlement_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_intake
    ADD CONSTRAINT settlement_intake_settlement_version_id_fkey FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_counterparty_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_counterparty_user_id_fkey FOREIGN KEY (counterparty_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_finance_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_finance_event_id_fkey FOREIGN KEY (finance_event_id) REFERENCES zzsh_order.finance_event(id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_posting_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_posting_id_fkey FOREIGN KEY (posting_id) REFERENCES zzsh_order.settlement_posting(id);


--
-- Name: settlement_ledger_entry settlement_ledger_entry_source_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_ledger_entry
    ADD CONSTRAINT settlement_ledger_entry_source_payment_confirmation_id_fkey FOREIGN KEY (source_payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: settlement_posting settlement_posting_approval_approved_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_approval_approved_by_fkey FOREIGN KEY (approval_approved_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: settlement_posting settlement_posting_approval_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: settlement_posting settlement_posting_approval_requested_by_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_approval_requested_by_fkey FOREIGN KEY (approval_requested_by) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: settlement_posting settlement_posting_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: settlement_posting settlement_posting_payment_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_payment_confirmation_id_fkey FOREIGN KEY (payment_confirmation_id) REFERENCES zzsh_order.payment_confirmation(id);


--
-- Name: settlement_posting settlement_posting_settlement_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_posting
    ADD CONSTRAINT settlement_posting_settlement_version_id_fkey FOREIGN KEY (settlement_version_id) REFERENCES zzsh_order.settlement_version(id);


--
-- Name: settlement_version settlement_version_approval_request_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES zzsh_iam.approval_request(id);


--
-- Name: settlement_version settlement_version_opening_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_opening_id_fkey FOREIGN KEY (opening_id) REFERENCES zzsh_order.rental_opening(id);


--
-- Name: settlement_version settlement_version_order_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.settlement_version
    ADD CONSTRAINT settlement_version_order_id_fkey FOREIGN KEY (order_id) REFERENCES zzsh_order.rental_order(id);


--
-- Name: wallet_coverage wallet_coverage_basis_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_basis_id_fkey FOREIGN KEY (basis_id) REFERENCES zzsh_order.finance_opening_basis(id);


--
-- Name: wallet_coverage wallet_coverage_opening_event_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_opening_event_id_fkey FOREIGN KEY (opening_event_id) REFERENCES zzsh_order.finance_event(id);


--
-- Name: wallet_coverage wallet_coverage_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_coverage
    ADD CONSTRAINT wallet_coverage_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: wallet_revision wallet_revision_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.wallet_revision
    ADD CONSTRAINT wallet_revision_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: withdrawal_bank_binding withdrawal_bank_binding_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_order; Owner: -
--

ALTER TABLE ONLY zzsh_order.withdrawal_bank_binding
    ADD CONSTRAINT withdrawal_bank_binding_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rule_acceptance acceptance_listing_account_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT acceptance_listing_account_fk FOREIGN KEY (listing_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: rule_acceptance acceptance_owner_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT acceptance_owner_fk FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: account_guarantee_proof account_guarantee_proof_account_owner_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_account_owner_fk FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: account_guarantee_proof account_guarantee_proof_price_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_price_version_id_fkey FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id);


--
-- Name: account_guarantee_proof account_guarantee_proof_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES zzsh_supply.account_guarantee_proof(id);


--
-- Name: account_guarantee_proof account_guarantee_proof_verified_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.account_guarantee_proof
    ADD CONSTRAINT account_guarantee_proof_verified_by_admin_id_fkey FOREIGN KEY (verified_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: admin_supply_scope admin_supply_scope_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.admin_supply_scope
    ADD CONSTRAINT admin_supply_scope_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE CASCADE;


--
-- Name: admin_supply_scope admin_supply_scope_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.admin_supply_scope
    ADD CONSTRAINT admin_supply_scope_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: admin_supply_scope admin_supply_scope_granted_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.admin_supply_scope
    ADD CONSTRAINT admin_supply_scope_granted_by_admin_id_fkey FOREIGN KEY (granted_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: agreement_version agreement_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.agreement_version
    ADD CONSTRAINT agreement_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: agreement_version agreement_version_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.agreement_version
    ADD CONSTRAINT agreement_version_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: agreement_version agreement_version_sealed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.agreement_version
    ADD CONSTRAINT agreement_version_sealed_by_admin_id_fkey FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: media_asset asset_account_owner_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT asset_account_owner_fk FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: billable_item billable_item_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.billable_item
    ADD CONSTRAINT billable_item_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: billable_item billable_item_media_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.billable_item
    ADD CONSTRAINT billable_item_media_fk FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: rental_account current_listing_account_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rental_account
    ADD CONSTRAINT current_listing_account_fk FOREIGN KEY (current_version_id, id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: duplicate_hint duplicate_hint_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.duplicate_hint
    ADD CONSTRAINT duplicate_hint_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: duplicate_hint duplicate_hint_related_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.duplicate_hint
    ADD CONSTRAINT duplicate_hint_related_account_id_fkey FOREIGN KEY (related_account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: duplicate_hint duplicate_hint_reviewer_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.duplicate_hint
    ADD CONSTRAINT duplicate_hint_reviewer_admin_id_fkey FOREIGN KEY (reviewer_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: entitlement entitlement_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.entitlement
    ADD CONSTRAINT entitlement_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: favorite favorite_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.favorite
    ADD CONSTRAINT favorite_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: favorite favorite_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.favorite
    ADD CONSTRAINT favorite_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: firearm_alias firearm_alias_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: firearm_alias firearm_alias_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: firearm_alias firearm_alias_same_game_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_same_game_fk FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id);


--
-- Name: firearm_alias firearm_alias_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_alias
    ADD CONSTRAINT firearm_alias_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: firearm_classification firearm_classification_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: firearm_classification firearm_classification_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: firearm firearm_classification_same_game_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_classification_same_game_fk FOREIGN KEY (game_id, classification_id) REFERENCES zzsh_supply.firearm_classification(game_id, id);


--
-- Name: firearm_classification firearm_classification_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm_classification
    ADD CONSTRAINT firearm_classification_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: firearm firearm_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: firearm firearm_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: firearm firearm_media_same_game_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_media_same_game_fk FOREIGN KEY (game_id, media_id) REFERENCES zzsh_supply.media_asset(game_id, id);


--
-- Name: firearm firearm_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.firearm
    ADD CONSTRAINT firearm_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: full_payout_terms_version full_payout_terms_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.full_payout_terms_version
    ADD CONSTRAINT full_payout_terms_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: full_payout_terms_version full_payout_terms_version_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.full_payout_terms_version
    ADD CONSTRAINT full_payout_terms_version_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: full_payout_terms_version full_payout_terms_version_sealed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.full_payout_terms_version
    ADD CONSTRAINT full_payout_terms_version_sealed_by_admin_id_fkey FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: game game_cover_media_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game
    ADD CONSTRAINT game_cover_media_fk FOREIGN KEY (cover_media_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: game game_current_release_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game
    ADD CONSTRAINT game_current_release_fk FOREIGN KEY (current_release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: game_service_operation game_service_operation_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.game_service_operation
    ADD CONSTRAINT game_service_operation_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: gunsmith_code gunsmith_code_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.gunsmith_code
    ADD CONSTRAINT gunsmith_code_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: gunsmith_code gunsmith_code_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.gunsmith_code
    ADD CONSTRAINT gunsmith_code_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: gunsmith_code gunsmith_code_same_game_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.gunsmith_code
    ADD CONSTRAINT gunsmith_code_same_game_fk FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id);


--
-- Name: gunsmith_code gunsmith_code_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.gunsmith_code
    ADD CONSTRAINT gunsmith_code_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: inventory_line inventory_line_item_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.inventory_line
    ADD CONSTRAINT inventory_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES zzsh_supply.billable_item(id);


--
-- Name: inventory_line inventory_line_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.inventory_line
    ADD CONSTRAINT inventory_line_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: legacy_listing_display_snapshot legacy_display_version_account_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_display_snapshot
    ADD CONSTRAINT legacy_display_version_account_fk FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: legacy_listing_display_snapshot legacy_listing_display_snapshot_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_display_snapshot
    ADD CONSTRAINT legacy_listing_display_snapshot_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.legacy_listing_read_snapshot(account_id);


--
-- Name: legacy_listing_display_snapshot legacy_listing_display_snapshot_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_display_snapshot
    ADD CONSTRAINT legacy_listing_display_snapshot_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legacy_listing_read_snapshot legacy_listing_read_snapshot_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_read_snapshot
    ADD CONSTRAINT legacy_listing_read_snapshot_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: legacy_listing_read_snapshot legacy_listing_read_snapshot_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_read_snapshot
    ADD CONSTRAINT legacy_listing_read_snapshot_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: legacy_listing_read_snapshot legacy_listing_read_snapshot_observation_version_id_accoun_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_read_snapshot
    ADD CONSTRAINT legacy_listing_read_snapshot_observation_version_id_accoun_fkey FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: legacy_listing_read_snapshot legacy_listing_read_snapshot_source_system_source_entity_l_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_listing_read_snapshot
    ADD CONSTRAINT legacy_listing_read_snapshot_source_system_source_entity_l_fkey FOREIGN KEY (source_system, source_entity, legacy_id) REFERENCES zzsh_supply.legacy_supply_map(source_system, source_entity, legacy_id);


--
-- Name: legacy_skin_holding legacy_skin_holding_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_skin_holding
    ADD CONSTRAINT legacy_skin_holding_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id) ON DELETE RESTRICT;


--
-- Name: legacy_skin_holding legacy_skin_holding_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_skin_holding
    ADD CONSTRAINT legacy_skin_holding_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT;


--
-- Name: legacy_skin_holding legacy_skin_holding_observation_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_skin_holding
    ADD CONSTRAINT legacy_skin_holding_observation_version_id_fkey FOREIGN KEY (observation_version_id) REFERENCES zzsh_supply.listing_version(id) ON DELETE RESTRICT;


--
-- Name: legacy_supply_map legacy_supply_map_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_supply_map
    ADD CONSTRAINT legacy_supply_map_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: legacy_supply_map legacy_supply_map_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.legacy_supply_map
    ADD CONSTRAINT legacy_supply_map_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: listing_entitlement listing_entitlement_entitlement_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_entitlement
    ADD CONSTRAINT listing_entitlement_entitlement_id_fkey FOREIGN KEY (entitlement_id) REFERENCES zzsh_supply.entitlement(id);


--
-- Name: listing_entitlement listing_entitlement_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_entitlement
    ADD CONSTRAINT listing_entitlement_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: listing_filter_config listing_filter_config_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_filter_config
    ADD CONSTRAINT listing_filter_config_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: listing_filter_config listing_filter_config_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_filter_config
    ADD CONSTRAINT listing_filter_config_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: listing_filter_config listing_filter_config_game_id_restore_from_revision_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_filter_config
    ADD CONSTRAINT listing_filter_config_game_id_restore_from_revision_fkey FOREIGN KEY (game_id, restore_from_revision) REFERENCES zzsh_supply.listing_filter_config(game_id, revision);


--
-- Name: listing_media listing_media_asset_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_media
    ADD CONSTRAINT listing_media_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: listing_media listing_media_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_media
    ADD CONSTRAINT listing_media_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: listing_publication listing_publication_acceptance_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_acceptance_fk FOREIGN KEY (owner_user_id, version_id, rule_release_id, content_hash) REFERENCES zzsh_supply.rule_acceptance(owner_user_id, listing_version_id, rule_release_id, accepted_content_hash);


--
-- Name: listing_publication listing_publication_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: listing_publication listing_publication_owner_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_owner_fk FOREIGN KEY (account_id, owner_user_id) REFERENCES zzsh_supply.rental_account(id, owner_user_id);


--
-- Name: listing_publication listing_publication_published_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_published_by_admin_id_fkey FOREIGN KEY (published_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: listing_publication listing_publication_published_by_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_published_by_user_id_fkey FOREIGN KEY (published_by_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: listing_publication listing_publication_rule_release_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_rule_release_id_fkey FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: listing_publication listing_publication_version_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_publication
    ADD CONSTRAINT listing_publication_version_fk FOREIGN KEY (version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id);


--
-- Name: listing_skin listing_skin_skin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_skin
    ADD CONSTRAINT listing_skin_skin_id_fkey FOREIGN KEY (skin_id) REFERENCES zzsh_supply.skin(id);


--
-- Name: listing_skin listing_skin_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_skin
    ADD CONSTRAINT listing_skin_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: listing_version listing_version_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_version
    ADD CONSTRAINT listing_version_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: listing_version listing_version_rule_release_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.listing_version
    ADD CONSTRAINT listing_version_rule_release_id_fkey FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: media_asset media_asset_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: media_asset media_asset_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: media_asset media_asset_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: media_asset media_asset_reviewed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_reviewed_by_admin_id_fkey FOREIGN KEY (reviewed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: media_asset media_asset_uploaded_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_uploaded_by_admin_id_fkey FOREIGN KEY (uploaded_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: media_asset media_asset_uploaded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_asset
    ADD CONSTRAINT media_asset_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: media_upload_intent media_upload_intent_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: media_upload_intent media_upload_intent_asset_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_asset_fk FOREIGN KEY (consumed_asset_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: media_upload_intent media_upload_intent_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: media_upload_intent media_upload_intent_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: media_upload_intent media_upload_intent_uploaded_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_uploaded_by_admin_id_fkey FOREIGN KEY (uploaded_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: media_upload_intent media_upload_intent_uploaded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.media_upload_intent
    ADD CONSTRAINT media_upload_intent_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: price_line price_line_item_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_line
    ADD CONSTRAINT price_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES zzsh_supply.billable_item(id);


--
-- Name: price_line price_line_price_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_line
    ADD CONSTRAINT price_line_price_version_id_fkey FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id);


--
-- Name: price_version price_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_version
    ADD CONSTRAINT price_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: price_version price_version_full_payout_terms_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_version
    ADD CONSTRAINT price_version_full_payout_terms_version_id_fkey FOREIGN KEY (full_payout_terms_version_id) REFERENCES zzsh_supply.full_payout_terms_version(id);


--
-- Name: price_version price_version_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_version
    ADD CONSTRAINT price_version_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: price_version price_version_sealed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.price_version
    ADD CONSTRAINT price_version_sealed_by_admin_id_fkey FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: profile_avatar profile_avatar_current_asset_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar
    ADD CONSTRAINT profile_avatar_current_asset_id_fkey FOREIGN KEY (current_asset_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: profile_avatar profile_avatar_last_review_asset_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar
    ADD CONSTRAINT profile_avatar_last_review_asset_id_fkey FOREIGN KEY (last_review_asset_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: profile_avatar profile_avatar_latest_upload_intent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar
    ADD CONSTRAINT profile_avatar_latest_upload_intent_id_fkey FOREIGN KEY (latest_upload_intent_id) REFERENCES zzsh_supply.media_upload_intent(id);


--
-- Name: profile_avatar profile_avatar_pending_asset_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar
    ADD CONSTRAINT profile_avatar_pending_asset_id_fkey FOREIGN KEY (pending_asset_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: profile_avatar_policy profile_avatar_policy_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.profile_avatar_policy
    ADD CONSTRAINT profile_avatar_policy_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: rental_account rental_account_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rental_account
    ADD CONSTRAINT rental_account_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: rental_account rental_account_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rental_account
    ADD CONSTRAINT rental_account_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: review_decision review_decision_release_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.review_decision
    ADD CONSTRAINT review_decision_release_id_fkey FOREIGN KEY (release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: review_decision review_decision_reviewer_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.review_decision
    ADD CONSTRAINT review_decision_reviewer_admin_id_fkey FOREIGN KEY (reviewer_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: review_decision review_decision_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.review_decision
    ADD CONSTRAINT review_decision_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.listing_version(id);


--
-- Name: rule_acceptance rule_acceptance_account_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_account_id_fkey FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id);


--
-- Name: rule_acceptance rule_acceptance_full_payout_terms_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_full_payout_terms_version_id_fkey FOREIGN KEY (full_payout_terms_version_id) REFERENCES zzsh_supply.full_payout_terms_version(id);


--
-- Name: rule_acceptance rule_acceptance_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES zzsh_auth_user."user"(id);


--
-- Name: rule_acceptance rule_acceptance_rule_release_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_acceptance
    ADD CONSTRAINT rule_acceptance_rule_release_id_fkey FOREIGN KEY (rule_release_id) REFERENCES zzsh_supply.rule_release(id);


--
-- Name: rule_release rule_release_activated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_activated_by_admin_id_fkey FOREIGN KEY (activated_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: rule_release rule_release_agreement_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_agreement_version_id_fkey FOREIGN KEY (agreement_version_id) REFERENCES zzsh_supply.agreement_version(id);


--
-- Name: rule_release rule_release_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: rule_release rule_release_price_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_price_version_id_fkey FOREIGN KEY (price_version_id) REFERENCES zzsh_supply.price_version(id);


--
-- Name: rule_release rule_release_term_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.rule_release
    ADD CONSTRAINT rule_release_term_version_id_fkey FOREIGN KEY (term_version_id) REFERENCES zzsh_supply.term_version(id);


--
-- Name: skin_category skin_category_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_category
    ADD CONSTRAINT skin_category_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: skin skin_category_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_category_id_fkey FOREIGN KEY (category_id) REFERENCES zzsh_supply.skin_category(id);


--
-- Name: skin_category skin_category_parent_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_category
    ADD CONSTRAINT skin_category_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES zzsh_supply.skin_category(id);


--
-- Name: skin skin_firearm_same_game_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_firearm_same_game_fk FOREIGN KEY (game_id, firearm_id) REFERENCES zzsh_supply.firearm(game_id, id) ON DELETE RESTRICT;


--
-- Name: skin skin_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: skin skin_media_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_media_fk FOREIGN KEY (media_id) REFERENCES zzsh_supply.media_asset(id);


--
-- Name: skin_owner skin_owner_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_owner
    ADD CONSTRAINT skin_owner_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: skin skin_owner_same_game_kind_fk; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin
    ADD CONSTRAINT skin_owner_same_game_kind_fk FOREIGN KEY (game_id, owner_kind, owner_id) REFERENCES zzsh_supply.skin_owner(game_id, kind, id) ON DELETE RESTRICT;


--
-- Name: skin_rarity skin_rarity_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.skin_rarity
    ADD CONSTRAINT skin_rarity_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: term_option term_option_version_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_option
    ADD CONSTRAINT term_option_version_id_fkey FOREIGN KEY (version_id) REFERENCES zzsh_supply.term_version(id);


--
-- Name: term_version term_version_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_version
    ADD CONSTRAINT term_version_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- Name: term_version term_version_game_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_version
    ADD CONSTRAINT term_version_game_id_fkey FOREIGN KEY (game_id) REFERENCES zzsh_supply.game(id);


--
-- Name: term_version term_version_sealed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: zzsh_supply; Owner: -
--

ALTER TABLE ONLY zzsh_supply.term_version
    ADD CONSTRAINT term_version_sealed_by_admin_id_fkey FOREIGN KEY (sealed_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);


--
-- PostgreSQL database dump complete
--



COMMENT ON TABLE zzsh_business_meta.migrations IS '业务数据库版本账；记录canonical迁移或明确initial baseline及其后续增量，不是订单、资金或业务审计流水。表由Drizzle migrator创建；不把元数据账伪造成业务记录。';
COMMENT ON COLUMN zzsh_business_meta.migrations.id IS '本表记账行的本地自增主键，不等于canonical的迁移编号idx。';
COMMENT ON COLUMN zzsh_business_meta.migrations.hash IS '本次已记账迁移SQL正文的SHA-256；initial时是四段组合hash，一条baseline不是152次原链执行。';
COMMENT ON COLUMN zzsh_business_meta.migrations.created_at IS 'journal中该迁移的folderMillis时间戳，单位毫秒；用于迁移前缀和排序，不是实际执行完成时间。';
