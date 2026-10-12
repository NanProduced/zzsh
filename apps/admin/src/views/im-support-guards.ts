export type ImMessageOperation = "read" | "send";
export type ImRequestKey = { generation: number; operator: string; consultationId: string; conversationId: string | null; sendCapability?: string };

export function messageAccessPath(conversationId: string, operation: ImMessageOperation): string {
  return `/im/message-access?conversationId=${encodeURIComponent(conversationId)}&operation=${operation}`;
}

/** 同源 HTTP 仅允许当前 origin；显式非法 rawUrl 不得回退到 imageId 绕过校验。 */
export function supportedImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/^\/api\/(?:im|bff\/admin\/im)\/images\/[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  try {
    const parsed = new URL(value, typeof window === "undefined" ? "https://invalid.local" : window.location.origin);
    const protocol = parsed.protocol.toLowerCase();
    if (["blob:", "data:", "file:", "javascript:"].includes(protocol)) return null;
    if (protocol === "https:") return parsed.href;
    if (protocol === "http:" && typeof window !== "undefined" && parsed.origin === window.location.origin) return parsed.href;
    return null;
  } catch {
    return null;
  }
}

export function isCurrentImRequest(expected: ImRequestKey, current: ImRequestKey): boolean {
  return expected.generation === current.generation
    && expected.operator === current.operator
    && expected.consultationId === current.consultationId
    && expected.conversationId === current.conversationId
    && (expected.sendCapability === undefined || expected.sendCapability === current.sendCapability);
}

export function shouldBlockCurrentForbidden(input: {
  status: number;
  expected: ImRequestKey;
  current: ImRequestKey;
  permissionConfirmedAbsent: boolean;
}): boolean {
  return input.status === 403
    && input.permissionConfirmedAbsent
    && isCurrentImRequest(input.expected, input.current);
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

export async function confirmCurrentForbidden(input: {
  originalStatus: number | undefined;
  expected: ImRequestKey;
  current: ImRequestKey | null;
  getCurrent: () => ImRequestKey | null;
  recheck: (path: string) => Promise<unknown>;
}): Promise<boolean> {
  if (input.originalStatus !== 403 || !input.current || !input.expected.conversationId || !isCurrentImRequest(input.expected, input.current)) return false;
  try {
    await input.recheck(messageAccessPath(input.expected.conversationId, "send"));
    return false;
  } catch (error) {
    const current = input.getCurrent();
    return current ? shouldBlockCurrentForbidden({ status: statusOf(error) ?? 0, expected: input.expected, current, permissionConfirmedAbsent: statusOf(error) === 403 }) : false;
  }
}
