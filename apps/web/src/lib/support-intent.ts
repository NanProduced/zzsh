import { safeReturnTo } from "./safe-return.ts";

export const SUPPORT_INTENT_STORAGE_KEY = "zzsh-support-intent-v1";
const MAX_AGE_MS = 10 * 60 * 1_000;

export type SupportType = "SERVICE" | "COMPLAINT";

export type SupportIntent = {
  type: SupportType;
  source: string;
  createdAt: number;
};

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): IntentStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function validType(value: unknown): value is SupportType {
  return value === "SERVICE" || value === "COMPLAINT";
}

export function parseSupportIntent(value: unknown, now = Date.now()): SupportIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!validType(candidate.type) || typeof candidate.source !== "string" || !safeReturnTo(candidate.source)) return null;
  if (typeof candidate.createdAt !== "number" || !Number.isSafeInteger(candidate.createdAt)) return null;
  if (candidate.createdAt > now + 30_000 || now - candidate.createdAt > MAX_AGE_MS) return null;
  return { type: candidate.type, source: candidate.source, createdAt: candidate.createdAt };
}

export function saveSupportIntent(intent: Omit<SupportIntent, "createdAt">, storage = browserStorage(), now = Date.now()): void {
  const source = safeReturnTo(intent.source);
  if (!storage || !source || !validType(intent.type)) return;
  try {
    storage.setItem(SUPPORT_INTENT_STORAGE_KEY, JSON.stringify({ type: intent.type, source, createdAt: now }));
  } catch {
    // A blocked sessionStorage must not prevent the auth flow.
  }
}

export function readSupportIntent(storage = browserStorage(), now = Date.now()): SupportIntent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SUPPORT_INTENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseSupportIntent(JSON.parse(raw), now);
    if (!parsed) storage.removeItem(SUPPORT_INTENT_STORAGE_KEY);
    return parsed;
  } catch {
    try { storage.removeItem(SUPPORT_INTENT_STORAGE_KEY); } catch { /* ignore unavailable storage */ }
    return null;
  }
}

export function clearSupportIntent(intent: SupportIntent, storage = browserStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    const current = readSupportIntent(storage, now);
    if (current && current.type === intent.type && current.source === intent.source && current.createdAt === intent.createdAt) {
      storage.removeItem(SUPPORT_INTENT_STORAGE_KEY);
    }
  } catch {
    // A blocked sessionStorage must not turn a completed consultation into an auth error.
  }
}

export function consumeSupportIntent(storage = browserStorage(), now = Date.now()): SupportIntent | null {
  const intent = readSupportIntent(storage, now);
  if (storage) {
    try { storage.removeItem(SUPPORT_INTENT_STORAGE_KEY); } catch { /* ignore unavailable storage */ }
  }
  return intent;
}
