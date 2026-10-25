# 项目文档

本目录保存当前架构、接口契约、必要运行说明，以及明确区分实现状态的已确认业务规则。

- [技术选择](architecture/technology-decisions.md)
- [仓库结构](architecture/repository-layout.md)
- [多端与 BFF](architecture/multi-client-bff.md)
- [供给目录、管理权限与会员计价术语](architecture/GLOSSARY.md)
- [API v1 契约](architecture/api-v1-contract.md)
- [三角洲租赁业务边界](architecture/rental-business-rules.md)（已确认要求与当前实现范围分开）
- [新旧交易与结算行为对照](architecture/legacy-business-behavior-diff.md)（测试用预期变更、保留行为与证据边界）
- [旧数据转换与字段映射](architecture/legacy-data-mapping.md)（源字段、目标、接口及双端消费；规则变更对照）
- [数据库结构导航](architecture/database-navigation.md)（源码 102 份业务迁移 0000–0101、实际执行状态分别核验）
- [用户供给表单数据契约](architecture/supply-form-contract.md)
- [租赁会员、个人确认与建单](architecture/personal-confirmation.md)
- [公开交易统计读取](architecture/public-trade-activity.md)
- [旧交易续办与责任边界](architecture/legacy-trade-continuation.md)
- [会员成长与人工礼遇](architecture/membership-growth.md)
- [信用与号主保证金运行合同](architecture/credit-guarantee.md)
- [管理端用户详情与权限边界](architecture/admin-user-directory.md)
- [分销与本地提现](architecture/distribution-and-withdrawal.md)
- [开租与结算确认](architecture/settlement-confirmation.md)
- [公开列表组合筛选与配置](architecture/listing-query.md)
- [账号公开查看、可租状态与编号](architecture/account-visibility.md)
- [认证与账号安全](architecture/authentication.md)
- [开发与验证](development.md)
- [测试、验证与验收脚本规范](testing.md)
- [本地环境协作规则](local-environments.md)
- [本地测试快速登录](local-test-auth.md)
- [本地 PostgreSQL 使用规范](local-postgresql.md)
- [第三方前端来源](third-party-ui.md)
- [Serena 范围](serena.md)
- [Logo 物料](../assets/brand/README.md)
- [管理端产品](../apps/admin/PRODUCT.md) / [设计](../apps/admin/DESIGN.md)

计划、进度、调研、任务 prompt、截图及审核过程保存在被忽略的根 tmp/，不作为代码仓库交付内容。历史本地资料迁至 tmp/docs/。公开文档不能依赖本地过程资料才能理解项目。已发布的旧文档仍可能存在于 Git 历史，本次不改写历史。
