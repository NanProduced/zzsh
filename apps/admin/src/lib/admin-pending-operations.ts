/**
 * 管理员页治理写的「原操作待确认」记录。
 *
 * 为什么需要：一次 POST 可能已经落到服务端而响应丢失（网络中断、5xx）。此时客户端没有任何
 * 终态证据，"再点一次"就是第二次治理写。关闭弹窗、切走页面、卸载重挂载、读到旧值、列表里
 * 没看到账号，都不是原请求已终止的回执，所以这条记录必须比弹窗和页面实例活得更久，
 * 并且按（身份, 会话, 目标, 操作）分别保留，不能互相覆盖。
 *
 * 与 user-directory 的信用处置 intent 记录同一模式，但这里**不保存请求正文**：
 * 冻结/解冻/强制登出的正文含本人密码与 TOTP，临时凭据也不能落存储。
 */

const PREFIX = "zzsh.admin.pending-op.";

export type PendingKind = "UNKNOWN" | "ACK_STALE";

export type PendingOperation = {
  subject: string;
  actorId: string;
  sessionId: string;
  target: string;
  operation: string;
  kind: PendingKind;
  /** 非秘密的路由与请求编号，只用于人工核对时对上号。 */
  path: string;
  requestId?: string;
  at: string;
};

export function pendingSubject(actorId: string, sessionId: string, target: string, operation: string): string {
  return `${actorId}|${sessionId}|${target}|${operation}`;
}

const memory = new Map<string, PendingOperation>();

function store(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

const keyOf = (subject: string) => `${PREFIX}${encodeURIComponent(subject)}`;

/** 只接受形状与绑定都正确的记录；被篡改或过期的键一律当成没有记录，而不是当成可写。 */
function parse(subject: string, raw: string | null): PendingOperation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingOperation>;
    if (
      value?.subject !== subject ||
      typeof value.actorId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.target !== "string" ||
      typeof value.operation !== "string" ||
      typeof value.path !== "string" ||
      typeof value.at !== "string" ||
      (value.kind !== "UNKNOWN" && value.kind !== "ACK_STALE")
    ) {
      return null;
    }
    return value as PendingOperation;
  } catch {
    return null;
  }
}

export function readPending(subject: string): PendingOperation | null {
  const cached = memory.get(subject);
  if (cached) return cached;
  const found = parse(subject, store()?.getItem(keyOf(subject)) ?? null);
  if (found) memory.set(subject, found);
  return found;
}

/**
 * 写入记录成功才允许发出这一笔写。存储不可用（隐私模式、配额）时返回 false，
 * 调用方必须放弃提交 —— 记不住就不能保证不会重复写。
 */
export function savePending(binding: Omit<PendingOperation, "subject" | "at">): boolean {
  const subject = pendingSubject(binding.actorId, binding.sessionId, binding.target, binding.operation);
  const next: PendingOperation = { ...binding, subject, at: new Date().toISOString() };
  const target = store();
  if (!target) return false;
  try {
    target.setItem(keyOf(subject), JSON.stringify(next));
    memory.set(subject, next);
    return true;
  } catch {
    // 保留本页已收到的 ACK；持久化失败仍返回 false，旧存储记录也不会被删除。
    if (binding.kind === "ACK_STALE" && memory.has(subject)) memory.set(subject, next);
    return false;
  }
}

/** 只有拿到终态证据时才调用：明确拒绝，或 ACK 之后一次成功的同目标读取。 */
export function dropPending(subject: string): void {
  memory.delete(subject);
  try {
    store()?.removeItem(keyOf(subject));
  } catch {
    // 已经不在内存里，存储清不掉也不会因此放行重复写。
  }
}
