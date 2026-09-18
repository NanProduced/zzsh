import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import { createAdministrator } from "../src/auth/admin-directory";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  type ImIdentityIntent,
  type ImIdentityKey,
  type ImIdentityMapping,
  type ImIdentityProvisioner,
} from "../src/im/identity-lifecycle";

type Harness = {
  pool: Pool;
  state: { phase: "idle" | "transaction" | "committed" | "rolled-back"; commits: number; rollbacks: number; adminInserts: number; intentWrites: number };
};

function harness(): Harness {
  const state: Harness["state"] = { phase: "idle", commits: 0, rollbacks: 0, adminInserts: 0, intentWrites: 0 };
  const client = {
    async query(text: string): Promise<{ rows: unknown[] }> {
      if (text === "BEGIN") { state.phase = "transaction"; return { rows: [] }; }
      if (text === "COMMIT") { state.phase = "committed"; state.commits += 1; return { rows: [] }; }
      if (text === "ROLLBACK") { state.phase = "rolled-back"; state.rollbacks += 1; return { rows: [] }; }
      if (text.includes('INSERT INTO "zzsh_auth_admin"."user"')) state.adminInserts += 1;
      if (text.includes('FROM "zzsh_iam"."admin_security"')) {
        return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
      }
      if (text.includes("SELECT nextval")) return { rows: [{ value: "9" }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, state };
}

function identityKey(subjectId = "admin_new"): ImIdentityKey {
  return { provider: "yunxin", appId: "provider-test", realm: "admin", kind: "ADMIN", platformSubjectId: subjectId };
}

function mapping(key: ImIdentityKey): ImIdentityMapping {
  return {
    id: "im_new",
    key,
    accountId: deriveYunxinAccountId(key),
    identityMarker: buildYunxinIdentityMarker(key),
    status: "PENDING",
    version: 1,
    attemptCount: 0,
    attemptLeaseUntil: null,
    nextRetryAt: null,
    lastFailure: null,
  };
}

function options(
  state: Harness["state"],
  intentFailure?: Error,
) {
  return {
    hashPassword: async () => "password-hash",
    imAppId: "provider-test",
    imIdentityRepository: {
      ensureIntentInTransaction: async (executor: { query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }, intent: ImIdentityIntent) => {
        void executor;
        state.intentWrites += 1;
        if (intentFailure) throw intentFailure;
        return mapping(intent.key);
      },
    },
    imProvisioner: {
      ensure: async () => {
        assert.equal(state.phase, "committed");
        throw new Error("IM CAS failed after administrator commit");
      },
    } as unknown as ImIdentityProvisioner,
  };
}

test("administrator creation keeps its result when post-commit IM provisioning fails", async () => {
  const fixture = harness();
  const keyForCreated = identityKey();
  const result = await createAdministrator(
    { userId: "boss", sessionId: "session-1" },
    { name: "客服一号" },
    "req-admin-im",
    {
      ...options(fixture.state),
      imIdentityRepository: {
        ensureIntentInTransaction: async (_executor, intent) => {
          fixture.state.intentWrites += 1;
          return mapping({ ...keyForCreated, platformSubjectId: intent.key.platformSubjectId });
        },
      },
      pool: fixture.pool,
    },
  );

  assert.equal(fixture.state.commits, 1);
  assert.equal(fixture.state.rollbacks, 0);
  assert.equal(fixture.state.intentWrites, 1);
  assert.equal(typeof result.temporaryPassword, "string");
  assert.equal((result.imIdentity as { status: string }).status, "PENDING");
});

test("administrator and IM intent roll back together when intent persistence fails", async () => {
  const fixture = harness();
  await assert.rejects(
    createAdministrator(
      { userId: "boss", sessionId: "session-1" },
      { name: "客服二号" },
      "req-admin-im-rollback",
      {
        ...options(fixture.state, new Error("intent write failed")),
        pool: fixture.pool,
      },
    ),
    /intent write failed/,
  );
  assert.equal(fixture.state.commits, 0);
  assert.equal(fixture.state.rollbacks, 1);
  assert.equal(fixture.state.adminInserts, 1);
  assert.equal(fixture.state.intentWrites, 1);
});
