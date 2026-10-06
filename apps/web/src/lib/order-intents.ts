/**
 * Frozen write intents for trade actions.
 *
 * A write that may have reached the server is never re-created with a new key or a new
 * quote: the original subject/action/key/body (and the confirmation token when one was
 * consumed) is persisted per user until a definitive receipt or an authoritative read
 * proves the outcome. Entries are session-scoped and user-bound; another identity can
 * never see or reuse them. Age only disables automatic replay; it never deletes the
 * unresolved responsibility.
 */
export type IntentKind =
  | "order.create.v2"
  | "order.payment"
  | "order.cancel"
  | "opening.confirm"
  | "settlement.submit"
  | "settlement.decision";

export type PendingIntent = {
  version: 1;
  userId: string;
  kind: IntentKind;
  resourceId: string;
  key: string;
  body: Record<string, unknown>;
  token?: string;
  context?: Record<string, unknown>;
  receipt?: unknown;
  createdAt: string;
  updatedAt: string;
};

const PREFIX = "zzsh.order-intent.v1:";
const AUTO_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function storageKey(userId: string, kind: IntentKind, resourceId: string): string {
  return `${PREFIX}${userId}:${kind}:${resourceId}`;
}

function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Loads the frozen intent for this exact subject/action/object; never deletes it. */
export function loadIntent(userId: string, kind: IntentKind, resourceId: string): PendingIntent | null {
  const storage = store();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(userId, kind, resourceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingIntent;
    if (parsed?.version !== 1 || parsed.userId !== userId || parsed.kind !== kind || parsed.resourceId !== resourceId) return null;
    if (typeof parsed.key !== "string" || !parsed.key) return null;
    if (!Number.isFinite(Date.parse(parsed.updatedAt))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Age only stops automatic replay; the intent must still be resolved with authority first. */
export function isIntentStale(intent: PendingIntent): boolean {
  const updated = Date.parse(intent.updatedAt);
  return !Number.isFinite(updated) || Date.now() - updated > AUTO_REPLAY_WINDOW_MS;
}

export type SaveIntentResult = { intent: PendingIntent; persisted: boolean };

export function saveIntent(input: {
  userId: string;
  kind: IntentKind;
  resourceId: string;
  key: string;
  body: Record<string, unknown>;
  token?: string;
  context?: Record<string, unknown>;
}): SaveIntentResult {
  const now = new Date().toISOString();
  const existing = loadIntent(input.userId, input.kind, input.resourceId);
  const intent: PendingIntent = {
    version: 1,
    userId: input.userId,
    kind: input.kind,
    resourceId: input.resourceId,
    key: input.key,
    body: input.body,
    ...(input.token ? { token: input.token } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(existing?.receipt ? { receipt: existing.receipt } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    const target = store();
    if (!target) return { intent, persisted: false };
    target.setItem(storageKey(input.userId, input.kind, input.resourceId), JSON.stringify(intent));
    return { intent, persisted: true };
  } catch {
    return { intent, persisted: false };
  }
}

export function recordIntentReceipt(userId: string, kind: IntentKind, resourceId: string, receipt: unknown): void {
  const existing = loadIntent(userId, kind, resourceId);
  if (!existing) return;
  try {
    store()?.setItem(
      storageKey(userId, kind, resourceId),
      JSON.stringify({ ...existing, receipt, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Best effort only; the write outcome is already authoritative.
  }
}

export function clearIntent(userId: string, kind: IntentKind, resourceId: string): void {
  try {
    store()?.removeItem(storageKey(userId, kind, resourceId));
  } catch {
    // Best effort only.
  }
}
