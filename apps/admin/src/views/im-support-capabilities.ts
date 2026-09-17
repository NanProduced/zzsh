export type ImSupportType = "SERVICE" | "COMPLAINT";

export function createReadClientKey(input: { adminUserId: string; sessionId: string; locked: boolean; canRead: boolean }): string {
  return `${input.adminUserId}:${input.sessionId}:${input.locked ? "locked" : "open"}:${input.canRead ? "read" : "no-read"}`;
}

export function createSendCapabilityKey(input: { canAccept: boolean; canComplaint: boolean }): string {
  return `service=${input.canAccept ? "allowed" : "blocked"};complaint=${input.canAccept && input.canComplaint ? "allowed" : "blocked"}`;
}

export function canOperateSupportType(type: ImSupportType, canAccept: boolean, canComplaint: boolean): boolean {
  return canAccept && (type === "SERVICE" || canComplaint);
}
