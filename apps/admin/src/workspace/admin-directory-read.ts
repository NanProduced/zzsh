import { adminRequest, type AdminDirectoryEntry, type SessionSnapshot } from "../api";
import { scopedInFlight } from "../lib/shared-inflight";

export type AdminDirectoryRead = { admins?: AdminDirectoryEntry[]; createScopeRequired?: boolean };

/** Authorization generation of the current admin session: identity, session, status and effective permissions. */
export function directoryScopeOf(snapshot: Extract<SessionSnapshot, { authenticated: true }>): string {
  return JSON.stringify([snapshot.adminUserId, snapshot.session.id, snapshot.security.status, snapshot.security.isBoss, [...snapshot.permissions].sort()]);
}

/**
 * GAP-021 / E-R1-01: workbench, role config and account security share one in-flight GET /security/admins only
 * within the same authorization scope. Callers must also drop a response whose scope is no longer current.
 */
export const readAdminDirectoryShared = scopedInFlight(() => adminRequest<AdminDirectoryRead>("/security/admins"));
