import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { gameScopeSignature, readAdminGameScope } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import type { FinanceActor, HistoricalRelationAccess } from "./admin-finance-read";

// Reads and CSV preparation must bind the same authorization and object scope.
export async function authorizeAdminFinance(client: PoolClient, context: { userId: string; sessionId: string }, operation: "lookup" | "document" | "complete"): Promise<FinanceActor & { complete: boolean; relations: HistoricalRelationAccess }> {
  await assertAdminContextInTransaction(client, context);
  const access = await loadEffectiveAdminAccess(client, context.userId);
  if (access?.passwordChangeRequired) throw new SecurityApiError(403, "FORBIDDEN", "Password change required");
  const full = access?.status === "ACTIVE" && access.permissions.has(ADMIN_PERMISSION.financeRead);
  const documents = access?.status === "ACTIVE" && access.permissions.has(ADMIN_PERMISSION.financeDocumentRead);
  if (operation === "complete" ? !full : operation === "document" ? !documents : !full && !documents) throw new SecurityApiError(403, "FORBIDDEN", "Finance permission required");
  const objectScope = access!.isBoss ? ["*"] : access!.permissions.has(ADMIN_PERMISSION.orderRead) || access!.permissions.has(ADMIN_PERMISSION.supplyRentalAccountRead) ? gameScopeSignature(await readAdminGameScope(client,context.userId)) : [];
  return { ...context, complete: full, authorizationKey: createHash("sha256").update(canonicalize([context.userId,context.sessionId,access!.isBoss,[...access!.permissions].sort(),objectScope])).digest("hex"),
    relations: { adminId: context.userId, isBoss: access!.isBoss, orderRead: access!.permissions.has(ADMIN_PERMISSION.orderRead), financeDocumentRead: documents, resourceRead: access!.permissions.has(ADMIN_PERMISSION.supplyRentalAccountRead) } };
}
