import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminContext } from "../src/auth/auth-security";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinTransportError, type YunxinSupportScopeApi, type YunxinSupportTeamCreateInput, type YunxinSupportTeamExistenceLookup, type YunxinSupportTeamLookup, type YunxinSupportTeamState } from "../src/im/yunxin-provider";
export class FakeSupportScopeProvider implements YunxinSupportScopeApi {
  private nextTeamId = 900001;
  readonly created: YunxinSupportTeamCreateInput[] = [];
  readonly dismissed: string[] = [];
  readonly members = new Map<string, Set<string>>();
  readonly teams = new Map<string, YunxinSupportTeamCreateInput>();
  readonly pendingCreates = new Map<string, YunxinSupportTeamCreateInput>();
  readonly pendingLateAdds: Array<{ teamId: string; memberAccountId: string }> = [];
  findCalls = 0;
  existenceReads = 0;
  existenceFailure: unknown;
  failCreateAfterPersist = false;
  failCreateBeforePersist = false;
  failAddAfterPersist = false;
  failAddBeforePersist = false;
  failRemoveAfterPersist = false;
  failDismissAfterPersist = false;
  lastPendingCreateTeamId: string | undefined;
  beforeGet?: (teamId: string) => Promise<void>;
  beforeCreate?: (teamId: string) => Promise<void>;
  afterAdd?: (teamId: string, memberAccountId: string) => Promise<void>;

  async createSupportTeam(input: YunxinSupportTeamCreateInput): Promise<{ teamId: string }> {
    const teamId = String(this.nextTeamId++);
    this.created.push(input);
    const beforeCreate = this.beforeCreate;
    this.beforeCreate = undefined;
    await beforeCreate?.(teamId);
    if (this.failCreateBeforePersist) {
      this.failCreateBeforePersist = false;
      this.pendingCreates.set(teamId, input);
      this.lastPendingCreateTeamId = teamId;
      throw new YunxinTransportError("create-support-team");
    }
    this.teams.set(teamId, input);
    this.members.set(teamId, new Set([input.ownerAccountId, ...input.memberAccountIds]));
    if (this.failCreateAfterPersist) {
      this.failCreateAfterPersist = false;
      throw new YunxinTransportError("create-support-team");
    }
    return { teamId };
  }

  async addSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(operatorAccountId) || team?.ownerAccountId !== operatorAccountId) throw new Error("fake support team owner is required");
    if (this.failAddBeforePersist) {
      this.failAddBeforePersist = false;
      this.pendingLateAdds.push({ teamId, memberAccountId });
      throw new YunxinTransportError("add-support-team-member");
    }
    members.add(memberAccountId);
    if (this.failAddAfterPersist) {
      this.failAddAfterPersist = false;
      throw new YunxinTransportError("add-support-team-member");
    }
    const afterAdd = this.afterAdd;
    this.afterAdd = undefined;
    await afterAdd?.(teamId, memberAccountId);
  }

  async removeSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(operatorAccountId) || team?.ownerAccountId !== operatorAccountId) throw new Error("fake support team owner is required");
    members.delete(memberAccountId);
    if (this.failRemoveAfterPersist) {
      this.failRemoveAfterPersist = false;
      throw new YunxinTransportError("remove-support-team-member");
    }
  }

  async dismissSupportTeam(teamId: string, ownerAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(ownerAccountId) || team?.ownerAccountId !== ownerAccountId) throw new Error("fake support team owner is required");
    this.members.delete(teamId);
    this.dismissed.push(teamId);
    if (this.failDismissAfterPersist) {
      this.failDismissAfterPersist = false;
      throw new YunxinTransportError("dismiss-support-team");
    }
  }

  async getSupportTeam(teamId: string): Promise<YunxinSupportTeamState | null> {
    const beforeGet = this.beforeGet;
    this.beforeGet = undefined;
    await beforeGet?.(teamId);
    const input = this.teams.get(teamId);
    const members = this.members.get(teamId);
    if (!input || !members) return null;
    return {
      teamId,
      ownerAccountId: input.ownerAccountId,
      memberAccountIds: [...members],
      serverExtension: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: input.appId, consultationId: input.consultationId }),
    };
  }

  async readSupportTeamExistence(input: { appId: string; consultationId: string; ownerAccountId: string; teamId: string }): Promise<YunxinSupportTeamExistenceLookup> {
    this.existenceReads += 1;
    if (this.existenceFailure) throw this.existenceFailure;
    const team = await this.getSupportTeam(input.teamId);
    if (!team) return { status: "ABSENT" };
    if (
      team.ownerAccountId !== input.ownerAccountId
      || team.serverExtension !== JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: input.appId, consultationId: input.consultationId })
    ) {
      return { status: "AMBIGUOUS" };
    }
    return {
      status: "FOUND",
      team: { teamId: team.teamId, teamType: 1, ownerAccountId: team.ownerAccountId, serverExtension: team.serverExtension! },
    };
  }

  async findSupportTeam(input: { appId: string; consultationId: string; ownerAccountId: string }): Promise<YunxinSupportTeamLookup> {
    this.findCalls += 1;
    const matches = [...this.teams.entries()].filter(([teamId, team]) => team.appId === input.appId && team.consultationId === input.consultationId && team.ownerAccountId === input.ownerAccountId && this.members.has(teamId));
    if (matches.length > 1) return { status: "AMBIGUOUS" };
    if (!matches[0]) return { status: "ABSENT" };
    const team = await this.getSupportTeam(matches[0][0]);
    return team ? { status: "FOUND", team } : { status: "ABSENT" };
  }

  applyLateCreate(teamId: string): void {
    const input = this.pendingCreates.get(teamId);
    if (!input) throw new Error("fake late create is not pending");
    this.pendingCreates.delete(teamId);
    this.teams.set(teamId, input);
    this.members.set(teamId, new Set([input.ownerAccountId, ...input.memberAccountIds]));
  }

  applyLateAdd(teamId: string, memberAccountId: string): void {
    const pending = this.pendingLateAdds.findIndex((item) => item.teamId === teamId && item.memberAccountId === memberAccountId);
    if (pending < 0) throw new Error("fake late member add is not pending");
    this.pendingLateAdds.splice(pending, 1);
    this.members.get(teamId)?.add(memberAccountId);
  }
}

export async function seedIdentity(runtime: Pool, key: ImIdentityKey, runId: string): Promise<void> {
  await runtime.query(
    `INSERT INTO "zzsh_iam"."im_identity_mapping"
      ("id", "provider", "app_id", "realm", "identity_kind", "platform_subject_id", "account_id", "identity_marker", "status")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')`,
    [
      `im_cpg_mapping_${runId}_${randomUUID().replaceAll("-", "")}`,
      key.provider,
      key.appId,
      key.realm,
      key.kind,
      key.platformSubjectId,
      deriveYunxinAccountId(key),
      buildYunxinIdentityMarker(key),
    ],
  );
}

export async function seedUser(runtime: Pool, userId: string, sessionId: string, runId: string): Promise<void> {
  const now = new Date();
  await runtime.query(
    `INSERT INTO "zzsh_auth_user"."user"
      ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
     VALUES ($1, $2, $3, $4, $4, $5, $5, true, false)`,
    [userId, `PG consultation user ${runId}`, `${userId}@user.zzsh.invalid`, now, userId],
  );
  await runtime.query(
    `INSERT INTO "zzsh_auth_user"."session"
      ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionId, new Date(now.getTime() + 3_600_000), `im_cpg_token_${runId}_${sessionId}`, now, userId],
  );
}

export async function seedAdmin(runtime: Pool, adminId: string, sessionId: string, runId: string, isBoss = true): Promise<void> {
  const now = new Date();
  await runtime.query(
    `INSERT INTO "zzsh_auth_admin"."user"
      ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
     VALUES ($1, $2, $3, $4, $4, $5, $5, true, false)`,
    [adminId, `PG consultation admin ${runId}`, `${adminId}@admin.zzsh.invalid`, now, adminId],
  );
  await runtime.query(
    `INSERT INTO "zzsh_iam"."admin_security"
      ("admin_user_id", "status", "is_boss", "password_change_required")
     VALUES ($1, 'PENDING_ENROLLMENT', $2, false)`,
    [adminId, isBoss],
  );
  await runtime.query(
    `UPDATE "zzsh_iam"."admin_security"
        SET "status" = 'ACTIVE', "first_activated_at" = $2, "updated_at" = clock_timestamp()
      WHERE "admin_user_id" = $1`,
    [adminId, now],
  );
  await runtime.query(
    `INSERT INTO "zzsh_auth_admin"."session"
      ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionId, new Date(now.getTime() + 3_600_000), `im_cpg_admin_token_${runId}_${sessionId}`, now, adminId],
  );
}

export function userContext(userId: string, sessionId: string) {
  return { userId, sessionId };
}

export function adminContext(adminId: string, sessionId: string): AdminContext {
  return {
    userId: adminId,
    sessionId,
    credentials: { headers: new Headers(), conflict: false, malformed: false },
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
    sessionLocked: false,
  };
}
