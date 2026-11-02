# 线上团队测试服务器准备

本环境供老板和团队体验完整主流程，使用独立资源与访问身份。它可以承接真实旧数据副本，但不是生产服务，也不连接旧平台在线写库。域名、地域和服务器尚待Owner提供，当前未部署。

## 先准备的资源

| 项目 | 准备内容 |
|---|---|
| 服务器与访问 | Linux长期支持版本、64位、SSH配置名/密钥引用、非root部署用户、允许维护者访问；系统自动安全更新、时钟同步。首次只需一套API/Next/静态Admin，不增加Kubernetes或多套临时环境 |
| 容量 | 提供实际CPU/内存/磁盘/带宽配额。构建尽量在CI/独立构建机完成；运行、迁移和压测分别记录峰值，再定容。磁盘须覆盖当前库、源dump、转换中间件、一次可恢复备份与日志余量，不能按压缩dump大小估算数据库空间 |
| 网络 | 同地域VPC内连接PostgreSQL/Redis/OSS，数据库与Redis不开放公网；入口HTTPS，SSH只对维护者IP。API3102与Next3100只绑定本机/私网；Admin静态资源由反代提供 |
| 域名/TLS | 用户、Admin、API三个Origin和对应证书、DNS、续期责任；回调URL预留HTTPS。证书主机名与实际数据库/Redis连接地址匹配 |
| 数据 | 独立 `zzsh_ecs_test*` 目标和独立owner/migration/runtime；生产切换改 `zzsh_prod*`，不改同一库的身份假装换环境。先装已封版initial+尾迁移+runtime ACL，再转换旧源，不能直接对私有IM账本跑canonical全链 |
| 对象存储 | 新团队测试private Bucket和独立前缀/身份；迁移引用对象与默认头像初始化、逐对象SHA/MIME读回，再切运行配置。品牌/字体/插画随构建部署，数据库备份放独立受限位置 |
| 三方 | 按[配置清单](deployment-prerequisites.md)准备SMS、实名、云信、汇聚及银行卡保护钥；通知域名、白名单、用途和费用上限随版本记录 |
| 恢复与观察 | 数据库自动备份/PITR能力与一次真实恢复验证；日志轮转、磁盘/内存/错误率/延迟告警；备份加密、访问控制、保留周期与恢复负责人 |

PostgreSQL与Redis部署连接校验证书，不使用跳过验证的TLS。云上实例开通/更新加密前需核对客户端支持、连接地址与证书；不是只改一个端口。[RDS PostgreSQL说明](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/forcefully-enable-ssl-connections-on-the-client)、[Tair/Redis TLS说明](https://help.aliyun.com/zh/redis/user-guide/enable-tls-encryption)。

## 三端部署关系

- 用户域名反代到Next生产进程；用户 `/api/*` 经既有Web BFF转发，Next服务端设置 `ZZSH_API_ORIGIN` / `ZZSH_WEB_ORIGIN`，不向浏览器暴露密钥。
- Admin域名提供 `apps/admin/dist` 静态文件；其 `/api/*` 原路径代理API（`/api/bff/admin`、认证路径保留，不另造业务规则）；SPA路由fallback不能覆盖 `/api` 错误与媒体响应。`vite dev/preview`不是生产服务器。
- API域名承接明确的公开/认证/BFF/供应商回调路径。反代清理客户端伪造内部头，再写真实IP；只信任已知代理。不要给全部来源加CORS，不把数据库或owner工具挂到公网。
- 服务由systemd或等效管理器运行，固定Node24基线与lockfile构建；SIGTERM优雅停机、readiness摘流、错误日志脱敏。敏感环境由受限服务配置/文件注入，不复制本机 `.env`、TOTP或fixture到服务器。

## 部署顺序与进入体验条件

1. 固定同一RC的Git提交、构建摘要、initial和尾迁移摘要；本地全量安装/升级、核心业务、双端与权限反例通过，明确仍缺的外部条件。
2. 备份新目标当前状态并试恢复；确认maintenance/migration/runtime三种身份、真实OID、TLS、schema与权限。安装与数据转换分开留回执，UNKNOWN按原键恢复，不换键重发。
3. 使用授权的线上MySQL**冻结副本**转换：主体→目录/账号→订单/责任→资金观察/期初→媒体引用；金额/关系/状态与隔离项对账。原dump、原键和异常保留，历史数据不直接变成当前可租或渠道已到账。
4. 上传并核验OSS初始对象；部署API→Web/Admin，同版检查登录、浏览/上架、下单、客服开租、结算/退款、钱包和Admin读取。模拟支付与真实渠道样本必须显式分开，不向团队呈现假到账。
5. 开放指定团队身份；体验页面标清测试环境及数据截止时间、可操作范围、反馈入口。含真实数据副本时按角色最小可见，限制导出；反馈附页面/场景/期望/实际，不收集密码或完整证件。

迁移每阶段记录开始/结束、行数/字节数、吞吐、批量大小、锁等待、重放/隔离/恢复耗时与峰值资源。区分可提前准备、停写窗口必做和可后补工作。本地冻结副本的耗时用于发现瓶颈；线上停机预算需以最新数据量和目标机器实测确定，不能直接照搬。

回退按应用版本与兼容的前向schema/数据恢复合同执行；不盲跑down SQL、不覆盖已接纳资金事实。没有通过恢复与核心链路检查前，不将服务器开放给团队使用。
