-- 保持已发布的客服接待结构不变，补充中文字段说明。
COMMENT ON COLUMN zzsh_iam.im_support_presence.last_confirmed_at IS '服务端最后确认存活的时间，包含已连接心跳与锁屏页面心跳';
COMMENT ON COLUMN zzsh_iam.im_support_presence.disconnected_since IS '本次云信断连首次被观察到的时间，确认连接后清空';
COMMENT ON COLUMN zzsh_iam.im_support_presence.dispatch_paused IS '保留接待状态但暂停分配新会话';
COMMENT ON COLUMN zzsh_iam.im_support_presence.state_revision IS '服务端递增的状态修订号，用于拒绝过期心跳';
COMMENT ON COLUMN zzsh_iam.im_support_presence.connection_id IS '持有云信登录和连接租约的标签页或窗口标识';
COMMENT ON COLUMN zzsh_iam.im_support_presence.connection_expires_at IS '连接租约的截止时间，由持有窗口续期';
COMMENT ON COLUMN zzsh_iam.im_support_presence_session.metric_version IS '接待计时口径版本：一为连接时长，二为接待状态开启时长';
