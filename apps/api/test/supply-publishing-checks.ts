import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TestContext } from "node:test";
import type { SupplyGate } from "../src/supply/publishing";
import { withTransaction } from "../src/auth/security-core";
import { recordLegacyObservation } from "../src/supply/legacy-observation";
type Jar = {
  header: () => string;
  update?: (r: Response) => void;
};
type Options = {
  testContext: TestContext;
  readProbe: {
    run?: (client: PoolClient, account: { id: string }) => Promise<void>;
  };
  userOrigin: string;
  adminOrigin: string;
  evidenceAssetId: string;
  base: string;
  pool: Pool;
  maintenance: Pool;
  migration: Pool;
  runtimeUser: string;
  gameId: string;
  accountId: string;
  itemId: string;
  user: Jar;
  stranger: Jar;
  boss: Jar;
  bossId: string;
  operator: Jar;
  operatorId: string;
  bytes: Buffer;
  gates: Map<string, SupplyGate>;
};
export async function runPublishingChecks(o: Options): Promise<void> {
  const userPrefix = "/api/v1/supply/accounts/" + o.accountId,
    adminPrefix = "/api/bff/admin/supply/listing-reviews/" + o.accountId;
  const call = async (
    path: string,
    body: unknown,
    jar: Jar = o.user,
    method = body === undefined ? "GET" : "POST",
    key = "m3c_" + randomUUID(),
  ) => {
    const r = await fetch(o.base + path, {
      method,
      headers: {
        cookie: jar.header(),
        origin: path.includes("/admin/") ? o.adminOrigin : o.userOrigin,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    jar.update?.(r);
    const json = await r.json();
    return { status: r.status, body: json };
  };
  const ok = async (
    path: string,
    body: unknown,
    jar: Jar = o.user,
    method?: string,
  ) => {
    const r = await call(path, body, jar, method);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const get = () => ok(userPrefix, undefined);
  const token = (d: any) => ({
    expectedRevision: d.account.revision,
    versionId: d.version.id,
    releaseId: d.version.releaseId,
    contentHash: d.version.contentHash,
  });
  assert.equal((await call(userPrefix, undefined, o.stranger)).status, 404);
  // No default positive money/occupancy fixture.
  assert.equal(
    (await call(userPrefix + "/drafts", { expectedRevision: "1" })).status,
    409,
  );
  o.gates.set(o.accountId, {
    publisherBail: "UNKNOWN",
    occupancy: "FREE",
    reference: "fixture:m3c",
  });
  let d = await ok(userPrefix + "/drafts", { expectedRevision: "1" });
  const declaration = {
    title: "三角洲 · 60M资料审核样例",
    description: "合成申报，不代表平台已登录验号",
    attributes: {
      safe_box_code: "box-a",
      vit_level: 6,
      bear_level: 6,
      info_source: "private fixture note",
    },
    termOptionCode: "daily-10m",
    pricingOptionCode: "standard",
    inventory: [{ itemId: o.itemId, quantity: "60000000" }],
    skins: [],
    entitlements: [],
    mediaBindings: [] as Array<{
      assetId: string;
      position: number;
    }>,
  };
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      inventory: [{ itemId: o.itemId, quantity: null }],
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  assert.equal(
    (
      await call(userPrefix + "/quote", {
        expectedRevision: d.account.revision,
      })
    ).status,
    400,
    "null inventory is not free stock",
  );
  assert.equal(
    (
      await call(
        userPrefix + "/draft",
        {
          ...declaration,
          ownerId: "other",
          expectedRevision: d.account.revision,
        },
        o.user,
        "PUT",
      )
    ).status,
    400,
  );
  const intent = await ok("/api/v1/supply/media/upload-intents", {
    gameId: o.gameId,
    accountId: o.accountId,
    mime: "image/png",
    size: o.bytes.length,
    purpose: "ACCOUNT_DISPLAY",
  });
  const upload = await fetch(
    o.base + "/api/v1/supply/media/uploads/" + intent.intentId,
    {
      method: "PUT",
      headers: {
        origin: o.userOrigin,
        cookie: o.user.header(),
        "content-type": "image/png",
        "x-upload-token": intent.uploadToken,
        "idempotency-key": "m3c_upload_" + randomUUID(),
      },
      body: new Uint8Array(o.bytes),
    },
  );
  assert.equal(upload.status, 200);
  const asset = await upload.json();
  assert.equal(
    (
      await call(
        "/api/v1/supply/media/" + asset.assetId + "/content",
        undefined,
      )
    ).status,
    404,
    "user display has no unconditional public URL",
  );
  declaration.mediaBindings.push(
    { assetId: asset.assetId, position: 0 },
    { assetId: o.evidenceAssetId, position: 1 },
  );
  const secondAccount = await ok("/api/v1/supply/accounts", {
    gameId: o.gameId,
  });
  o.gates.set(secondAccount.accountId, {
    publisherBail: "NOT_REQUIRED",
    occupancy: "FREE",
    reference: "fixture:m3c",
  });
  const secondDraft = await ok(
    "/api/v1/supply/accounts/" + secondAccount.accountId + "/drafts",
    { expectedRevision: "1" },
  );
  assert.equal(
    (
      await call(
        "/api/v1/supply/accounts/" + secondAccount.accountId + "/draft",
        { ...declaration, expectedRevision: secondDraft.account.revision },
        o.user,
        "PUT",
      )
    ).status,
    400,
    "same owner cannot bind material from a different account",
  );
  d = await ok(
    userPrefix + "/draft",
    { ...declaration, expectedRevision: d.account.revision },
    o.user,
    "PUT",
  );
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      attributes: { safe_box_code: "box-a", vit_level: null, bear_level: null },
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  assert.equal(
    (
      await call(userPrefix + "/quote", {
        expectedRevision: d.account.revision,
      })
    ).status,
    400,
    "unknown pricing levels must not become zero even when level zero has a configured rate",
  );
  d = await ok(
    userPrefix + "/draft",
    { ...declaration, expectedRevision: d.account.revision },
    o.user,
    "PUT",
  );
  const timed = await ok(
    "/api/bff/admin/supply/games/" + o.gameId + "/entitlements",
    {
      code: "m3c_timed",
      name: "限时权益合成样例",
      valueKind: "FLAG",
      expiryKind: "TIMED",
    },
    o.boss,
  );
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      entitlements: [
        {
          entitlementId: timed.id,
          value: true,
          expiresAt: "2027-01-01T00:00:00Z",
          expiryKnowledge: "UNKNOWN",
        },
      ],
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  assert.equal(
    (
      await call(userPrefix + "/quote", {
        expectedRevision: d.account.revision,
      })
    ).status,
    400,
    "unknown expiry cannot become an assured date",
  );
  const hiddenSkin = (
    await o.pool.query(
      `SELECT id,category_id FROM zzsh_supply.skin WHERE game_id=$1 AND code='skin_m4_gold'`,
      [o.gameId],
    )
  ).rows[0];
  await ok(
    "/api/bff/admin/supply/categories/" + hiddenSkin.category_id,
    { formVisible: false },
    o.boss,
    "PUT",
  );
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      skins: [hiddenSkin.id],
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  assert.equal(
    (
      await call(userPrefix + "/quote", {
        expectedRevision: d.account.revision,
      })
    ).status,
    400,
    "hidden category blocks new skin declarations",
  );
  await ok(
    "/api/bff/admin/supply/categories/" + hiddenSkin.category_id,
    { formVisible: true },
    o.boss,
    "PUT",
  );
  d = await ok(
    userPrefix + "/draft",
    { ...declaration, expectedRevision: d.account.revision },
    o.user,
    "PUT",
  );
  d = await ok(userPrefix + "/quote", { expectedRevision: d.account.revision });
  assert.equal(d.version.quote.resourceTotal.amount, "150.00");
  assert.equal(d.version.quote.ownerTotal.amount, "120.00");
  assert.equal("platformFullProfit" in d.version.quote, false);
  const priceHash = d.version.contentHash;
  const options = await ok(
    "/api/v1/supply/games/" + o.gameId + "/publishing-options",
    undefined,
  );
  assert.ok(options.termOptions.some((t: any) => t.code === "daily-10m"));
  assert.ok(options.pricingOptionCodes.includes("standard"));
  assert.equal(d.agreement.id, options.agreement.id);
  assert.equal(d.agreement.body, options.agreement.body);
  assert.equal(JSON.stringify(options).includes("commission_rate"), false);
  assert.equal(
    (
      await call(userPrefix + "/accept-rules", {
        ...token(d),
        contentHash: "f".repeat(64),
      })
    ).status,
    409,
  );
  d = await ok(userPrefix + "/accept-rules", token(d));
  assert.equal(
    (await call(userPrefix + "/submit", token(d))).status,
    409,
    "identity and money unknown block publication",
  );
  const owner = (
    await o.pool.query(
      `SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1`,
      [o.accountId],
    )
  ).rows[0].owner_user_id;
  const actorShape = await o.pool.connect();
  try {
    await actorShape.query("BEGIN");
    await assert.rejects(
      () =>
        actorShape.query(
          `INSERT INTO zzsh_supply.media_upload_intent(id,token_hash,game_id,account_id,purpose,ownership_kind,owner_user_id,uploaded_by_realm,uploaded_by_user_id,declared_mime,declared_size,expires_at) VALUES($1,$2,$3,$4,'ACCOUNT_DISPLAY','USER_SUPPLY',$5,'user',NULL,'image/png',1,clock_timestamp()+interval '1 minute')`,
          [
            "missing_actor_" + randomUUID(),
            "f".repeat(64),
            o.gameId,
            o.accountId,
            owner,
          ],
        ),
      { code: "23514" },
    );
  } finally {
    await actorShape.query("ROLLBACK");
    actorShape.release();
  }
  await o.maintenance.query(
    `INSERT INTO zzsh_iam.user_identity_state(user_id,account_status,identity_status,age_status,provider) VALUES($1,'ACTIVE','VERIFIED','ADULT','fake') ON CONFLICT(user_id) DO UPDATE SET identity_status='VERIFIED',age_status='ADULT'`,
    [owner],
  );
  o.gates.set(o.accountId, {
    publisherBail: "NOT_REQUIRED",
    occupancy: "FREE",
    reference: "fixture:m3c",
  });
  assert.equal(
    (await call(userPrefix + "/submit", token(d))).status,
    409,
    "display must be reviewed before publication",
  );
  await ok(
    "/api/bff/admin/supply/media/" + asset.assetId + "/review",
    { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" },
    o.boss,
  );
  d = await ok(userPrefix + "/submit", token(d));
  assert.equal(d.version.reviewState, "SUBMITTED");
  const submittedId = d.version.id;
  assert.equal(
    (
      await call(
        userPrefix + "/draft",
        { ...declaration, expectedRevision: d.account.revision },
        o.user,
        "PUT",
      )
    ).status,
    409,
  );
  await assert.rejects(
    () =>
      o.pool.query(
        `UPDATE zzsh_supply.inventory_line SET quantity=0 WHERE version_id=$1`,
        [submittedId],
      ),
    { code: "40001" },
  );
  d = await ok(userPrefix + "/pause", {
    expectedRevision: d.account.revision,
    reason: "审核期间暂不接单",
  });
  d = await ok(
    adminPrefix + "/decide",
    {
      ...token(d),
      decision: "APPROVE",
      reason: "资料与展示图一致，仅核对申报",
    },
    o.operator,
  );
  assert.equal(d.account.owner_paused, true);
  assert.equal(
    (await call("/api/v1/supply/listings/" + o.accountId, undefined)).status,
    404,
  );
  d = await ok(userPrefix + "/resume", {
    expectedRevision: d.account.revision,
  });
  assert.equal(
    (
      await call("/api/auth/user/account/cancel", {
        reason: "尝试注销有有效供给的测试用户",
      })
    ).status,
    409,
    "active supply is an outstanding obligation",
  );
  const publicListing = await ok(
    "/api/v1/supply/listings/" + o.accountId,
    undefined,
  );
  assert.equal(publicListing.title, declaration.title);
  for (const field of [
    "owner_user_id",
    "ownerTotal",
    "platformFullProfit",
    "info_source",
    "contentHash",
    "byteHash",
  ])
    assert.equal(JSON.stringify(publicListing).includes(field), false, field);
  assert.equal((await fetch(o.base + publicListing.media[0].url)).status, 200);
  assert.equal(
    (
      await fetch(
        o.base +
          "/api/v1/supply/listings/" +
          o.accountId +
          "/media/" +
          o.evidenceAssetId,
      )
    ).status,
    404,
    "private evidence cannot be read through listing media",
  );
  const filtered = await ok(
    "/api/v1/supply/listings?gameId=" +
      o.gameId +
      "&itemId=" +
      o.itemId +
      "&minQuantity=60000001",
    undefined,
  );
  assert.equal(filtered.items.length, 0);
  d = await ok(
    adminPrefix + "/restriction",
    {
      expectedRevision: d.account.revision,
      restricted: true,
      reason: "等待复核账号资料",
    },
    o.boss,
  );
  assert.equal((await fetch(o.base + publicListing.media[0].url)).status, 404);
  assert.equal(
    (
      await call(userPrefix + "/resume", {
        expectedRevision: d.account.revision,
      })
    ).status,
    409,
  );
  d = await ok(
    adminPrefix + "/restriction",
    {
      expectedRevision: d.account.revision,
      restricted: false,
      reason: "复核完成解除限制",
    },
    o.boss,
  );
  d = await ok(userPrefix + "/drafts", {
    expectedRevision: d.account.revision,
  });
  assert.notEqual(d.version.id, submittedId);
  assert.equal(
    (await fetch(o.base + publicListing.media[0].url)).status,
    404,
    "key edit blocks old listing media",
  );
  assert.equal(
    (
      await o.pool.query(
        `SELECT content_hash FROM zzsh_supply.listing_version WHERE id=$1`,
        [submittedId],
      )
    ).rows[0].content_hash,
    priceHash,
  );
  const history = await ok(userPrefix + "?versionId=" + submittedId, undefined);
  assert.equal(history.version.id, submittedId);
  assert.equal(history.available, false);
  assert.equal(history.version.quote.resourceTotal.amount, "150.00");
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      title: "退回修改样例",
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  d = await ok(userPrefix + "/quote", { expectedRevision: d.account.revision });
  d = await ok(userPrefix + "/accept-rules", token(d));
  d = await ok(userPrefix + "/submit", token(d));
  const raceToken = token(d);
  const race = await Promise.all([
    call(
      adminPrefix + "/decide",
      { ...raceToken, decision: "REJECT", reason: "请补充账号截图" },
      o.operator,
    ),
    call(userPrefix + "/withdraw", {
      expectedRevision: d.account.revision,
      versionId: d.version.id,
      reason: "主动补充资料",
    }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  d = await get();
  assert.ok(["WITHDRAWN", "REJECTED"].includes(d.version.reviewState));
  d = await ok(userPrefix + "/drafts", {
    expectedRevision: d.account.revision,
  });
  d = await ok(userPrefix + "/quote", { expectedRevision: d.account.revision });
  d = await ok(userPrefix + "/accept-rules", token(d));
  const g = (
    await o.pool.query(
      `SELECT r.* FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id WHERE g.id=$1`,
      [o.gameId],
    )
  ).rows[0];
  await ok(
    "/api/bff/admin/supply/releases",
    {
      gameId: o.gameId,
      priceVersionId: g.price_version_id,
      termVersionId: g.term_version_id,
      agreementVersionId: g.agreement_version_id,
      expectedGeneration: g.generation,
    },
    o.boss,
  );
  assert.equal(
    (await call(userPrefix + "/submit", token(d))).status,
    409,
    "rule replacement invalidates prior acceptance",
  );
  d = await ok(userPrefix + "/quote", { expectedRevision: d.account.revision });
  assert.notEqual(d.version.contentHash, priceHash);
  d = await ok(userPrefix + "/accept-rules", token(d));
  o.gates.set(o.accountId, {
    publisherBail: "SATISFIED",
    occupancy: "UNKNOWN",
    reference: "fixture:unknown",
  });
  assert.equal((await call(userPrefix + "/submit", token(d))).status, 409);
  o.gates.set(o.accountId, {
    publisherBail: "PENDING",
    occupancy: "FREE",
    reference: "fixture:pending",
  });
  assert.equal((await call(userPrefix + "/submit", token(d))).status, 409);
  o.gates.set(o.accountId, {
    publisherBail: "SATISFIED",
    occupancy: "FREE",
    reference: "fixture:ready",
  });
  await o.maintenance.query(
    `UPDATE zzsh_iam.user_identity_state SET age_status='MINOR' WHERE user_id=$1`,
    [owner],
  );
  assert.equal((await call(userPrefix + "/submit", token(d))).status, 409);
  await o.maintenance.query(
    `UPDATE zzsh_iam.user_identity_state SET age_status='ADULT' WHERE user_id=$1`,
    [owner],
  );
  const identityGate = await o.pool.connect();
  try {
    await identityGate.query("BEGIN");
    await identityGate.query(
      `SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,
      [owner],
    );
    const pid = (await identityGate.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const waitBlocked = async (count: number) => {
      let n = 0,
        deadline = Date.now() + 5000;
      while (n < count && Date.now() < deadline)
        n = Number(
          (
            await identityGate.query(
              `SELECT count(*) AS n FROM pg_stat_activity WHERE pid<>$1 AND datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`,
              [pid],
            )
          ).rows[0].n,
        );
      assert.equal(n, count);
    };
    const deactivation = call("/api/auth/user/account/deactivate", {
      reason: "隔离身份并发验证",
    });
    await waitBlocked(1);
    const concurrentSubmit = call(userPrefix + "/submit", token(d));
    await waitBlocked(2);
    await identityGate.query("COMMIT");
    assert.equal((await deactivation).status, 200);
    assert.equal(
      (await concurrentSubmit).status,
      401,
      "deactivated user cannot publish after waiting for the user lock",
    );
  } finally {
    await identityGate.query("ROLLBACK");
    identityGate.release();
  }
  // Restore only the isolated fixture; production restoration keeps the M2 reauthentication path.
  await o.maintenance.query(
    `UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1`,
    [owner],
  );
  await o.maintenance.query(
    `UPDATE zzsh_iam.user_identity_state SET account_status='ACTIVE',identity_status='VERIFIED',age_status='ADULT' WHERE user_id=$1`,
    [owner],
  );
  await ok("/api/auth/user/sign-in/username", {
    username: "m3b_user_1",
    password: "Sup3rSecret#One",
  });
  await o.migration.query(
    `REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`,
  );
  const rollback = await call(userPrefix + "/submit", token(d));
  assert.equal(rollback.status, 500);
  await o.migration.query(
    `GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`,
  );
  assert.equal((await get()).version.reviewState, "DRAFT");
  const key = "m3c_submit_" + randomUUID(),
    submitBody = token(d);
  const first = await call(
    userPrefix + "/submit",
    submitBody,
    o.user,
    "POST",
    key,
  );
  assert.equal(first.status, 200);
  assert.deepEqual(
    (await call(userPrefix + "/submit", submitBody, o.user, "POST", key)).body,
    first.body,
  );
  d = first.body;
  const decisionKey = "m3c_decide_" + randomUUID(),
    decisionBody = {
      ...token(d),
      decision: "REJECT",
      reason: "请补充可核对的资料截图",
    };
  const decision = await call(
    adminPrefix + "/decide",
    decisionBody,
    o.operator,
    "POST",
    decisionKey,
  );
  assert.equal(decision.status, 200);
  d = decision.body;
  await o.maintenance.query(
    `DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`,
    [o.operatorId, o.gameId],
  );
  assert.equal(
    (
      await call(
        adminPrefix + "/decide",
        decisionBody,
        o.operator,
        "POST",
        decisionKey,
      )
    ).status,
    404,
  );
  await o.maintenance.query(
    `INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$3)`,
    [o.operatorId, o.gameId, o.bossId],
  );
  const beforeDuplicate = await get();
  await ok(
    adminPrefix + "/duplicates",
    {
      expectedRevision: beforeDuplicate.account.revision,
      relatedAccountId: secondAccount.accountId,
      result: "POSSIBLE_SAME",
      evidenceRef: "asset:" + asset.assetId,
      reason: "合成的人工关联线索，仅供核对",
    },
    o.boss,
  );
  const afterDuplicate = await ok(adminPrefix, undefined, o.boss);
  assert.equal(
    afterDuplicate.version.reviewState,
    beforeDuplicate.version.reviewState,
  );
  assert.equal(
    afterDuplicate.account.owner_paused,
    beforeDuplicate.account.owner_paused,
  );
  assert.ok(
    afterDuplicate.duplicateHints.some(
      (h: any) => h.result === "POSSIBLE_SAME",
    ),
  );
  assert.equal(
    (await call(userPrefix + "?versionId=not_this_accounts_version", undefined))
      .status,
    404,
  );
  const audits = (
    await o.pool.query(
      `SELECT * FROM zzsh_iam.audit_event WHERE object_id=$1 AND action LIKE 'supply.publication.%' ORDER BY occurred_at`,
      [o.accountId],
    )
  ).rows;
  assert.ok(audits.length > 15);
  assert.ok(
    audits.every((r) => r.reason && r.details.before && r.details.after),
  );
  assert.ok(
    audits.some(
      (r) =>
        r.action === "supply.publication.decide" &&
        r.details.after.versionState === "REJECTED",
    ),
  );
  assert.equal(JSON.stringify(audits).includes("private fixture note"), false);
  const legacy = await ok("/api/v1/supply/accounts", { gameId: o.gameId });
  const legacySource = {
    sourceSystem: "synthetic-old",
    sourceEntity: "RentalAccounts",
    legacyId: "00017-A",
    evidenceRef: "fixture:status3-unknown-unit",
    sourceDigest: "a".repeat(64),
    inventory: [{ itemId: o.itemId, quantity: null }],
  };
  const session = (
    await o.pool.query(
      `SELECT id FROM zzsh_auth_admin.session WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
      [o.bossId],
    )
  ).rows[0].id;
  const observe = (input = legacySource) =>
    withTransaction(o.pool, (c) =>
      recordLegacyObservation(c, legacy.accountId, input, {
        id: o.bossId,
        sessionId: session,
        requestId: "m3c_legacy_" + randomUUID(),
      }),
    );
  const observedId = await observe();
  assert.equal(await observe(), observedId);
  await assert.rejects(() =>
    observe({ ...legacySource, sourceDigest: "b".repeat(64) }),
  );
  const oldRecord = await ok(
    "/api/v1/supply/accounts/" + legacy.accountId,
    undefined,
  );
  assert.equal(oldRecord.version.reviewState, "IMPORTED_UNVERIFIED");
  assert.equal(oldRecord.version.quote, null);
  assert.equal(oldRecord.version.declaration.inventory[0].quantity, null);
  assert.equal(
    (await call("/api/v1/supply/listings/" + legacy.accountId, undefined))
      .status,
    404,
  );
  assert.equal(
    (
      await call("/api/v1/supply/accounts/" + legacy.accountId + "/drafts", {
        expectedRevision: oldRecord.account.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await ok("/api/bff/user/supply/accounts/" + o.accountId, undefined))
      .account.id,
    o.accountId,
  );
  // Leave a real pending review for browser replay; API operations remain fixture-only.
  d = await ok(userPrefix + "/drafts", {
    expectedRevision: d.account.revision,
  });
  d = await ok(
    userPrefix + "/draft",
    {
      ...declaration,
      title: "补充资料复审样例",
      inventory: [{ itemId: o.itemId, quantity: "50000000" }],
      expectedRevision: d.account.revision,
    },
    o.user,
    "PUT",
  );
  d = await ok(userPrefix + "/quote", { expectedRevision: d.account.revision });
  d = await ok(userPrefix + "/accept-rules", token(d));
  await ok(userPrefix + "/submit", token(d));
  await o.testContext.test(
    "M3-C review R1: anonymous versionless account is closed",
    async () => {
      const empty = await ok("/api/v1/supply/accounts", { gameId: o.gameId });
      const response = await fetch(
        o.base + "/api/v1/supply/listings/" + empty.accountId,
      );
      const body = await response.json();
      assert.equal(
        response.status,
        404,
        JSON.stringify({ status: response.status, keys: Object.keys(body) }),
      );
      for (const key of ["account", "owner_user_id", "restriction_reason"])
        assert.equal(JSON.stringify(body).includes(key), false);
      assert.equal(
        (
          await fetch(
            o.base + "/api/bff/user/supply/listings/" + empty.accountId,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(
            o.base +
              "/api/v1/supply/listings/" +
              empty.accountId +
              "/media/unknown_asset",
          )
        ).status,
        404,
      );
      assert.equal(
        (await ok("/api/v1/supply/accounts/" + empty.accountId, undefined))
          .version,
        null,
      );
      assert.equal(
        (
          await ok(
            "/api/bff/admin/supply/listing-reviews/" + empty.accountId,
            undefined,
            o.boss,
          )
        ).version,
        null,
      );
    },
  );
  await o.testContext.test(
    "M3-C review R2: quote field revocation also applies to cached writes",
    async () => {
      const before = await get(),
        key = "review_r2_" + randomUUID();
      const body = {
        ...token(before),
        decision: "APPROVE",
        reason: "定向返修缓存字段权限验证",
      };
      const first = await call(
        adminPrefix + "/decide",
        body,
        o.operator,
        "POST",
        key,
      );
      assert.equal(first.status, 200);
      assert.ok(first.body.version.quote.ownerTotal);
      const count = async () =>
        (
          await o.pool.query(
            `SELECT count(*)::text AS count FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='supply.publication.decide'`,
            [o.accountId],
          )
        ).rows[0].count;
      const auditBefore = await count();
      await o.maintenance.query(
        `UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='supply.quote.internal.read'`,
        [o.operatorId],
      );
      try {
        const advanced = await ok(
          adminPrefix + "/restriction",
          {
            expectedRevision: first.body.account.revision,
            restricted: false,
            reason: "推进状态以验证缓存仍是原回执",
          },
          o.boss,
        );
        assert.notEqual(advanced.account.revision, first.body.account.revision);
        const replay = await call(
          adminPrefix + "/decide",
          body,
          o.operator,
          "POST",
          key,
        );
        assert.equal(replay.status, 200);
        for (const field of [
          "ownerTotal",
          "ownerAmount",
          "ownerUnitAmount",
          "platformFullProfit",
          "platformAmount",
          "pricingInputs",
          "publisherBailRequirement",
        ])
          assert.equal(
            JSON.stringify(replay.body.version.quote).includes(field),
            false,
            field,
          );
        assert.equal(replay.body.version.id, first.body.version.id);
        assert.equal(replay.body.account.revision, first.body.account.revision);
        assert.equal(await count(), auditBefore);
        const cached = (
          await o.pool.query(
            `SELECT response_body FROM zzsh_supply.idempotency_record WHERE key=$1`,
            [key],
          )
        ).rows[0].response_body;
        assert.deepEqual(
          cached,
          first.body,
          "response projection must not mutate the stored receipt",
        );
      } finally {
        await o.maintenance.query(
          `UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='supply.quote.internal.read'`,
          [o.operatorId],
        );
      }
    },
  );
  await o.testContext.test(
    "M3-C review R3: public readers do not serialize peers or writers, and keep one snapshot",
    async () => {
      const routes = [
        "/api/v1/supply/listings/" + o.accountId,
        "/api/v1/supply/listings/" + o.accountId + "/media/" + asset.assetId,
        "/api/v1/supply/listings?gameId=" + o.gameId,
      ];
      for (const route of routes) {
        let release!: () => void,
          arrived!: () => void,
          readerPid = 0,
          seen = false,
          snapshot: { isolation?: string; readOnly?: string } = {};
        const barrier = new Promise<void>((r) => (release = r)),
          atGate = new Promise<void>((r) => (arrived = r));
        o.readProbe.run = async (client, a) => {
          if (a.id !== o.accountId || seen) return;
          seen = true;
          readerPid = (await client.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          snapshot = {
            isolation: (await client.query("SHOW transaction_isolation"))
              .rows[0].transaction_isolation,
            readOnly: (await client.query("SHOW transaction_read_only")).rows[0]
              .transaction_read_only,
          };
          arrived();
          await barrier;
        };
        const first = fetch(o.base + route, {
          signal: AbortSignal.timeout(10000),
        });
        try {
          await Promise.race([
            atGate,
            first.then(() => {
              throw Error("request finished before the snapshot barrier");
            }),
          ]);
          const peer = await fetch(o.base + route, {
            signal: AbortSignal.timeout(1500),
          }).then(
            (r) => r.status,
            () => 0,
          );
          const blocked = (
            await o.maintenance.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
              [readerPid],
            )
          ).rows[0].blocked;
          const writer = await o.maintenance.connect();
          let writerError: string | null = null;
          try {
            await writer.query("BEGIN");
            await writer.query("SET LOCAL lock_timeout='1500ms'");
            await writer.query(
              "UPDATE zzsh_supply.game SET catalog_revision=catalog_revision+1 WHERE id=$1",
              [o.gameId],
            );
            await writer.query(
              'UPDATE zzsh_auth_user."user" SET suspended=suspended WHERE id=(SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1)',
              [o.accountId],
            );
            await writer.query(
              "UPDATE zzsh_supply.rental_account SET owner_paused=true WHERE id=$1",
              [o.accountId],
            );
            await writer.query(
              "UPDATE zzsh_supply.media_asset SET access_class='PRIVATE_REVIEW' WHERE id=$1",
              [asset.assetId],
            );
            await writer.query("COMMIT");
          } catch (e) {
            writerError = (e as { code: string }).code;
            await writer.query("ROLLBACK");
          } finally {
            writer.release();
          }
          release();
          const original = await first;
          assert.deepEqual(
            { peer, blocked, writerError },
            { peer: 200, blocked: false, writerError: null },
            route,
          );
          assert.equal(
            original.status,
            200,
            "in-flight read uses the pre-revocation snapshot for account and media together",
          );
          assert.deepEqual(snapshot, {
            isolation: "repeatable read",
            readOnly: "on",
          });
          if (route.includes("?"))
            assert.equal(
              (await original.json()).items.some(
                (i: any) => i.id === o.accountId,
              ),
              true,
              "the entire list uses the pre-revocation snapshot",
            );
          for (const next of routes) {
            const r = await fetch(o.base + next);
            if (next.includes("?"))
              assert.equal(
                (await r.json()).items.some((i: any) => i.id === o.accountId),
                false,
              );
            else assert.equal(r.status, 404);
          }
          await o.maintenance.query(
            "UPDATE zzsh_supply.rental_account SET owner_paused=false WHERE id=$1",
            [o.accountId],
          );
          for (const next of routes) {
            const r = await fetch(o.base + next);
            if (next.includes("?"))
              assert.equal(
                (await r.json()).items.some((i: any) => i.id === o.accountId),
                false,
              );
            else
              assert.equal(
                r.status,
                404,
                "media revocation alone must reject new reads",
              );
          }
        } finally {
          release();
          o.readProbe.run = undefined;
          await first.catch(() => undefined);
          await o.maintenance.query(
            "UPDATE zzsh_supply.rental_account SET owner_paused=false WHERE id=$1",
            [o.accountId],
          );
          await o.maintenance.query(
            "UPDATE zzsh_supply.media_asset SET access_class='PUBLIC_DISPLAY' WHERE id=$1",
            [asset.assetId],
          );
        }
      }
    },
  );
}
