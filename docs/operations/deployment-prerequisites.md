# 部署配置准备

团队线上测试与正式环境使用同一业务代码和权限合同，分别准备域名、数据库、Bucket、第三方应用和凭据。测试环境中的模拟付款必须明确标识；不得把本地受控成功当作渠道或银行到账。本文是配置准备清单，不是部署验收。

API参考模板为 `apps/api/.env.deployment.example`，Next参考 `apps/web/.env.deployment.example`。部署使用 `npm run start:prod -w @zzsh/api` 或直接运行编译后的main，不自动加载本机 `.env`，由服务管理器注入；本地dev/start脚本仍显式使用Node的 `--env-file-if-exists=.env`。`*_FILE` 使用相对API工作目录的 `.secrets/` 路径，文件只对服务身份与维护者可读；不要在聊天、仓库、前端或日志中粘贴真实值。占位项必须替换，模板不能直接作为可运行配置。

## Owner需要提供的外部配置

| 项目 | 需准备 | 代码配置与边界 |
|---|---|---|
| 网络与域名 | SSH配置名或受限配置路径、服务器/VPC、用户站/管理站/API三个HTTPS Origin、DNS与证书 | `AUTH_USER_ORIGIN`、`AUTH_ADMIN_ORIGIN`、`AUTH_API_ORIGIN`；Next服务端另设 `ZZSH_WEB_ORIGIN`、`ZZSH_API_ORIGIN`。浏览器不能获得内部连接或密钥 |
| PostgreSQL | PostgreSQL16兼容目标、准确库名、独立owner/migration/runtime角色、账号与CA证书、备份恢复位置 | `DB_HOST/PORT/NAME/USER/PASSWORD_FILE`、`DB_TLS_MODE=verify-full`、可选 `DB_TLS_CA_FILE`。runtime无DDL/审计改删；migration单独运行后退出，不交给API |
| Redis | Redis7兼容目标、私网地址、专用ACL用户、密码与CA | `REDIS_HOST/PORT/USER/PASSWORD_FILE`、`REDIS_TLS_MODE=verify-full`、可选 `REDIS_TLS_CA_FILE`。目前用于依赖健康检查；不能宣称业务缓存已搭好 |
| 图片OSS | 独立团队测试Bucket、地域/HTTPS Endpoint、对象前缀、限定该Bucket/前缀的运行身份 | `MEDIA_STORAGE=oss`、`OSS_BUCKET/REGION/ENDPOINT/OBJECT_PREFIX`；当前读取进程 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`、可选 `ALIBABA_CLOUD_SECURITY_TOKEN`。保持private，API授权中继；历史图与4个默认头像先初始化并逐键核SHA/MIME |
| 网易云信 | 团队测试AppKey/AppSecret、已开能力/团队容量、客服与系统身份、HTTPS回调地址和验证方式 | `YUNXIN_APP_KEY`、`YUNXIN_APP_SECRET_FILE`、`ORDER_TEAMS_MEMBERS_LIMIT`；订单群事件另配 `ORDER_IM_EVENTS_ENABLED`、同一 App 的 `ORDER_IM_EVENTS_APP_KEY/APP_SECRET_FILE`。真实App配置与本地fake证据分开；85等暂缓能力不自动开放 |
| 短信 | 已开通账号、审核通过的签名/模板、模板变量、调用权限与费用告警 | `USER_SMS_PROVIDER=aliyun`、`USER_SMS_SIGN_NAME`、独立 `USER_SMS_ACCESS_KEY_ID/SECRET_FILE`；身份验证、注册、登录、绑定分别配置 `USER_SMS_TEMPLATE_IDENTITY/REGISTER/LOGIN/BIND`，未单独设置时使用原 `USER_SMS_TEMPLATE_CODE` 共用模板。管理端系统配置可查看场景与模板来源，不展示密钥；配置存在不代表审核或送达成功。 |
| 实名 | 已订购的阿里云市场二要素服务、独立 AppCode、单人每日次数与最小间隔、已发布隐私/传输披露正文 | 旧站同款设置 `USER_REAL_NAME_PROVIDER=aliyun-market-id2` 与 `USER_REAL_NAME_APPCODE_FILE`；也保留官方直连 `aliyun-id2meta` 及其独立 AccessKey 配置。两者来源单独记录；`USER_REAL_NAME_DAILY_LIMIT`、`USER_REAL_NAME_MIN_INTERVAL_SECONDS` 必填。服务响应成功不等于身份匹配；超时按原键恢复，不能盲重发付费调用 |
| 汇聚收款/退款 | 商户/产品权限、官方接口文档版本和签名样例、签名/验签密钥版本、通知URL、QR允许host、查询/通知与退役原钥保留策略 | `JOINPAY_COLLECTION_CONFIG_FILE`、`JOINPAY_REFUND_CONFIG_FILE`；JSON分别引用 `JOINPAY_COLLECTION_KEY_*(_FILE)`、`JOINPAY_REFUND_KEY_*(_FILE)`。当前渠道没有沙盒，测试账号也不等于无真实资金风险 |
| 汇聚提现/账户查询 | 对应商户产品、原目标与银行编码合同、官方证据/签名版本、通知URL及查询能力 | `JOINPAY_PAYOUT_CONFIG_FILE`、`JOINPAY_ACCOUNTS_CONFIG_FILE`，钥引用 `JOINPAY_PAYOUT_KEY_*(_FILE)`、`JOINPAY_ACCOUNT_KEY_*(_FILE)`（ACCOUNT为单数）；具体JSON见各 `*-runtime.ts` 导出类型与[资金规格](../architecture/payments-and-funds.md) |
| 银行资料保护 | 独立AES-GCM保护钥、当前keyVersion与历史keyring、恢复保管人 | `WITHDRAWAL_BANK_BINDING_CONFIG_FILE`、`WITHDRAWAL_BANK_KEY_*(_FILE)`。不得换钥后丢弃旧版本；资料保存不证明银行实名或代付到账 |
| 经营政策与文书 | 平台经营主体、联系方式；平台服务/隐私/出租/包赔/提前结束正文；真实分销比例、最低计提、期限及审批主体 | 通过正式Admin草稿→封存→生效/双人审批；不在 `.env` 填默认比例、不从本地fixture当正式政策，不修改旧订单快照 |

短信、实名与OSS的RAM授权按用途分开，优先短期凭据/实例角色与最小权限。**现有OSS适配器只有启动时静态凭据，没有STS自动续期**，不能仅注入一次临时Token就宣称长期可用；生产持续凭据供应仍须实际落实。[阿里云凭据安全建议](https://open.aliyun.com/credential-security)、[OSS权限机制](https://help.aliyun.com/zh/oss/how-to-control-access-permissions-on-oss/)。

测试服只发送用户主动请求的验证码；租期到期与号主出号提醒的模板可登记，但自动发送尚未接线。TODO：正式上线前完成提醒触发、去重、失败恢复及受控验证，再明确启用。

## 由实施方生成并保管的应用密钥

以下不是购买第三方服务获得的Key。首次生成一次、按环境隔离，重启/发布不得重抽；备份须与数据恢复方案配套。

| 配置 | 用途 |
|---|---|
| `AUTH_USER_SECRET_FILE` / `AUTH_ADMIN_SECRET_FILE` | 两个认证realm分别的会话/认证保护，必须不同 |
| `ADMIN_ALTCHA_HMAC_KEY_FILE` | 管理员本地证明；部署时固定，不随进程重启改变 |
| `USER_AUTH_THROTTLE_HMAC_KEY_FILE` | 用户节流主体HMAC，与认证secret分离；部署使用postgres共享计数 |
| `USER_IDENTITY_SUBJECT_HMAC_KEY_FILE` | 实名主体稳定摘要，旧数据转换与新核验使用同一环境密钥；独立于会话key，轮换需要专门的主体承接 |
| `ORDER_CONFIRMATION_SECRET_FILE` + `ORDER_CONFIRMATION_KEY_ID` | 个人确认/订单报价令牌 |
| `LISTING_CURSOR_SECRET_FILE` + `LISTING_CURSOR_KEY_ID` | 版本化列表游标 |
| `AUTH_ADMIN_BOOTSTRAP_SECRET_FILE` | 仅首次受控初始化需要；已存在Boss时不重复初始化、不重置TOTP |

银行卡、商户签名以及历史已冻结原号的密钥版本另外保留；禁用新提交不代表可以删除旧QUERY/NOTIFY与原目标解密钥。

## 配置收敛规则

- `ecs-test` / `production` 运行认证、成长、信用、正式结算、分销与客服分发。旧内部 `*_ENABLED=false` 只允许隔离本地夹具；部署时不再靠逐模块开关拼装功能。完整业务装配仍要求真实schema/ACL、准入与政策，不补造缺失事实。
- 渠道选择、目的资源、密钥和计费限制是部署合同，继续保留。汇聚配置内暂停**新**请求与恢复**原**请求的开关是运营能力，不与开发开关一起删除。
- `ENABLE_TEST_OPERATIONS`、固定短信、fake readiness、临时白名单/受控付款宿主不进入部署环境；`USER_AUTH_THROTTLE_MODE=base`保持已接受基线，未批准的candidate阈值不因部署而发布。
- 来源版本、安装/升级步骤、恢复和运行约束留在正式 `docs/`；进度、截图、原始报告和密封回执保存在过程归档，不作为部署入口依赖。

配置齐全之后仍须验证：真实目标身份/TLS/ACL、HTTP上传与撤权、短信与实名真实响应、云信双端完单、汇聚原号查询/回调/退款/提现及异常恢复。配置存在与渠道验收分别记录。
