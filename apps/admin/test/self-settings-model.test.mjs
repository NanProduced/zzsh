import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: adminRoot,
  configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/self-settings-model"),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
after(async () => {
  await vite.close();
});

// model.ts 复用 api.ts 的 AdminApiError；经 Vite 载入，避免 Node strip-only 不支持构造参数属性。
const model = await vite.ssrLoadModule("/src/views/self-settings/model.ts");
const { AdminApiError } = await vite.ssrLoadModule("/src/api.ts");

const {
  ContractViolation,
  DISPLAY_NAME_MAX_CODE_POINTS,
  NOT_PROVIDED_TEXT,
  UNKNOWN_TEXT,
  activityActionLabel,
  activityActorPhrase,
  activityDetailPhrases,
  activityOutcomeLabel,
  activityQueryKey,
  advanceCursorPage,
  atEndOfFeed,
  beijingDateTime,
  canRevokeRow,
  classifyReadFailure,
  cursorAt,
  displayNameIssue,
  emptyCursorPage,
  goBackCursorPage,
  hasActiveActivityFilters,
  otherSessionCount,
  parseActivityPayload,
  parseProfilePayload,
  parseProfileUpdatePayload,
  parseRevokePayload,
  parseSessionsPayload,
  profileDraftChanged,
  readBackProfile,
  reconcileRevokedTarget,
  revokeDoneNotice,
} = model;

function violates(fn, fragment) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ContractViolation, `期望 ContractViolation，实际 ${error?.name}`);
    assert.ok(error.message.includes(fragment), `异常文案应包含「${fragment}」，实际：${error.message}`);
    return true;
  });
}

// 合同 §1.1 脱敏样例
const PROFILE_BODY = {
  adminUserId: "admin_fixture_0001",
  zzNumber: "ZZ00001",
  displayName: "示例管理员",
  avatarUrl: null,
  updatedAt: "2026-10-14T09:12:33.000Z",
};

// ---------------------------------------------------------------------------
// A. 个人资料
// ---------------------------------------------------------------------------

test("profile: 合同样例完整解析；zzNumber 为 null 时保留为未提供而不是内部 ID", () => {
  const facts = parseProfilePayload(PROFILE_BODY);
  assert.equal(facts.adminUserId, "admin_fixture_0001");
  assert.equal(facts.zzNumber, "ZZ00001");
  assert.equal(facts.displayName, "示例管理员");
  assert.equal(facts.avatarUrl, null);
  assert.equal(facts.updatedAt, "2026-10-14T09:12:33.000Z");

  const sparse = parseProfilePayload({ ...PROFILE_BODY, zzNumber: null });
  assert.equal(sparse.zzNumber, null, "历史异常数据返回 null，界面显示未提供，绝不用 UUID 顶替");
});

test("profile: 必填字段缺失、类型错误或时间非法都是合同异常", () => {
  violates(() => parseProfilePayload(null), "不是对象");
  violates(() => parseProfilePayload({ ...PROFILE_BODY, adminUserId: undefined }), "adminUserId");
  violates(() => parseProfilePayload({ ...PROFILE_BODY, displayName: 42 }), "displayName");
  violates(() => parseProfilePayload({ ...PROFILE_BODY, zzNumber: 7 }), "zzNumber");
  violates(() => parseProfilePayload({ ...PROFILE_BODY, updatedAt: null }), "updatedAt");
  violates(() => parseProfilePayload({ ...PROFILE_BODY, updatedAt: "not-a-date" }), "updatedAt");
});

test("profile: 更新信封要求 status:true 且带 profile", () => {
  assert.equal(parseProfileUpdatePayload({ status: true, profile: PROFILE_BODY }).displayName, "示例管理员");
  violates(() => parseProfileUpdatePayload({ status: false, profile: PROFILE_BODY }), "status");
  violates(() => parseProfileUpdatePayload({ status: true }), "profile");
});

test("profile: 校验与服务端同规则——码点上限与控制字符", () => {
  assert.equal(displayNameIssue("新的显示名称"), null);
  assert.match(displayNameIssue("   "), /不能为空/);
  assert.match(displayNameIssue("a".repeat(DISPLAY_NAME_MAX_CODE_POINTS + 1)), /120 个字符，当前 121/);
  assert.equal(displayNameIssue("a".repeat(DISPLAY_NAME_MAX_CODE_POINTS)), null);
  // 代理对按 1 个码点计，与后端 [...value].length 一致；用 UTF-16 长度会误判。
  assert.equal(displayNameIssue("👍".repeat(DISPLAY_NAME_MAX_CODE_POINTS)), null, "emoji 按码点计不应超限");
  assert.match(displayNameIssue("含\u0007控制符"), /控制字符/);
  assert.match(displayNameIssue("含\n换行"), /控制字符/);
});

test("profile: 原值/草稿分离——仅真正改动才算脏", () => {
  assert.equal(profileDraftChanged("  示例管理员 ", { displayName: "示例管理员" }), false);
  assert.equal(profileDraftChanged("新值", { displayName: "示例管理员" }), true);
  assert.equal(profileDraftChanged("任意", null), false, "尚未读到事实时不构成可提交修改");
});

test("profile: 更新时间变化与同名都不能证明原请求执行", () => {
  const written = readBackProfile(
    { displayName: "新值", updatedAt: "2026-10-15T01:00:00.000Z" },
    { displayName: "新值", updatedAtBefore: "2026-10-14T09:12:33.000Z" },
  );
  assert.equal(written.kind, "indistinguishable");
  assert.match(written.text, /无法据此确认原请求是否执行/);

  // 合同 §1.2：同名提交无副作用、updatedAt 不变，因此读到同名不能证明原请求执行。
  const same = readBackProfile(
    { displayName: "新值", updatedAt: "2026-10-14T09:12:33.000Z" },
    { displayName: "新值", updatedAtBefore: "2026-10-14T09:12:33.000Z" },
  );
  assert.equal(same.kind, "indistinguishable");
  assert.match(same.text, /无法据此确认原请求是否执行/);
  assert.doesNotMatch(same.text, /已保存成功|已生效/);

  assert.equal(readBackProfile({ displayName: "旧值", updatedAt: "x" }, { displayName: "新值", updatedAtBefore: "x" }).kind, "mismatched");
});

// ---------------------------------------------------------------------------
// B. 设备与会话
// ---------------------------------------------------------------------------

const CURRENT = { id: "session_fixture_current", isCurrent: true, createdAt: "2026-10-14T01:00:00.000Z", expiresAt: "2026-10-21T01:00:00.000Z", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", locked: false };
const OTHER = { id: "session_fixture_other", isCurrent: false, createdAt: "2026-10-10T08:00:00.000Z", expiresAt: "2026-10-17T08:00:00.000Z", userAgent: null, locked: false };

test("sessions: 合同样例解析；userAgent 为 null 时保持未提供，不推断设备", () => {
  const facts = parseSessionsPayload({ sessions: [CURRENT, OTHER] });
  assert.equal(facts.currentSessionId, "session_fixture_current");
  assert.equal(facts.rows[1].userAgent, null);
  assert.equal(facts.rows[0].userAgent, CURRENT.userAgent);
  assert.equal(facts.rows[0].locked, false);
});

test("sessions: isCurrent / locked 必填且当前会话唯一，否则合同异常", () => {
  violates(() => parseSessionsPayload({ sessions: [{ id: "s-1", userAgent: null }] }), "isCurrent");
  violates(() => parseSessionsPayload({ sessions: [{ ...CURRENT, locked: undefined }] }), "locked");
  violates(() => parseSessionsPayload({ sessions: [CURRENT, { ...OTHER, isCurrent: true }] }), "当前会话必须唯一");
  violates(() => parseSessionsPayload({}), "sessions");
  violates(() => parseSessionsPayload({ sessions: [{ ...CURRENT, createdAt: "nope" }] }), "createdAt");
  violates(() => parseSessionsPayload({ sessions: [{ ...CURRENT, id: "x".repeat(129) }] }), "id");
});

test("sessions: 未标记当前会话时 currentSessionId 为 null，界面据此禁用注销", () => {
  assert.equal(parseSessionsPayload({ sessions: [{ ...OTHER }] }).currentSessionId, null);
});

test("sessions: 只有非当前会话可注销；其他会话数为 0 时不提供批量动作", () => {
  const only = parseSessionsPayload({ sessions: [CURRENT] });
  assert.deepEqual(only.rows.filter(canRevokeRow), []);
  assert.equal(otherSessionCount(only.rows), 0);
  const withOthers = parseSessionsPayload({ sessions: [CURRENT, OTHER, { ...OTHER, id: "s-3" }] });
  assert.equal(otherSessionCount(withOthers.rows), 2);
  assert.deepEqual(withOthers.rows.filter(canRevokeRow).map((row) => row.id), ["session_fixture_other", "s-3"]);
});

test("sessions: 撤销信封要求 status:true 与合法计数", () => {
  assert.deepEqual(parseRevokePayload({ status: true, revokedSessionCount: 0 }), { revokedSessionCount: 0 }, "N=0 也是成功（本就没有其他会话）");
  assert.deepEqual(parseRevokePayload({ status: true, revokedSessionCount: 3 }).revokedSessionCount, 3);
  violates(() => parseRevokePayload({ status: true }), "revokedSessionCount");
  violates(() => parseRevokePayload({ status: true, revokedSessionCount: -1 }), "计数");
  violates(() => parseRevokePayload({ status: true, revokedSessionCount: 1.5 }), "计数");
  violates(() => parseRevokePayload({ revokedSessionCount: 1 }), "status");
});

test("sessions: 批量撤销结论限定在本次确认的固定集合", () => {
  assert.match(revokeDoneNotice("others", 2), /本次选择的 2 个有效会话/);
  assert.match(revokeDoneNotice("others", 2), /此后新登录的会话不在该结论范围内/);
  assert.match(revokeDoneNotice("single", 1), /当前列表需另行读取确认/);
});

test("sessions: 读回核对把「已不在列表」与「仍在列表」分清楚，不宣称设备下线", () => {
  const rows = parseSessionsPayload({ sessions: [CURRENT] }).rows;
  const gone = reconcileRevokedTarget(rows, "session_fixture_other");
  assert.equal(gone.gone, true);
  assert.match(gone.text, /已撤销、已过期或本就无效/);
  assert.doesNotMatch(gone.text, /设备已被强制下线/);
  const still = reconcileRevokedTarget(parseSessionsPayload({ sessions: [CURRENT, OTHER] }).rows, "session_fixture_other");
  assert.equal(still.gone, false);
  assert.match(still.text, /原请求结果仍无法确认/);
});

// ---------------------------------------------------------------------------
// C. 本人安全活动
// ---------------------------------------------------------------------------

const EVENT_SELF = {
  eventId: "audit_fixture_0001",
  occurredAt: "2026-10-13T02:11:05.000Z",
  action: "admin.password.changed",
  category: "credential",
  outcome: "SUCCESS",
  reason: null,
  actor: { kind: "self", ref: null },
  details: { revokedSessionCount: 2 },
  requestId: "req_0001",
};
const EVENT_OTHER = {
  eventId: "audit_fixture_0002",
  occurredAt: "2026-10-14T09:30:00.000Z",
  action: "admin.frozen",
  category: "account",
  outcome: "SUCCESS",
  reason: "岗位调整",
  actor: { kind: "other", ref: "ZZ00002" },
  details: {},
  requestId: "req_0002",
};
const COVERAGE = {
  scope: "SELF_SECURITY_ACTIVITY",
  recordedActions: ["admin.password.changed", "admin.frozen"],
  notRecorded: ["sign_in", "sign_out"],
};

test("activity: 合同样例解析，含 actor、reason、details 与 coverage", () => {
  const page = parseActivityPayload({ events: [EVENT_OTHER, EVENT_SELF], nextCursor: null, coverage: COVERAGE });
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].actorKind, "other");
  assert.equal(page.events[0].actorRef, "ZZ00002");
  assert.equal(page.events[0].reason, "岗位调整");
  assert.equal(page.events[1].details.revokedSessionCount, 2);
  assert.deepEqual(page.coverage.notRecorded, ["sign_in", "sign_out"]);
  assert.equal(page.nextCursor, null);
});

test("activity: nextCursor 或 coverage 缺失是合同异常，不当作已到底或无缺口", () => {
  violates(() => parseActivityPayload({ events: [], coverage: COVERAGE }), "nextCursor");
  violates(() => parseActivityPayload({ events: [], nextCursor: null }), "coverage");
  violates(() => parseActivityPayload({ events: [], nextCursor: null, coverage: { ...COVERAGE, notRecorded: undefined } }), "notRecorded");
  violates(() => parseActivityPayload({ events: [], nextCursor: 42, coverage: COVERAGE }), "nextCursor");
});

test("activity: outcome 与 actor.kind 只接受合同枚举，未知值不当成功也不丢弃", () => {
  violates(() => parseActivityPayload({ events: [{ ...EVENT_SELF, outcome: "PARTIAL" }], nextCursor: null, coverage: COVERAGE }), "outcome");
  violates(() => parseActivityPayload({ events: [{ ...EVENT_SELF, actor: { kind: "robot" } }], nextCursor: null, coverage: COVERAGE }), "actor.kind");
  assert.equal(activityOutcomeLabel("SUCCESS"), "成功");
  assert.equal(activityOutcomeLabel("FAILURE"), "失败");
  assert.equal(activityOutcomeLabel("WEIRD"), null);
});

test("activity: 动作词表覆盖合同白名单，未收录码返回 null", () => {
  for (const action of ["admin.password.changed", "admin.pin.set", "admin.self.sessions.revoked", "admin.frozen", "admin.recovery.disaster.issued"]) {
    assert.notEqual(activityActionLabel(action), null, `${action} 应有中文名`);
  }
  assert.equal(activityActionLabel("auth.login.password"), null, "合同明确登录没有审计，不得出现在词表里");
});

test("activity: 发起方措辞按 actor 区分，他人执行的不写成本人", () => {
  assert.equal(activityActorPhrase("self", null), "本人发起");
  assert.equal(activityActorPhrase("other", "ZZ00002"), "由 ZZ00002 对本人账号执行");
  assert.equal(activityActorPhrase("other", null), "由其他管理员对本人账号执行");
  assert.equal(activityActorPhrase("system", null), "系统或离线维护执行");
});

test("activity: details 只显示合同允许的键，未知键不透传", () => {
  const parsed = parseActivityPayload({
    events: [{ ...EVENT_SELF, details: { revokedSessionCount: 2, commandId: "idem_secret", raw: { nested: 1 } } }],
    nextCursor: null,
    coverage: COVERAGE,
  });
  assert.deepEqual(Object.keys(parsed.events[0].details), ["revokedSessionCount"]);
  assert.deepEqual(activityDetailPhrases(parsed.events[0].details), ["注销会话数：2"]);
  assert.deepEqual(activityDetailPhrases({ locked: true, scope: "others" }), ["锁态：是", "作用范围：其他全部会话"]);
  assert.deepEqual(activityDetailPhrases({ authScope: "sign-in", failures: 3, lockSeconds: 900, lockedUntil: "2026-10-31T09:54:00.000Z", loginTwoFactorRequired: false }),
    ["场景：登录", "累计失败：3 次", "锁定时长：15 分钟", "解锁时间：2026/10/31 17:54", "登录需二次验证：否"]);
});

test("activity: 游标栈只在服务端确认有下一页时前进，回退不越界", () => {
  const first = emptyCursorPage();
  assert.equal(cursorAt(first), null);
  assert.equal(advanceCursorPage(first).index, 0, "没有 nextCursor 时不得凭空造下一页");
  assert.equal(atEndOfFeed(first), true);

  const second = advanceCursorPage({ cursors: [null], index: 0, nextCursor: "C1" });
  assert.deepEqual(second.cursors, [null, "C1"]);
  assert.equal(cursorAt(second), "C1");
  assert.equal(atEndOfFeed(second), false, "分页未完时不能显示已读完");

  const third = advanceCursorPage({ ...second, nextCursor: "C2" });
  assert.deepEqual(third.cursors, [null, "C1", "C2"]);
  assert.equal(goBackCursorPage(third).index, 1);
  assert.equal(goBackCursorPage(emptyCursorPage()).index, 0);
});

test("activity: 同查询判定不受空白影响；单页条数越界是合同异常", () => {
  assert.equal(activityQueryKey({ action: " admin.frozen " }), activityQueryKey({ action: "admin.frozen" }));
  assert.notEqual(activityQueryKey({ action: "admin.frozen" }), activityQueryKey({ action: "" }));
  assert.equal(hasActiveActivityFilters({ action: "  " }), false);
  assert.equal(hasActiveActivityFilters({ action: "admin.frozen" }), true);
  const tooMany = Array.from({ length: 101 }, (_, index) => ({ ...EVENT_SELF, eventId: `e-${index}` }));
  violates(() => parseActivityPayload({ events: tooMany, nextCursor: null, coverage: COVERAGE }), "单页上限");
});

// ---------------------------------------------------------------------------
// 共用分类与时间
// ---------------------------------------------------------------------------

test("classify: 合同异常、403、404、409、网络与 5xx 各自独立", () => {
  assert.equal(classifyReadFailure(new ContractViolation("x")).kind, "contract");
  assert.equal(classifyReadFailure(new AdminApiError(403, "FORBIDDEN", "r1", "/self/x")).kind, "forbidden");
  assert.equal(classifyReadFailure(new AdminApiError(401, "UNAUTHENTICATED", undefined, "/self/x")).kind, "unauthorized");
  assert.equal(classifyReadFailure(new AdminApiError(423, "FORBIDDEN", undefined, "/self/x")).kind, "locked");
  assert.equal(classifyReadFailure(new AdminApiError(404, "NOT_FOUND", undefined, "/self/x")).kind, "notFound");
  assert.equal(classifyReadFailure(new AdminApiError(409, "CONFLICT", undefined, "/self/x")).kind, "conflict");
  assert.equal(classifyReadFailure(new AdminApiError(0, "NETWORK_ERROR", undefined, "/self/x")).kind, "network");
  assert.equal(classifyReadFailure(new AdminApiError(503, "INTERNAL_ERROR", "r9", "/self/x")).kind, "server");
  assert.equal(classifyReadFailure(new AdminApiError(503, "INTERNAL_ERROR", "r9", "/self/x")).requestId, "r9");
  assert.equal(classifyReadFailure(new AdminApiError(400, "INVALID_ARGUMENT", undefined, "/self/x")).kind, "other");
  assert.equal(classifyReadFailure(new Error("boom")).kind, "other");
  // 当前会话保护与「目标已不在」必须有可区分的文案，不能都写成失败。
  assert.match(classifyReadFailure(new AdminApiError(409, "CONFLICT", undefined, "/self/x")).message, /当前登录会话/);
  assert.match(classifyReadFailure(new AdminApiError(404, "NOT_FOUND", undefined, "/self/x")).message, /不存在或当前不可用/);
});

test("beijingDateTime: 未提供、未知与具体时点三者可区分，且不逐行携带时区", () => {
  assert.equal(beijingDateTime(null), NOT_PROVIDED_TEXT);
  assert.equal(beijingDateTime("nope"), UNKNOWN_TEXT);
  assert.equal(beijingDateTime("2026-10-14T00:00:00.000Z"), "2026/10/14 08:00");
});
