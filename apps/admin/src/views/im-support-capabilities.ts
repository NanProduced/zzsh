export type ImSupportType = "SERVICE" | "COMPLAINT";

export function createReadClientKey(input: { adminUserId: string; sessionId: string; locked: boolean; canRead: boolean }): string {
  return `${input.adminUserId}:${input.sessionId}:${input.locked ? "locked" : "open"}:${input.canRead ? "read" : "no-read"}`;
}

export function createSendCapabilityKey(input: { canAccept: boolean; canComplaint: boolean }): string {
  return `service=${input.canAccept ? "allowed" : "blocked"};complaint=${input.canAccept && input.canComplaint ? "allowed" : "blocked"}`;
}

export function canOperateSupportType(_type: ImSupportType, canAccept: boolean, _canComplaint: boolean): boolean {
  // Complaints are ordinary chats now; reception only requires the service grant.
  return canAccept;
}
