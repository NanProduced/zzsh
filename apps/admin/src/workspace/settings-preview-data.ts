/** 仅由开发环境的显式示例预览动态加载；不注册写回调、不生成真实操作记录。 */
export function settingsPreviewData(adminUserId: string, sessionId: string) {
  const profile = { adminUserId, zzNumber: "ZZ00000（示例）", displayName: "示例管理员", avatarUrl: null, updatedAt: "2026-10-15T01:00:00.000Z" };
  const sessions = [
    { id: sessionId, isCurrent: true, createdAt: "2026-10-15T01:00:00.000Z", expiresAt: "2026-10-22T01:00:00.000Z", userAgent: "Mozilla/5.0 · 桌面浏览器（示例）", locked: false },
    { id: "preview_other_session", isCurrent: false, createdAt: "2026-10-14T08:30:00.000Z", expiresAt: "2026-10-21T08:30:00.000Z", userAgent: "Mozilla/5.0 · 移动浏览器（示例）", locked: true },
  ];
  const actions = ["admin.password.changed", "admin.pin.unlock", "admin.self.sessions.revoked"];
  const events = actions.map((action, index) => ({
    eventId: `preview_event_${index}`, occurredAt: `2026-10-15T0${3 - index}:00:00.000Z`, action,
    category: index === 0 ? "credential" : index === 1 ? "pin" : "session",
    outcome: index === 1 ? "FAILURE" : "SUCCESS", reason: index === 1 ? "invalid_pin" : null,
    actor: { kind: "self", ref: null }, details: index === 2 ? { scope: "one", revokedSessionCount: 1 } : {},
    requestId: null,
  }));
  return {
    readProfile: async () => profile,
    readSessions: async () => ({ sessions }),
    readActivity: async ({ action }: { action: string }) => ({
      events: action ? events.filter((event) => event.action === action) : events,
      nextCursor: null,
      coverage: { scope: "SELF_SECURITY_ACTIVITY", recordedActions: actions, notRecorded: ["sign_in", "sign_out"] },
    }),
  };
}
