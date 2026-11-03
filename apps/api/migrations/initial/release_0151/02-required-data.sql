-- 洲洲商行业务数据库新装基线：release_0151
-- 本段：必要静态种子。仅canonical权限、内置角色、角色权限、审批模板与头像审核默认单例；禁止导入用户、凭据、会话或交易数据。
-- 来源：canonical前152份SQL至0151_profile_avatar_policy；已执行的旧SQL和journal不改写。
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
-- 原对象COMMENT来自canonical；新增数据库元数据说明须先以前向迁移纳入来源。

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

--
-- Data for Name: account; Type: TABLE DATA; Schema: zzsh_auth_admin; Owner: -
--



--
-- Data for Name: session; Type: TABLE DATA; Schema: zzsh_auth_admin; Owner: -
--



--
-- Data for Name: twoFactor; Type: TABLE DATA; Schema: zzsh_auth_admin; Owner: -
--



--
-- Data for Name: user; Type: TABLE DATA; Schema: zzsh_auth_admin; Owner: -
--



--
-- Data for Name: verification; Type: TABLE DATA; Schema: zzsh_auth_admin; Owner: -
--



--
-- Data for Name: account; Type: TABLE DATA; Schema: zzsh_auth_user; Owner: -
--



--
-- Data for Name: session; Type: TABLE DATA; Schema: zzsh_auth_user; Owner: -
--



--
-- Data for Name: twoFactor; Type: TABLE DATA; Schema: zzsh_auth_user; Owner: -
--



--
-- Data for Name: user; Type: TABLE DATA; Schema: zzsh_auth_user; Owner: -
--



--
-- Data for Name: verification; Type: TABLE DATA; Schema: zzsh_auth_user; Owner: -
--



--
-- Data for Name: carousel_item; Type: TABLE DATA; Schema: zzsh_content; Owner: -
--



--
-- Data for Name: content_item; Type: TABLE DATA; Schema: zzsh_content; Owner: -
--



--
-- Data for Name: content_version; Type: TABLE DATA; Schema: zzsh_content; Owner: -
--



--
-- Data for Name: document_acceptance; Type: TABLE DATA; Schema: zzsh_content; Owner: -
--



--
-- Data for Name: legal_document_version; Type: TABLE DATA; Schema: zzsh_content; Owner: -
--



--
-- Data for Name: credit_event; Type: TABLE DATA; Schema: zzsh_credit; Owner: -
--



--
-- Data for Name: credit_recovery_request; Type: TABLE DATA; Schema: zzsh_credit; Owner: -
--



--
-- Data for Name: user_credit_state; Type: TABLE DATA; Schema: zzsh_credit; Owner: -
--



--
-- Data for Name: admin_auth_captcha_used; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_auth_failure; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_auth_lockout; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_backup_code_generation; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_permission; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--

INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.account.read', '查看管理员', '读取管理员目录与详情', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.account.create', '创建管理员', '创建普通管理员并交付临时密码', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.account.update', '编辑管理员资料', '修改显示名称等非身份字段', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.account.freeze', '冻结管理员', '冻结普通管理员登录与会话', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.account.unfreeze', '解冻管理员', '恢复已冻结的普通管理员', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.role.read', '查看角色', '读取预设角色与权限目录', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.role.configure', '配置角色', '创建或修改预设角色及其权限', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.permission.read', '查看权限', '读取有效权限与个人差异', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.permission.grant', '授予权限', '分配角色及个人允许或禁止', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.template.read', '查看审批模板', '读取当前审批模板与候选人', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.template.configure', '配置审批模板', '配置明确用例的触发条件与候选审批人', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.request.create', '发起审批申请', '提交不可变操作载荷的审批申请', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.request.read', '查看审批申请', '查看本人或本人候选范围内的申请', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.request.approve', '审批申请', '对候选名单内的申请作出首个有效决定', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.request.execute', '执行已批准申请', '执行已批准的受控非资金操作', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.request.add_approver', '追加审批人', '向在途申请追加当前具备审批资格的审批人', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('approval.audit.read', '查询审批审计', '按授权对象范围读取裁剪后的审批审计', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('admin.audit.read', '查询账号与权限审计', '读取白名单内的管理员账号、角色、授权与冻结审计', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.catalog.manage', '维护供给目录', '按游戏对象范围维护计费物品、皮肤分类、皮肤、稀有度与权益', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.rules.edit', '编辑规则草稿', '创建和编辑价格、租期与协议草稿，封存版本', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.rules.activate', '生效规则版本', 'Boss 原子切换当前规则版本', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.quote.internal.read', '读取内部报价', '查看含平台利润与计价依据的内部报价投影', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.restrict', '限制与解除供给', '限制或解除指定范围供给', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.duplicate.review', '供给重复线索', '记录人工重复判断，不自动处置供给', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.review.read', '查看供给与媒体审核', '按显式游戏范围查看供给版本、审核差异和私有审核材料', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.review.decide', '决定供给与媒体审核', '对确切供给版本或媒体材料作出审核决定，保留原因与审计', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.read', '读取游戏内容', '按游戏对象范围读取资讯草稿与发布状态', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.edit', '编辑游戏内容', '按游戏对象范围创建和编辑游戏资讯草稿', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.publish', '发布游戏内容', '按游戏对象范围发布或撤回游戏资讯', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.platform.read', '读取平台内容', '读取平台公告、平台资讯、轮播与平台素材', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.platform.edit', '编辑平台内容', '创建和编辑平台公告、平台资讯、轮播及上传平台素材', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('content.platform.publish', '发布平台内容', '发布或撤回平台内容，审核与撤权平台素材', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.gunsmith.manage', '维护改枪码目录', '按游戏对象范围维护固定枪械目录、分类、别名与改枪码', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('order.read', '订单查询', '按授权范围查询订单', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.read', '查看客服云信', '读取受权客服身份映射并签发当前会话的云信短效 Token', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.accept', '接待客服咨询', '接手服务类咨询并维护当前受权接待关系', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.complaint', '处理投诉反馈', '查看并处理投诉反馈类咨询', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.transfer', '转交客服咨询', '将当前受权咨询转交给另一位合格客服', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.presence', '设置客服在线状态', '维护当前管理员的客服接待状态与云信连接状态', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.rental_membership.manage', '管理租赁会员资格', '受权读取及修改用户租赁会员资格，要求原因与版本校验', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.listing_filters.manage', '管理租号筛选配置', '维护已实现筛选/排序的展示与允许选项，不配置查询逻辑', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('order.settlement.write', '订单结算写入', '录入开租清单、改版结算、提前复核和提交人工调整；不含资金执行', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.guarantee.read', '读取账号保证金核定', '读取受权账号保证金资格事实与版本', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.guarantee.verify', '核定账号保证金', '追加账号保证金满足或无需要求的核定事实', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.guarantee.revoke', '撤销账号保证金核定', '追加账号保证金撤销事实，不改写历史', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.directory.read', '用户目录读取', '读取受权用户目录及基础关联', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('supply.rental_account.read', '资源账号读取', '读取受权资源账号和归属关联', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('personal.distribution.policy.read', '分销政策读取', '读取受权分销经营政策及不可变版本', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('personal.distribution.policy.manage', '分销政策配置', '版本化编辑受权分销经营政策，不授予资金写权限', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('credit.read', '读取用户信用处置', '读取用户信用当前分数、事件和恢复申请', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('credit.decide', '处置用户信用', '确认违约、撤销误判和审核信用恢复', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('credit.guarantee.read', '读取号主保证金', '按用户和出租账号读取保证金收退款及对账依据', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('credit.guarantee.manage', '管理号主保证金', '受权处理保证金状态和渠道对账，不代表渠道到账', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.growth.read.summary', '会员成长摘要读取', '读取授权用户的全站成长摘要，不自动授予范围明细', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.growth.read.detail', '会员成长明细读取', '按管理员game scope读取成长来源明细', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.policy.draft', '会员政策草稿', '保存会员政策草稿并查看差异', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.policy.publish', '会员政策发布', '提交或执行已审批的会员政策发布', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.entitlement.request', '会员礼遇申请', '提交人工礼遇申请', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.entitlement.decide', '会员礼遇决定', '决定人工礼遇审批且不得自审', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.entitlement.execute', '会员礼遇执行', '执行已批准的人工礼遇', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.entitlement.revoke', '会员礼遇撤销', '在授权范围内提交并执行礼遇撤销', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.growth.audit.read', '会员成长审计', '读取会员成长和礼遇审计事件', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('membership.growth.backfill', '会员成长补读', '在授权game scope内重复执行已过账结算的成长补读', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('order.legacy.continue', '旧单续办', '受权处理旧单续办与佣金成熟，财账终定独立', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.wallet.read', '查看用户可用余额', '只读查看受权用户的钱包可用余额；不含提现预留、待结算收益、应退与押金保证金，不授予平台财务或资金命令', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.risk.manage', '维护用户内部高危标识', '标记或取消用户的内部高危标识；客服只读，不联动账号状态、信用、上架或订单资格', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.note.write', '添加用户内部备注', '添加用户内部备注或删除本人备注；不允许修改正文', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.note.manage', '删除任意用户内部备注', '删除任意管理员添加的用户内部备注；不允许修改正文', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.identity.sensitive.read', '查看用户敏感身份资料', '主动查看用户已记录的明文手机号和敏感身份资料；每次查看均审计', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.finance.read', '查看单用户资金', '只读查看授权用户的余额与按游戏范围裁剪的结算消费明细；不授予平台财务、内价或任何资金命令', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.account.freeze', '冻结用户账号', '管理员将 ACTIVE 用户冻结为 FROZEN：suspended=true，撤销全部会话与待用验证凭据；需二次验证与原因；不可作用于 CANCELLED', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.account.unfreeze', '解冻用户账号', '管理员将 FROZEN 用户恢复为 ACTIVE：suspended=false；旧会话不复活；需二次验证与原因', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.account.restore', '恢复停用用户账号（已退役）', '已退役（0103）：自助停用已移除，改用 user.account.freeze / user.account.unfreeze；保留本行仅为历史审计与审批引用', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('finance.withdrawal.query', '同步提现渠道结果', '只查询已派发原提现的渠道结果，可按可信终态推进本站扣账或释放；不含新发提现/代付、重发、换收款目标或强制成功', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('finance.read', '查看资金汇总与账务', '资金查找、期间核对、单用户资金等只读视图；不含任何资金写操作', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('finance.document.read', '查看资金单据', '按单据查看资金凭证与佣金明细；只读', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('user.phone.lookup', '手机号精确查找用户', '在用户目录中按完整手机号精确查找；不展示他人完整手机号列表', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('profile.avatar.review', '审核头像', '审核用户与管理员本人上传的头像；不包含目录素材或其他身份资料', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.management.read', '查看客服管理', '查看统计看板、全部咨询/订单群列表、只读巡视任何会话与交接记录；不含发送或订单写权限', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.audit.takeover', '巡视接管会话', '巡视中把当前咨询责任转给自己；仍复用现有转交与接待资格校验', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.configure', '配置洲洲助手', '修改新咨询轮次的欢迎消息；不含分销策略、返利计算或到账确认', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('im.support.integration.configure', '配置客服消息接入', '配置会话阅读同步的接收开关和公网域名；不含密钥读取或云信控制台开通', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('distribution.dashboard.read', '读取分销看板', '按游戏范围读取分销汇总、佣金明细、分销商及排行；不包含内部计佣基数或资金操作', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_permission (code, name, description, created_at) VALUES ('profile.avatar.policy.manage', '管理头像审核策略', '控制随后提交的用户及管理员自定义头像是否须人工审核；不自动授予素材审核权限', '2026-11-03 10:16:11.332406+00');


--
-- Data for Name: admin_recovery_notification_target; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_recovery_request; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_role; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--

INSERT INTO zzsh_iam.admin_role (id, code, name, description, status, created_at, updated_at) VALUES ('role_preset_ops', 'ops', '运营', '可配置的运营预设角色，权限由配置决定，名称不触发硬编码能力', 'ACTIVE', '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.admin_role (id, code, name, description, status, created_at, updated_at) VALUES ('role_preset_support', 'support', '客服', '可配置的客服预设角色，权限由配置决定，名称不触发硬编码能力', 'ACTIVE', '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');


--
-- Data for Name: admin_role_permission; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--

INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.permission.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.role.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.account.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.audit.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'approval.request.execute');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'approval.request.approve');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'approval.audit.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'finance.withdrawal.query');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'finance.document.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'finance.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'personal.distribution.policy.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'personal.distribution.policy.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.growth.backfill');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.entitlement.decide');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.entitlement.revoke');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.entitlement.execute');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.policy.draft');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.growth.read.detail');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'content.platform.edit');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'content.platform.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'content.publish');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'content.edit');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'credit.guarantee.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'credit.decide');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.rules.edit');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.quote.internal.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.listing_filters.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.gunsmith.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.catalog.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.duplicate.review');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.restrict');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.review.decide');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.review.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.guarantee.revoke');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.guarantee.verify');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.rental_membership.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.risk.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.account.unfreeze');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.account.freeze');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.finance.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.wallet.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.note.manage');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'order.legacy.continue');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.growth.read.summary');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'membership.entitlement.request');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'approval.request.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'approval.request.create');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'content.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'credit.guarantee.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'credit.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.guarantee.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'supply.rental_account.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.note.write');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.phone.lookup');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.directory.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'order.settlement.write');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.presence');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.complaint');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.transfer');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.accept');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'membership.growth.read.summary');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'membership.entitlement.request');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'approval.request.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'approval.request.create');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'content.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'credit.guarantee.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'credit.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'supply.guarantee.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'supply.rental_account.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'user.note.write');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'user.phone.lookup');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'user.directory.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'order.settlement.write');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'im.support.presence');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'im.support.complaint');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'im.support.transfer');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'im.support.accept');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_support', 'im.support.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'user.identity.sensitive.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.account.unfreeze');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.account.freeze');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.account.update');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'admin.account.create');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.management.read');
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code) VALUES ('role_preset_ops', 'im.support.audit.takeover');


--
-- Data for Name: admin_security; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_security_command; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_security_notification_outbox; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_user_permission; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_user_role; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: admin_workspace_layout; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: approval_decision; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: approval_execution; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: approval_request; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: approval_request_candidate; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: approval_template; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--

INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_settle_adj', 'order.settlement.adjust', 'manual-net', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_ent_replace', 'membership.entitlement.replace', 'membership.entitlement.replace.requested', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_ent_revoke', 'membership.entitlement.revoke', 'membership.entitlement.revoke.requested', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_dist_policy', 'distribution.policy.publish', 'distribution.policy.publish.requested', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_mem_policy', 'membership.benefit.policy.publish', 'membership.policy.publish.requested', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version, created_at, updated_at) VALUES ('approval_tpl_default_ent_grant', 'membership.entitlement.grant', 'membership.entitlement.grant.requested', 1, '2026-11-03 10:16:11.332406+00', '2026-11-03 10:16:11.332406+00');


--
-- Data for Name: approval_template_candidate; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: audit_event; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_aftersale_record; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_consultation; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_consultation_event; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_consultation_scope_operation; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_identity_mapping; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_read_copy_position; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_read_copy_settings; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_handover; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_presence; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_presence_session; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_round_rating; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_settings; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: im_support_thread; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_entitlement; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_growth_contribution; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_growth_legacy_coverage; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_growth_legacy_read_admission; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_growth_policy; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: membership_growth_state; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: personal_finance_read_scope; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_identity_display_source; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_identity_state; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_identity_subject; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_identity_verification_attempt; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_identity_verified_profile; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_note; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_registration_fact; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_rental_membership; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: user_risk_flag; Type: TABLE DATA; Schema: zzsh_iam; Owner: -
--



--
-- Data for Name: channel_refund_intent; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: channel_refund_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: controlled_payment_declaration; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: controlled_payout_notice; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: controlled_payout_operation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: distribution_invite_code; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: distribution_order_admission; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: distribution_participant; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: distribution_policy_head; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: distribution_policy_version; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_covered_event; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_economic_root; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_event; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_observation_admission; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_opening_basis; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: finance_stored_opening_review; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_activity; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_due_reminder; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_event; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_group; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_member; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_operation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_stage_card; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: im_order_unread; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: invitation_relation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_account_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_collection_attempt; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_collection_binding; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_collection_evidence; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_collection_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_payout_attempt; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_payout_evidence; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_payout_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_refund_attempt; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_refund_evidence; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_refund_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: joinpay_withdrawal_intent; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_continuation_evidence; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_continuation_version; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_duty_finance_contract; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_duty_finance_fact; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_inflight_register; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_order_duty; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_order_duty_admission; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_order_duty_revision; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_order_read_snapshot; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_owner_guarantee_coverage; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: legacy_owner_guarantee_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: local_controlled_refund_evidence; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: local_controlled_refund_operation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: local_financial_sandbox_registration; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: native_origin_resource_admission; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: native_user_insert_proof; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: owner_guarantee_payment; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: owner_guarantee_reconciliation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: owner_guarantee_refund; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: owner_guarantee_requirement; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: payment_channel_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: payment_channel_transaction; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: payment_confirmation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: payment_distribution_basis; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: payment_request; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: personal_finance_observation; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: personal_finance_observation_coverage; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: prestart_termination; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: prestart_termination_decision; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_opening; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_opening_ack; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_order; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_referral_earning; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_referral_reversal_source; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: rental_referral_transition; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: settlement_decision; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: settlement_intake; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: settlement_ledger_entry; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: settlement_posting; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: settlement_version; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: wallet_coverage; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: wallet_revision; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: withdrawal_admission; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: withdrawal_bank_binding; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: withdrawal_destination; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: withdrawal_intent; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: withdrawal_provider_fact; Type: TABLE DATA; Schema: zzsh_order; Owner: -
--



--
-- Data for Name: account_display_no_counter; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: account_guarantee_proof; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: admin_supply_scope; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: agreement_version; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: billable_item; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: duplicate_hint; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: entitlement; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: favorite; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: firearm; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: firearm_alias; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: firearm_classification; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: full_payout_terms_version; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: game; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: game_service_operation; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: gunsmith_code; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: idempotency_record; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: inventory_line; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: legacy_listing_display_snapshot; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: legacy_listing_read_snapshot; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: legacy_skin_holding; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: legacy_supply_map; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_entitlement; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_filter_config; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_media; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_publication; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_skin; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: listing_version; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: media_asset; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: media_upload_intent; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: price_line; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: price_version; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: profile_avatar; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: profile_avatar_policy; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--

INSERT INTO zzsh_supply.profile_avatar_policy (singleton, requires_review, revision, updated_by_admin_id, updated_at) VALUES (true, true, 1, NULL, '2026-11-03 10:16:16.432733+00');


--
-- Data for Name: rental_account; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: review_decision; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: rule_acceptance; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: rule_release; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: skin; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: skin_category; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: skin_owner; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: skin_rarity; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: term_option; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Data for Name: term_version; Type: TABLE DATA; Schema: zzsh_supply; Owner: -
--



--
-- Name: admin_auth_failure_id_seq; Type: SEQUENCE SET; Schema: zzsh_iam; Owner: -
--

SELECT pg_catalog.setval('zzsh_iam.admin_auth_failure_id_seq', 1, false);


--
-- Name: admin_login_number_seq; Type: SEQUENCE SET; Schema: zzsh_iam; Owner: -
--

SELECT pg_catalog.setval('zzsh_iam.admin_login_number_seq', 1, false);


--
-- Name: display_no_seq; Type: SEQUENCE SET; Schema: zzsh_order; Owner: -
--

SELECT pg_catalog.setval('zzsh_order.display_no_seq', 1, false);


--
-- Name: account_display_no_seq; Type: SEQUENCE SET; Schema: zzsh_supply; Owner: -
--

SELECT pg_catalog.setval('zzsh_supply.account_display_no_seq', 1, false);


--
-- PostgreSQL database dump complete
--


