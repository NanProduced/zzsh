import type { ReadbackTarget } from "./contract";

/**
 * 审批写的「结果未知 / 已受理未确认」责任记录。
 *
 * 分域沿用 lib/admin-pending-operations.ts 的 身份|会话|目标|操作；审批正文不含密码、TOTP 或
 * 回调，因此这里额外保存可序列化的原幂等 key、原体、操作与读回目标，使冷启动后仍能找回同一笔
 * 未核清责任。
 *
 * fail-closed 三条：
 * 1. 首次发送前必须可靠落盘并核读成功，否则不发 POST——记不住就保证不了不会重复写。
 * 2. 读到损坏或不可读的存储时，既不覆盖也不放行新提交，只给核对入口。
 * 3. 已受理之后的存储故障只保留原责任并标注，不改成「未提交」，也不删除。
 * 解除只发生在与服务端终态证据一致且 key 匹配时。
 */

const PREFIX = "zzsh.admin.approval.pending-write.";

/** 恢复合同白名单：路径 ↔ 操作码，与 approval-audit.ts 的 APPROVAL_WRITE_OPERATIONS 对齐。 */
export const APPROVAL_WRITE_PATHS: Record<string, string> = {
  "/security/approvals/templates/update": "approval.template.configure",
  "/security/approvals/requests": "approval.request.create",
  "/security/approvals/requests/decision": "approval.request.decide",
  "/security/approvals/requests/add-candidate": "approval.request.add_candidate",
  "/security/approvals/requests/execute": "approval.request.execute",
};

export type PendingApprovalWrite = {
  subject: string;
  actorId: string;
  sessionId: string;
  /** 申请号；模板类写为 operationCode|triggerCondition；创建类为空串。 */
  target: string;
  operation: string;
  path: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  readback: ReadbackTarget;
  successMessage: string;
  kind: "unknown" | "readback";
  /** 是否已可靠落盘；false 只出现在已受理之后的降级，绝不放行新提交。 */
  persisted: boolean;
  at: string;
};

export type PendingInspection =
  | { state: "absent" }
  | { state: "valid"; record: PendingApprovalWrite }
  | { state: "unreadable"; reason: "storage-error" | "corrupt" };

export type SaveOutcome =
  | { ok: true; record: PendingApprovalWrite }
  | { ok: false; reason: "storage-unavailable" | "storage-error" | "corrupt-record" | "existing-unresolved"; existing?: PendingApprovalWrite };

const KEY_PATTERN = /^idem_[0-9a-f-]{16,64}$/;

export function pendingWriteSubject(actorId: string, sessionId: string, target: string, operation: string): string {
  return `${actorId}|${sessionId}|${target}|${operation}`;
}

const memory = new Map<string, PendingApprovalWrite>();

function store(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

const keyOf = (subject: string) => `${PREFIX}${encodeURIComponent(subject)}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readbackLooksValid(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.kind === "templates") return true;
  if (value.kind === "lists") return Array.isArray(value.keys);
  if (value.kind === "detail-and-lists") return typeof value.requestId === "string" && Array.isArray(value.keys);
  return false;
}

/** 记录必须自洽：subject 与身份分域一致、路径与操作码互相对应、正文与读回目标形状可用。 */
function validate(subject: string, value: Partial<PendingApprovalWrite>): PendingApprovalWrite | null {
  if (value?.subject !== subject) return null;
  if (typeof value.actorId !== "string" || !value.actorId) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (typeof value.target !== "string" || typeof value.operation !== "string" || typeof value.path !== "string") return null;
  if (pendingWriteSubject(value.actorId, value.sessionId, value.target, value.operation) !== subject) return null;
  if (APPROVAL_WRITE_PATHS[value.path] !== value.operation) return null;
  if (typeof value.idempotencyKey !== "string" || !KEY_PATTERN.test(value.idempotencyKey)) return null;
  if (!isPlainObject(value.body)) return null;
  if (!readbackLooksValid(value.readback)) return null;
  if (typeof value.successMessage !== "string" || typeof value.at !== "string") return null;
  if (value.kind !== "unknown" && value.kind !== "readback") return null;
  if (typeof value.body.requestId === "string" && value.target && value.target !== value.body.requestId) return null;
  return value as PendingApprovalWrite;
}

function parse(subject: string, raw: string): PendingApprovalWrite | null {
  try {
    return validate(subject, JSON.parse(raw) as Partial<PendingApprovalWrite>);
  } catch {
    return null;
  }
}

/** 明确区分「没有记录 / 有效记录 / 损坏或不可读」，后两类阻止覆盖与新提交。 */
export function inspectPending(subject: string): PendingInspection {
  const cached = memory.get(subject);
  if (cached) return { state: "valid", record: cached };
  const storage = store();
  if (!storage) return { state: "unreadable", reason: "storage-error" };
  let raw: string | null = null;
  try {
    raw = storage.getItem(keyOf(subject));
  } catch {
    return { state: "unreadable", reason: "storage-error" };
  }
  if (raw === null) return { state: "absent" };
  const record = parse(subject, raw);
  if (!record) return { state: "unreadable", reason: "corrupt" };
  memory.set(subject, record);
  return { state: "valid", record };
}

function serializable(record: PendingApprovalWrite): string {
  const { persisted: _persisted, ...rest } = record;
  return JSON.stringify(rest);
}

/**
 * 首次提交前调用：只有落盘并核读成功才返回 ok，调用方据此决定是否发出 POST。
 * 已存在不同 key 的未核清记录时拒绝覆盖，并把原记录带回给调用方恢复面板。
 */
export function savePendingWrite(binding: Omit<PendingApprovalWrite, "subject" | "at" | "persisted">): SaveOutcome {
  const subject = pendingWriteSubject(binding.actorId, binding.sessionId, binding.target, binding.operation);
  const prior = inspectPending(subject);
  if (prior.state === "unreadable") return { ok: false, reason: prior.reason === "corrupt" ? "corrupt-record" : "storage-error" };
  if (prior.state === "valid" && prior.record.idempotencyKey !== binding.idempotencyKey) {
    return { ok: false, reason: "existing-unresolved", existing: prior.record };
  }
  const draft: PendingApprovalWrite = { ...binding, subject, persisted: false, at: new Date().toISOString() };
  const storage = store();
  if (!storage) return { ok: false, reason: "storage-unavailable" };
  try {
    storage.setItem(keyOf(subject), serializable(draft));
  } catch {
    // 落盘失败时内存也不留下「以为记过了」的记录，调用方必须放弃提交。
    return { ok: false, reason: "storage-unavailable" };
  }
  const readBack = parse(subject, storage.getItem(keyOf(subject)) ?? "");
  if (!readBack || readBack.idempotencyKey !== draft.idempotencyKey) return { ok: false, reason: "storage-error" };
  const record: PendingApprovalWrite = { ...draft, persisted: true };
  memory.set(subject, record);
  return { ok: true, record };
}

/**
 * 已受理之后的降级：只更新 kind / 重落盘，存储故障时保留内存记录并标注 persisted=false，
 * 绝不把「已受理」改写成「未提交」，也不删除原责任。
 */
export function updatePendingWriteKind(subject: string, key: string, kind: PendingApprovalWrite["kind"]): PendingApprovalWrite | null {
  const current = readPendingWrite(subject);
  if (!current || current.idempotencyKey !== key) return null;
  const next: PendingApprovalWrite = { ...current, kind };
  const storage = store();
  let persisted = false;
  try {
    if (storage) {
      storage.setItem(keyOf(subject), serializable(next));
      persisted = parse(subject, storage.getItem(keyOf(subject)) ?? "")?.idempotencyKey === key;
    }
  } catch {
    persisted = false;
  }
  next.persisted = persisted;
  memory.set(subject, next);
  return next;
}

export function readPendingWrite(subject: string): PendingApprovalWrite | null {
  const inspection = inspectPending(subject);
  return inspection.state === "valid" ? inspection.record : null;
}

/** 只有终态证据 + key 匹配才解除；损坏内容原样保留供人工核对。 */
export function dropPendingWrite(subject: string, idempotencyKey: string): boolean {
  const inspection = inspectPending(subject);
  if (inspection.state !== "valid") return false;
  if (inspection.record.idempotencyKey !== idempotencyKey) return false;
  memory.delete(subject);
  try {
    store()?.removeItem(keyOf(subject));
  } catch {
    // 内存已清；存储清不掉也不会放行重复写——下次提交仍会读到有效记录而被拦。
  }
  return true;
}

/** 当前身份与会话下全部未核清记录；target 给出时只取该目标。 */
export function findPendingWrites(actorId: string, sessionId: string, target?: string): PendingApprovalWrite[] {
  const storage = store();
  const fromStorage: PendingApprovalWrite[] = [];
  if (storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !key.startsWith(PREFIX)) continue;
        const subject = decodeURIComponent(key.slice(PREFIX.length));
        if (memory.has(subject)) continue;
        const record = parse(subject, storage.getItem(key) ?? "");
        if (record) fromStorage.push(record);
      }
    } catch {
      // 存储不可枚举时只回内存视图；写入口的 inspectPending 仍会逐 subject 判为不可读并拦住。
    }
  }
  return [...memory.values(), ...fromStorage]
    .filter((record) => record.actorId === actorId && record.sessionId === sessionId && (!target || record.target === target))
    .sort((left, right) => left.at.localeCompare(right.at));
}
