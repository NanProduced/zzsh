-- Forward-only candidate; assign its canonical number after all active branches are integrated.
COMMENT ON COLUMN zzsh_iam.im_support_presence.auth_session_id IS '当前接待状态所属的管理员会话；未绑定时不可自动派单';
