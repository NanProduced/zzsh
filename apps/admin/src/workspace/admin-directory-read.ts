import { adminRequest, type AdminDirectoryEntry } from "../api";
import { sharedInFlight } from "../lib/shared-inflight";

export type AdminDirectoryRead = { admins?: AdminDirectoryEntry[]; createScopeRequired?: boolean };

/**
 * GAP-021: workbench, role config and account security each read GET /security/admins. Concurrent callers
 * (e.g. one global refresh) now share one in-flight request. Nothing is cached after it settles, so a read
 * started after a write always reaches the server and authorization stays per request.
 */
export const readAdminDirectoryShared = sharedInFlight(() => adminRequest<AdminDirectoryRead>("/security/admins"));
