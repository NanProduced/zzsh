import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import { createApp } from "../src/app";
import { withTransaction } from "../src/auth/security-core";
import { createControlledPaymentSource, confirmOrderPayment, orderDispatchLockKey } from "../src/order/payment-confirmation";
import { dispatchPaidOrders, assignWaitingOrders, OrderDispatchLifecycle } from "../src/im/order-dispatch";
import { lockSupportMutation, readEligibleSupport, reserveSupportCandidate } from "../src/im/support-dispatch";
import { clearSupportPresenceForSession } from "../src/im/support-presence-session";
import { createOrResumeUserConsultation, claimConsultation, closeConsultation, transferConsultation, reconcileMessageScopes,
  readOwnPresence, updateOwnPresence, MessageScopeRecoveryLifecycle, supportManagerIdentityKey } from "../src/im/consultation";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { FakeSupportScopeProvider, seedAdmin, seedUser, seedIdentity, adminContext, userContext } from "./im-test-fixtures";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

export async function runDispatchAcceptance(t: TestContext, o: Parameters<typeof runPaymentAcceptance>[1]): Promise<void> {
  const { pool, migrationPool, ownerPool } = o;
  const run = randomUUID().replaceAll("-", "").slice(0, 10);
  const appId = `dispatch_${run}`;
  const a = `disp_a_${run}`, b = `disp_b_${run}`;
  const contextA = adminContext(a, `${a}_session`), contextB = adminContext(b, `${b}_session`);
  const key = (kind: "USER" | "ADMIN", id: string, app = appId): ImIdentityKey => ({ provider: "yunxin", appId: app, realm: kind === "ADMIN" ? "admin" : "user", kind, platformSubjectId: id });
  const provider = new FakeSupportScopeProvider();
  const managerKey = supportManagerIdentityKey(appId);
  let managerReady = true;
  const options = { pool, appId, provider, supportManager: { key: managerKey, provisioner: { ensure: async () => ({
    outcome: managerReady ? "READY" as const : "PENDING" as const,
    mapping: { id: `manager_${run}`, key: managerKey, accountId: deriveYunxinAccountId(managerKey), identityMarker: buildYunxinIdentityMarker(managerKey),
      status: managerReady ? "READY" as const : "PENDING" as const, version: 1, attemptCount: 0, attemptLeaseUntil: null, nextRetryAt: null, lastFailure: null },
  }) } } };
  const permissions = ["im.support.read", "im.support.accept", "im.support.presence", "im.support.transfer", "im.support.complaint"];
  for (const id of [a, b]) {
    await seedAdmin(pool, id, `${id}_session`, run, false);
    await seedIdentity(pool, key("ADMIN", id), run);
    for (const permission of permissions) await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES ($1,$2,'ALLOW')`, [id, permission]);
  }
  const presence = async (id: string, availability: "AVAILABLE" | "OFF_DUTY" | "PAUSED" = "AVAILABLE", wake?: () => void) => {
    const ctx = id === a ? contextA : contextB;
    const version = (await readOwnPresence(options, ctx)).version;
    return updateOwnPresence({ ...options, wakeDispatch: wake }, ctx, { version, availability, connectionState: "CONNECTED" }, `req_${randomUUID()}`);
  };
  await presence(a); await presence(b, "OFF_DUTY");
  let gameId = "";
  const paid = async (label: string, app = appId) => {
    const f = await o.fixture(label);
    const row = (await pool.query(`SELECT display_no,game_id,(rental_amount_cents+deposit_amount_cents)::text AS total FROM zzsh_order.rental_order WHERE id=$1`, [f.orderId])).rows[0];
    if (!gameId) {
      gameId = row.game_id;
      for (const id of [a,b]) await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES ($1,$2,$3)`, [id, gameId, a]);
    }
    const source = createControlledPaymentSource({ config: o.config, resourceSet: o.resourceSet, appId: app, merchantScopeId: "dispatch_fixture", allowedOrderIds: [f.orderId] });
    const fact = source({ orderId: f.orderId, merchantOrderNo: row.display_no, providerTransactionId: `pay_${randomUUID()}`, amountCents: row.total,
      currency: "CNY", providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` });
    await withTransaction(pool, (c) => confirmOrderPayment(c, fact));
    return { ...f, fact };
  };
  const group = async (id: string) => (await pool.query(`SELECT * FROM zzsh_order.im_order_group WHERE order_id=$1`, [id])).rows[0];
  const stats = async (id: string) => (await pool.query(`SELECT active_load,version,last_order_assigned_at::text,last_consultation_assigned_at::text
    FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, id])).rows[0];
  const user = async () => {
    const id = `disp_user_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await seedUser(pool, id, `${id}_s`, run);
    await seedIdentity(pool, key("USER", id), run);
    return userContext(id, `${id}_s`);
  };
  const waitLock = async (application?: string, count=1) => {
    for (let i=0;i<1000;i++) {
      const rows = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND ($1::text IS NULL OR application_name=$1)`, [application ?? null])).rows;
      if (rows[0].n>=count) return;
    }
    assert.fail("actual App-gate lock waiter not observed");
  };
  const deadlocksBefore = (await ownerPool.query(`SELECT deadlocks::text FROM pg_stat_database WHERE datname=current_database()`)).rows[0].deadlocks;
  let externalRequests = 0;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") { externalRequests++; throw new Error("Real provider request forbidden in dispatch acceptance"); }
    return nativeFetch(input, init);
  }) as typeof fetch;
  try {
    await t.test("D01 single assignment across workers, stable batch order and no capacity", async () => {
      const orders: Array<Awaited<ReturnType<typeof paid>>> = [];
      for (let i=0;i<5;i++) orders.push(await paid(`派单无容量${i}`));
      const version = (await stats(a)).version;
      const [one,two] = await Promise.all([dispatchPaidOrders(pool,appId,3),dispatchPaidOrders(pool,appId,3)]);
      assert.deepEqual([...one.assigned,...two.assigned].sort(), orders.map((f)=>f.orderId).sort());
      assert.deepEqual((await pool.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE app_id=$1 ORDER BY assigned_at,order_id`,[appId])).rows.map((r)=>r.order_id),orders.map((f)=>f.orderId));
      for (const f of orders) assert.equal((await group(f.orderId)).assigned_admin_id,a);
      const view=(await o.api(`/api/v1/orders/${orders[0]!.orderId}`)).body!.order.fulfillmentAssignment;
      assert.equal(view.state,"ASSIGNED");assert.equal(view.teamReady,false);assert.ok(view.assignedAt);
      const previous = await stats(a);
      assert.equal(previous.active_load,0); assert.equal(previous.version,version);
      await withTransaction(pool,(c)=>confirmOrderPayment(c,orders[0]!.fact));
      assert.deepEqual((await dispatchPaidOrders(pool,appId)).assigned,[]);
      assert.deepEqual(await stats(a),previous);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='im.order.assigned' AND details->>'appId'=$1`,[appId])).rows[0].n,5);
      assert.equal(provider.created.length,0,"local assignment never constructs Teams");
    });

    await t.test("D02 NULL/ties and separate consultation/order clocks", async () => {
      await presence(b);
      await pool.query(`UPDATE zzsh_iam.im_support_presence SET last_order_assigned_at=NULL,last_consultation_assigned_at=NULL WHERE app_id=$1`,[appId]);
      const firstUser=await user();
      const consult=await createOrResumeUserConsultation(options,firstUser,"SERVICE",null,`req_${run}_rotation`);
      assert.equal(consult.consultation.assignedAdmin?.id,a);
      const before=await stats(a);
      const f=await paid("独立轮转"); await dispatchPaidOrders(pool,appId);
      assert.equal((await group(f.orderId)).assigned_admin_id,a);
      assert.equal((await stats(a)).last_consultation_assigned_at,before.last_consultation_assigned_at);
      assert.equal((await stats(a)).active_load,1);
      const f2=await paid("独立轮转二"); await dispatchPaidOrders(pool,appId);
      assert.equal((await group(f2.orderId)).assigned_admin_id,b);
      const second=await createOrResumeUserConsultation(options,await user(),"SERVICE",null,`req_${run}_rotation2`);
      assert.equal(second.consultation.assignedAdmin?.id,b);
      const complaint=await createOrResumeUserConsultation(options,firstUser,"COMPLAINT",consult.consultation.id,`req_${run}_complaint`);
      assert.equal(complaint.consultation.assignedAdmin?.id,a,"legacy COMPLAINT rounds follow normal rotation without exclusions");
    });

    await t.test("D03 qualification matrix and bad queue does not block service", async () => {
      await presence(a); await presence(b,"OFF_DUTY");
      const f=await paid("资格边界");
      const variants = [
        `UPDATE zzsh_iam.im_support_presence SET availability='OFF_DUTY' WHERE admin_user_id=$1`,
        `UPDATE zzsh_iam.im_support_presence SET availability='PAUSED' WHERE admin_user_id=$1`,
        `UPDATE zzsh_iam.im_support_presence SET connection_state='DISCONNECTED' WHERE admin_user_id=$1`,
        `UPDATE zzsh_iam.im_support_presence SET last_connected_at=clock_timestamp()-interval '3 minutes' WHERE admin_user_id=$1`,
        `UPDATE zzsh_iam.admin_security SET status='FROZEN' WHERE admin_user_id=$1`,
        `UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,
        `UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`,
        `UPDATE zzsh_iam.im_identity_mapping SET status='DISABLED' WHERE platform_subject_id=$1 AND app_id='${appId}'`,
      ];
      for (const sql of variants) {
        const c=await pool.connect();
        try { await c.query("BEGIN"); const locked=await lockSupportMutation(c,appId); await c.query(sql,[a]);
          assert.equal((await readEligibleSupport(c,appId,locked)).length,0);
          assert.deepEqual((await assignWaitingOrders(c,appId,await readEligibleSupport(c,appId,locked))).assigned,[]);
        } finally { await c.query("ROLLBACK"); c.release(); }
      }
      assert.deepEqual(await withTransaction(pool,async(c)=>{const locked=await lockSupportMutation(c,"wrong-app");return readEligibleSupport(c,"wrong-app",locked);}),[]);
      await ownerPool.query(`UPDATE zzsh_iam.admin_security SET game_scope_mode='SELECTED_GAMES' WHERE admin_user_id=$1`,[a]);
      await ownerPool.query(`DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1`,[a]);
      const service=await createOrResumeUserConsultation(options,await user(),"SERVICE",null,`req_${run}_scope`);
      assert.equal(service.consultation.state,"ACTIVE");
      assert.equal((await group(f.orderId)).wait_reason,"NO_ELIGIBLE_STAFF");
      assert.equal((await o.api(`/api/v1/orders/${f.orderId}`)).body!.order.fulfillmentAssignment.waitingReason,"NO_ELIGIBLE_STAFF");
      await pool.query(`UPDATE zzsh_iam.admin_security SET game_scope_mode='ALL_GAMES' WHERE admin_user_id=$1`,[a]);
      await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`,[a,gameId]);
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.complaint'`,[a]);
      // 投诉有独立权限门禁：缺少 im.support.complaint 时不进入候选。
      const complaint=await createOrResumeUserConsultation(options,await user(),"COMPLAINT",null,`req_${run}_denied_complaint`);
      assert.equal(complaint.consultation.state,"WAITING");
      assert.equal(complaint.consultation.assignedAdmin,null);
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.complaint'`,[a]);
    });

    await t.test("D04 revoke/offline before qualification locks; no stale candidate and no skip", async () => {
      const f=await paid("资格竞争");
      for (const change of ["offline","revoke"] as const) {
      const discovered=deferred(), resume=deferred();
      const pending=withTransaction(pool,async(c)=>{
        const raw=c.query.bind(c);
        c.query=(async(sql:string,params:unknown[])=>{const r=await raw(sql,params);if(sql.includes("UNION SELECT unnest")){discovered.resolve();await resume.promise;}return r;}) as typeof c.query;
        try { const locked=await lockSupportMutation(c,appId); return assignWaitingOrders(c,appId,await readEligibleSupport(c,appId,locked)); }
        finally { c.query=raw; }
      });
      try {
        await discovered.promise;
        if(change==="offline") await presence(a,"OFF_DUTY");
        else await withTransaction(pool,async(c)=>{
          await c.query(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id=$1 FOR UPDATE`,[a]);
          await c.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,[a]);
        });
      } finally { resume.resolve(); }
      assert.deepEqual((await pending).assigned,[]); assert.equal((await group(f.orderId)).assigned_admin_id,null);
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,[a]);
      await presence(a);
      }
      await presence(a); await presence(b);
      const blocker=await pool.connect();
      try {await blocker.query("BEGIN");await blocker.query(`SELECT admin_user_id FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2 FOR UPDATE`,[appId,a]);
        await assert.rejects(dispatchPaidOrders(pool,appId),{code:"55P03"});
        assert.equal((await group(f.orderId)).assigned_admin_id,null,"a locked staff set defers the whole attempt, never skips to b");
      } finally {await blocker.query("ROLLBACK");blocker.release();}
      const roleId=`dispatch_role_${run}`;
      let roleCreated=false;
      try {
        await pool.query(`INSERT INTO zzsh_iam.admin_role(id,code,name,status) VALUES($1,$1,'Dispatch fixture role','ACTIVE')`,[roleId]);
        roleCreated=true;
        await pool.query(`INSERT INTO zzsh_iam.admin_role_permission(role_id,permission_code) VALUES($1,'im.support.read')`,[roleId]);
        for(const id of [a,b]) await pool.query(`INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES($1,$2)`,[id,roleId]);
        const roleWriter=await pool.connect();
        try {
          await roleWriter.query("BEGIN");await roleWriter.query(`SELECT id FROM zzsh_iam.admin_role WHERE id=$1 FOR UPDATE`,[roleId]);
          await assert.rejects(dispatchPaidOrders(pool,appId),{code:"55P03"});
          assert.equal((await group(f.orderId)).assigned_admin_id,null,"IAM role writer defers the whole dispatch instead of forming a reverse wait cycle");
        } finally {await roleWriter.query("ROLLBACK");roleWriter.release();}
        await dispatchPaidOrders(pool,appId);
      } finally {
        if(roleCreated){
          await migrationPool.query(`DELETE FROM zzsh_iam.admin_user_role WHERE role_id=$1`,[roleId]);
          await migrationPool.query(`DELETE FROM zzsh_iam.admin_role_permission WHERE role_id=$1`,[roleId]);
          await migrationPool.query(`DELETE FROM zzsh_iam.admin_role WHERE id=$1 AND code=$1`,[roleId]);
        }
      }
    });

    await t.test("D04b locked auth session is non-dispatchable; lock clears only its own presence", async () => {
      await presence(a); await presence(b, "OFF_DUTY");
      const reconnectVersion = (await readOwnPresence(options, contextA)).version;
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "RECONNECTING", version: reconnectVersion }, `req_${run}_reconnect`);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [], "a reconnecting agent is removed from dispatch immediately");
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.im_support_presence_session WHERE app_id=$1 AND admin_user_id=$2 AND ended_at IS NULL`, [appId, a])).rows[0].n, 1,
        "a short reconnect keeps the reception interval open");
      const reconnectedVersion = (await readOwnPresence(options, contextA)).version;
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: reconnectedVersion }, `req_${run}_reconnected`);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [a], "a recovered agent is dispatchable again");

      const owner = (await pool.query(`SELECT "auth_session_id" AS "sessionId" FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, a])).rows[0];
      assert.equal(owner.sessionId, contextA.sessionId, "presence is owned by the writing auth session");

      // The session gate is checked in dispatch, not only by a later rejected client request.
      await pool.query(`UPDATE zzsh_auth_admin."session" SET locked=true WHERE id=$1`, [contextA.sessionId]);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [], "a locked session cannot be dispatched even while its presence row still says CONNECTED");

      const cleared = await withTransaction(pool, (c) => clearSupportPresenceForSession(c, a, contextA.sessionId));
      assert.equal(cleared.presence, true);
      const afterLock = (await pool.query(`SELECT availability, connection_state AS "connectionState" FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, a])).rows[0];
      assert.deepEqual(afterLock, { availability: "OFF_DUTY", connectionState: "DISCONNECTED" });
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.im_support_presence_session WHERE app_id=$1 AND admin_user_id=$2 AND ended_at IS NULL`, [appId, a])).rows[0].n, 0);

      // A late lock callback from the old session must not clear a newer session's presence.
      await pool.query(`UPDATE zzsh_auth_admin."session" SET locked=false WHERE id=$1`, [contextA.sessionId]);
      const newSessionId = `${a}_session_2`;
      await pool.query(`INSERT INTO zzsh_auth_admin."session" ("id","expiresAt","token","createdAt","updatedAt","userId")
        VALUES ($1, clock_timestamp()+interval '1 hour', $2, clock_timestamp(), clock_timestamp(), $3)`,
        [newSessionId, `ensure_session_${run}_2`, a]);
      const contextNew = adminContext(a, newSessionId);
      const beforeNew = (await readOwnPresence(options, contextNew)).version;
      await updateOwnPresence(options, contextNew, { availability: "AVAILABLE", connectionState: "CONNECTED", version: beforeNew, takeover: true }, `req_${run}_new_session`);
      assert.deepEqual(await withTransaction(pool, (c) => clearSupportPresenceForSession(c, a, contextA.sessionId)), { presence: false, sessions: 0 });
      assert.equal((await pool.query(`SELECT availability FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, a])).rows[0].availability, "AVAILABLE");
      const current = (await readOwnPresence(options, contextNew)).version;
      // The real pause payload is OFF_DUTY + CONNECTED; it must not steal ownership
      // even when the stale window has read the current version.
      await assert.rejects(
        updateOwnPresence(options, contextA, { availability: "OFF_DUTY", connectionState: "CONNECTED", version: current }, `req_${run}_old_session_pause`),
        /owned by another session/,
      );
      await assert.rejects(
        updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: current }, `req_${run}_old_session_sync`),
        /owned by another session/,
      );
      assert.equal((await pool.query(`SELECT availability, "auth_session_id" AS "sessionId" FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, a])).rows[0].sessionId, contextNew.sessionId);
      const oldTakeover = await updateOwnPresence(options, contextA, {
        availability: "AVAILABLE", connectionState: "CONNECTED", version: current, takeover: true,
      }, `req_${run}_old_session_takeover`);
      assert.equal((await readOwnPresence(options, contextNew)).ownedByAnotherSession, true);
      await assert.rejects(
        updateOwnPresence(options, contextNew, { availability: "AVAILABLE", connectionState: "CONNECTED", version: oldTakeover.version }, `req_${run}_new_session_sync_after_old_takeover`),
        /owned by another session/,
      );
      await updateOwnPresence(options, contextNew, {
        availability: "AVAILABLE", connectionState: "CONNECTED", version: oldTakeover.version, takeover: true,
      }, `req_${run}_new_session_takeover_back`);

      // Stale presence recovers only after a fresh write from the owning session.
      await pool.query(`UPDATE zzsh_iam.im_support_presence SET last_connected_at=clock_timestamp()-interval '3 minutes' WHERE app_id=$1 AND admin_user_id=$2`, [appId, a]);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), []);
      const freshVersion = (await readOwnPresence(options, contextNew)).version;
      await updateOwnPresence(options, contextNew, { availability: "AVAILABLE", connectionState: "CONNECTED", version: freshVersion }, `req_${run}_fresh`);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [a], "fresh presence from a live session is dispatchable again");

      // Logout deletes the auth session; dispatch must stop without waiting for presence cleanup.
      await pool.query(`DELETE FROM zzsh_auth_admin."session" WHERE id=$1`, [newSessionId]);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [], "deleted auth session is not dispatchable");

      const restoreVersion = (await readOwnPresence(options, contextA)).version;
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: restoreVersion, takeover: true }, `req_${run}_restore_a`);
      await presence(b);
    });

    await t.test("D04c a takeover during lock cleanup leaves the new reception interval open", async () => {
      await presence(a); await presence(b, "OFF_DUTY");
      const newSessionId = `${a}_session_race`;
      await pool.query(`INSERT INTO zzsh_auth_admin."session" ("id","expiresAt","token","createdAt","updatedAt","userId")
        VALUES ($1, clock_timestamp()+interval '1 hour', $2, clock_timestamp(), clock_timestamp(), $3)`,
        [newSessionId, `ensure_session_${run}_race`, a]);
      const locker = await pool.connect();
      const cleaner = await pool.connect();
      let clear: Promise<{ presence: boolean; sessions: number }> | undefined;
      try {
        await locker.query("BEGIN");
        // The new session takes ownership but has not committed yet; the old
        // lock cleanup will wait on this same presence row.
        await locker.query(`UPDATE zzsh_iam.im_support_presence
          SET "auth_session_id"=$3, "version"="version"+1, "updated_at"=clock_timestamp()
          WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a, newSessionId]);
        await cleaner.query("BEGIN");
        clear = clearSupportPresenceForSession(cleaner, a, contextA.sessionId);
        let waiting = 0;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          waiting = (await ownerPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WITH updated AS%'`)).rows[0]?.n ?? 0;
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(waiting > 0, "the old cleanup actually waits on the presence row lock");
        await locker.query("COMMIT");
        assert.deepEqual(await clear, { presence: false, sessions: 0 }, "a failed old-session update must not close the new interval");
        await cleaner.query("COMMIT");
        assert.equal((await pool.query(`SELECT "auth_session_id" AS "sessionId" FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, a])).rows[0].sessionId, newSessionId);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.im_support_presence_session WHERE app_id=$1 AND admin_user_id=$2 AND ended_at IS NULL`, [appId, a])).rows[0].n, 1,
          "the winner's interval remains open");
        assert.deepEqual(await withTransaction(pool, async (c) => {
          const locked = await lockSupportMutation(c, appId);
          return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
        }), [a], "the new owner remains dispatchable");
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await cleaner.query("ROLLBACK").catch(() => undefined);
        locker.release();
        cleaner.release();
        await pool.query(`DELETE FROM zzsh_auth_admin."session" WHERE id=$1`, [newSessionId]).catch(() => undefined);
      }
      const restoreVersion = (await readOwnPresence(options, contextA)).version;
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: restoreVersion, takeover: true }, `req_${run}_restore_after_race`);
      await presence(b);
    });

    await t.test("D04d unbound legacy presence needs explicit start; a locked session cannot insert", async () => {
      await presence(a); await presence(b, "OFF_DUTY");
      await pool.query(`UPDATE zzsh_iam.im_support_presence
        SET "auth_session_id"=NULL, "availability"='AVAILABLE', "connection_state"='CONNECTED',
            "last_connected_at"=clock_timestamp(), "version"="version"+1
        WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a]);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [], "an unbound pre-0184 AVAILABLE row is not dispatchable");
      const unboundVersion = Number((await pool.query(`SELECT "version" FROM zzsh_iam.im_support_presence WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a])).rows[0].version);
      await assert.rejects(
        updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: unboundVersion }, `req_${run}_unbound_sync`),
        /unbound|explicit start/i,
      );
      assert.equal((await pool.query(`SELECT "auth_session_id" AS "sessionId" FROM zzsh_iam.im_support_presence WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a])).rows[0].sessionId, null);
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: unboundVersion, takeover: true }, `req_${run}_unbound_start`);
      assert.deepEqual(await withTransaction(pool, async (c) => {
        const locked = await lockSupportMutation(c, appId);
        return (await readEligibleSupport(c, appId, locked)).map((row) => row.adminUserId);
      }), [a], "an explicit start binds the old row again");

      // Even with no presence row, a locked session cannot insert one after the lock.
      await pool.query(`DELETE FROM zzsh_iam.im_support_presence WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a]);
      await pool.query(`UPDATE zzsh_auth_admin."session" SET locked=true WHERE id=$1`, [contextA.sessionId]);
      await assert.rejects(
        updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: 0, takeover: true }, `req_${run}_locked_insert`),
        /locked|not available/i,
      );
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.im_support_presence WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a])).rows[0].n, 0);
      await pool.query(`UPDATE zzsh_auth_admin."session" SET locked=false WHERE id=$1`, [contextA.sessionId]);
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: 0, takeover: true }, `req_${run}_restore_insert`);
      await presence(b);
    });

    await t.test("D04e a takeover that passed the plain session read is serialized by lockPin", async () => {
      await presence(a); await presence(b, "OFF_DUTY");
      const newSessionId = `${a}_session_lockrace2`;
      await pool.query(`INSERT INTO zzsh_auth_admin."session" ("id","expiresAt","token","createdAt","updatedAt","userId")
        VALUES ($1, clock_timestamp()+interval '1 hour', $2, clock_timestamp(), clock_timestamp(), $3)`,
        [newSessionId, `ensure_session_${run}_lockrace2`, a]);
      const contextNew = adminContext(a, newSessionId);
      const beforeNew = (await readOwnPresence(options, contextNew)).version;
      await updateOwnPresence(options, contextNew, { availability: "AVAILABLE", connectionState: "CONNECTED", version: beforeNew, takeover: true }, `req_${run}_lockrace_new_owner`);
      const contenderVersion = (await readOwnPresence(options, contextA)).version;

      const locker = await pool.connect();
      let takeover: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        await locker.query("BEGIN");
        // Hold A's session row unlocked. The takeover passes its earlier plain read,
        // then blocks on the dedicated FOR UPDATE in updateOwnPresence.
        await locker.query(`SELECT "id" FROM zzsh_auth_admin."session" WHERE "id"=$1 FOR UPDATE`, [contextA.sessionId]);
        takeover = updateOwnPresence(options, contextA, {
          availability: "AVAILABLE", connectionState: "CONNECTED", version: contenderVersion, takeover: true,
        }, `req_${run}_lockrace_takeover`).then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
        let waiting = 0;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          waiting = (await ownerPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%"locked" FROM "zzsh_auth_admin"."session"%'`)).rows[0]?.n ?? 0;
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(waiting > 0, "the takeover waits on the session row lock");
        await locker.query(`UPDATE zzsh_auth_admin."session" SET "locked"=true WHERE "id"=$1`, [contextA.sessionId]);
        assert.deepEqual(await clearSupportPresenceForSession(locker, a, contextA.sessionId), { presence: false, sessions: 0 });
        await locker.query("COMMIT");
        const result = await takeover;
        assert.equal(result.ok, false, "the takeover must not commit after the same session was locked");
        assert.match(String((result as { error?: { message?: string } }).error?.message ?? ""), /locked|not available/i);
        assert.equal((await pool.query(`SELECT "auth_session_id" AS "sessionId" FROM zzsh_iam.im_support_presence WHERE "app_id"=$1 AND "admin_user_id"=$2`, [appId, a])).rows[0].sessionId, newSessionId,
          "the other window keeps ownership");
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
        await pool.query(`UPDATE zzsh_auth_admin."session" SET locked=false WHERE id=$1`, [contextA.sessionId]).catch(() => undefined);
        await pool.query(`DELETE FROM zzsh_auth_admin."session" WHERE id=$1`, [newSessionId]).catch(() => undefined);
      }
      const restoreVersion = (await readOwnPresence(options, contextA)).version;
      await updateOwnPresence(options, contextA, { availability: "AVAILABLE", connectionState: "CONNECTED", version: restoreVersion, takeover: true }, `req_${run}_restore_after_lockrace`);
      await presence(b);
    });

    await t.test("D05 priority before create/claim, batch limit, and cross-App isolation", async () => {
      const items=[];for(let i=0;i<11;i++)items.push(await paid(`订单优先${i}`));
      const u=await user();
      const beforeA=await stats(a),beforeB=await stats(b);
      const waiting=await createOrResumeUserConsultation(options,u,"SERVICE",null,`req_${run}_priority`);
      assert.equal(waiting.consultation.state,"WAITING");
      assert.equal((await group(items[9]!.orderId)).provision_state,"ASSIGNED");
      assert.equal((await group(items[10]!.orderId)).provision_state,"WAITING");
      assert.equal((await stats(a)).last_consultation_assigned_at,beforeA.last_consultation_assigned_at);
      assert.equal((await stats(b)).last_consultation_assigned_at,beforeB.last_consultation_assigned_at);
      const claimed=await claimConsultation(options,contextA,waiting.consultation.id,`req_${run}_claim`);
      assert.equal(claimed.consultation.assignedAdmin?.id,a);
      assert.equal((await group(items[10]!.orderId)).provision_state,"ASSIGNED");
      const beforeTransfer=await paid("指定转交仍订单优先");
      provider.afterAdd=async()=>{assert.equal((await group(beforeTransfer.orderId)).provision_state,"ASSIGNED","order assignment commits before consultation provider transfer");};
      await transferConsultation(options,contextA,waiting.consultation.id,b,`req_${run}_priority_transfer`);
      const assignedAt=(await stats(a)).last_consultation_assigned_at;
      const later=await paid("咨询先提交不追溯");await dispatchPaidOrders(pool,appId);
      assert.equal((await stats(a)).last_consultation_assigned_at,assignedAt);
      const other=`${appId}_other`;
      const otherOrder=await paid("跨App",other);
      await seedIdentity(pool,key("ADMIN",a,other),run);
      await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at,auth_session_id) VALUES($1,$2,'AVAILABLE','CONNECTED',clock_timestamp(),$3)`,[other,a,contextA.sessionId]);
      const blocker=await pool.connect();
      try {await blocker.query("BEGIN");await lockSupportMutation(blocker,appId);
        assert.deepEqual((await dispatchPaidOrders(pool,other)).assigned,[otherOrder.orderId]);
      } finally {await blocker.query("ROLLBACK");blocker.release();}
      assert.equal((await group(later.orderId)).provision_state,"ASSIGNED");
    });

    await t.test("D06 close/transfer/recovery share gate and ordered staff locks; heartbeats survive", async () => {
      const db=o.config.database;
      const small=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:2,connectionTimeoutMillis:2000,application_name:"dispatch-small"});
      const smallOptions={...options,pool:small};
      const u=await user();
      const created=await createOrResumeUserConsultation(smallOptions,u,"SERVICE",null,`req_${run}_close`);
      const current=created.consultation.assignedAdmin!.id===a?contextA:contextB;
      const target=current.userId===a?contextB:contextA;
      const gate=await pool.connect();
      let operation: Promise<unknown>|undefined;
      let releaseRemote=deferred();
      try {
        let remoteReached=deferred();
        provider.afterAdd=async()=>{remoteReached.resolve();await releaseRemote.promise;};
        operation=transferConsultation(smallOptions,current,created.consultation.id,target.userId,`req_${run}_transfer`);
        await remoteReached.promise;
        await gate.query("BEGIN");await lockSupportMutation(gate,appId);releaseRemote.resolve();
        await waitLock("dispatch-small");await gate.query("COMMIT");await operation;
        assert.ok((await stats(target.userId)).active_load>3,"consultation transfers also have no old capacity limit");
        remoteReached=deferred();releaseRemote=deferred();
        const dismiss=provider.dismissSupportTeam.bind(provider);
        provider.dismissSupportTeam=async(...args)=>{await dismiss(...args);remoteReached.resolve();await releaseRemote.promise;};
        operation=closeConsultation(smallOptions,target,created.consultation.id,`req_${run}_remote_close`);
        await remoteReached.promise;
        await gate.query("BEGIN");await lockSupportMutation(gate,appId);
        releaseRemote.resolve();
        await waitLock("dispatch-small");await gate.query("COMMIT");await operation;
        provider.dismissSupportTeam=dismiss;
        managerReady=false;
        const recoveringUser=await user();
        await assert.rejects(createOrResumeUserConsultation(smallOptions,recoveringUser,"SERVICE",null,`req_${run}_recover`),{status:503});
        const recovering=(await pool.query(`SELECT id FROM zzsh_iam.im_consultation WHERE app_id=$1 AND user_id=$2`,[appId,recoveringUser.userId])).rows[0];
        managerReady=true;
        await pool.query(`UPDATE zzsh_iam.im_consultation_scope_operation SET next_retry_at=clock_timestamp() WHERE consultation_id=$1 AND last_failure_class='IDENTITY_PENDING'`,[recovering.id]);
        await gate.query("BEGIN");await lockSupportMutation(gate,appId);
        operation=reconcileMessageScopes(smallOptions);await waitLock("dispatch-small");await gate.query("COMMIT");await operation;
        assert.equal((await pool.query(`SELECT message_scope_state FROM zzsh_iam.im_consultation WHERE id=$1`,[recovering.id])).rows[0].message_scope_state,"READY");
        const localUser=await user();
        const localId=`im_local_${run}`;
        await pool.query(`INSERT INTO zzsh_iam.im_consultation(id,app_id,user_id,kind,state,user_account_id,peer_account_id,assigned_admin_id)
          VALUES($1,$2,$3,'SERVICE','ACTIVE',$4,$5,$6)`,[localId,appId,localUser.userId,deriveYunxinAccountId(key("USER",localUser.userId)),deriveYunxinAccountId(key("ADMIN",a)),a]);
        await pool.query(`UPDATE zzsh_iam.im_support_presence SET active_load=active_load+1 WHERE app_id=$1 AND admin_user_id=$2`,[appId,a]);
        const oldVersion=(await stats(a)).version;
        await closeConsultation({pool:small,appId},contextA,localId,`req_${run}_localclose`);
        assert.deepEqual((await pool.query(`SELECT state,message_scope_state,message_scope_id FROM zzsh_iam.im_consultation WHERE id=$1`,[localId])).rows[0],
          {state:"CLOSED",message_scope_state:"PENDING",message_scope_id:null},"local-only close does not claim a remote revocation");
        assert.equal((await stats(a)).version,oldVersion);
        await presence(a);
        await assert.rejects(updateOwnPresence(options,contextA,{availability:"OFF_DUTY",connectionState:"DISCONNECTED",version:Number(oldVersion)},`req_${run}_stale`),/stale/);
      } finally {releaseRemote.resolve();managerReady=true;await gate.query("ROLLBACK");gate.release();if(operation)await operation.catch(()=>undefined);await small.end();}
    });

    await t.test("D07 audit rollback, immutable binding and least privilege", async () => {
      const f=await paid("派单审计失败");const before=await stats(a),beforeB=await stats(b);
      await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.config.database.user}"`);
      try {await assert.rejects(dispatchPaidOrders(pool,appId),{code:"42501"});
        assert.equal((await group(f.orderId)).provision_state,"WAITING");assert.deepEqual(await stats(a),before);assert.deepEqual(await stats(b),beforeB);
      } finally {await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.config.database.user}"`);}
      await dispatchPaidOrders(pool,appId);
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_group SET app_id='wrong' WHERE order_id=$1`,[f.orderId]),{code:"42501"});
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_group SET assigned_admin_id=NULL,version=version+1 WHERE order_id=$1`,[f.orderId]),{code:"40001"});
      const privileges=(await pool.query(`SELECT has_column_privilege(current_user,'zzsh_order.im_order_group','assigned_admin_id','UPDATE') AS assignment,
        has_column_privilege(current_user,'zzsh_order.im_order_group','payment_confirmation_id','UPDATE') AS binding,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='zzsh_iam' AND table_name='im_support_presence' AND column_name='capacity') AS capacity`)).rows[0];
      assert.deepEqual(privileges,{assignment:true,binding:false,capacity:false});
    });

    await t.test("D08 explicit worker/default-off, presence wake, no overlap and real Nest shutdown", async () => {
      await presence(a,"OFF_DUTY");await presence(b,"OFF_DUTY");
      const f=await paid("调度恢复");
      const db=o.config.database;
      const workerPool=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:2,connectionTimeoutMillis:2000,application_name:"dispatch-worker"});
      const app=await createApp({health:{dependencies:{postgres:{check:async()=>undefined,close:async()=>undefined},redis:{check:async()=>undefined,close:async()=>undefined}}},database:{pool:workerPool}});
      await app.init();
      const lifecycle=app.get(OrderDispatchLifecycle);lifecycle.wake();
      assert.equal(workerPool.totalCount,0,"default-off does not borrow a DB connection");
      let completed=deferred();let runs=0;
      lifecycle.start({pool:workerPool,appId,batchLimit:2,intervalMs:100000,onResult:()=>{runs++;completed.resolve();},onFailure:(code)=>{throw new Error(code);}});
      await completed.promise;assert.equal((await group(f.orderId)).provision_state,"WAITING");
      completed=deferred();await presence(a,"AVAILABLE",()=>lifecycle.wake());await completed.promise;
      assert.equal((await group(f.orderId)).provision_state,"ASSIGNED");
      const gate=await pool.connect();let closing:Promise<void>|undefined;
      try {
        await gate.query("BEGIN");await gate.query(`SELECT pg_advisory_xact_lock($1::bigint)`,[orderDispatchLockKey(appId)]);
        const count=runs;lifecycle.wake();lifecycle.wake();lifecycle.wake();await waitLock("dispatch-worker");
        app.get(MessageScopeRecoveryLifecycle).start({...options,pool:workerPool},1);
        await waitLock("dispatch-worker",2);
        let ended=false;const originalEnd=workerPool.end.bind(workerPool);workerPool.end=(async()=>{ended=true;return originalEnd();}) as typeof workerPool.end;
        closing=app.close();await new Promise<void>((r)=>setImmediate(r));assert.equal(ended,false,"pool cannot end before the dispatch transaction settles");
        await gate.query("COMMIT");await closing;assert.equal(runs,count+1,"wake bursts do not overlap");assert.equal(ended,true);
        lifecycle.wake();assert.equal(runs,count+1,"stopped lifecycle stays stopped");
      } finally {await gate.query("ROLLBACK");gate.release();if(closing)await closing;else await app.close();}
      assert.equal(workerPool.totalCount,0);
    });
    await t.test("R1 new presence is excluded from the locked roster for both dispatch kinds", async () => {
      for (const change of ["read", "accept", "freeze", "offline"] as const) {
        const raceApp=`r1_${change}_${run}`, id=`r1_${change}_${run}`;
        await seedAdmin(pool,id,`${id}_s`,run,false);
        await seedIdentity(pool,key("ADMIN",id,raceApp),run);
        for(const permission of permissions) await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,$2,'ALLOW')`,[id,permission]);
        await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`,[id,gameId]);
        const f=await paid(`首次presence-${change}`,raceApp);
        const c=await pool.connect();
        try {
          await c.query("BEGIN");
          const locked=await lockSupportMutation(c,raceApp);
          assert.deepEqual(locked.ids,[]);
          const ctx=adminContext(id,`${id}_s`);
          const online=await updateOwnPresence({pool,appId:raceApp},ctx,{availability:"AVAILABLE",connectionState:"CONNECTED",version:0},`req_${id}`);
          const staff=await readEligibleSupport(c,raceApp,locked);
          assert.deepEqual(staff,[],"first presence after locking is not part of this transaction's candidates");
          await withTransaction(pool,async(writer)=>{
            await writer.query(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id=$1 FOR UPDATE NOWAIT`,[id]);
            if(change==="read"||change==="accept") await writer.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code=$2`,[id,`im.support.${change}`]);
            if(change==="freeze") await writer.query(`UPDATE zzsh_iam.admin_security SET status='FROZEN' WHERE admin_user_id=$1`,[id]);
          });
          if(change==="offline") await updateOwnPresence({pool,appId:raceApp},ctx,{availability:"OFF_DUTY",connectionState:"DISCONNECTED",version:online.version},`req_off_${id}`);
          assert.deepEqual((await assignWaitingOrders(c,raceApp,staff)).assigned,[]);
          assert.equal(await reserveSupportCandidate(c,raceApp,"SERVICE",staff),null);
          await c.query("COMMIT");
          assert.equal((await group(f.orderId)).assigned_admin_id,null);
          assert.deepEqual((await dispatchPaidOrders(pool,raceApp)).assigned,[],"next scan still respects committed disqualification");
        } finally {await c.query("ROLLBACK");c.release();}
      }
      // Public consultation entry: insert a first presence exactly before its
      // eligible query, after lockSupportMutation has completed with no staff.
      const raceApp=`r1_consult_${run}`,id=`r1_consult_${run}`,uid=`r1_user_${run}`;
      await seedAdmin(pool,id,`${id}_s`,run,false);await seedIdentity(pool,key("ADMIN",id,raceApp),run);
      for(const permission of permissions) await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,$2,'ALLOW')`,[id,permission]);
      await seedUser(pool,uid,`${uid}_s`,run);await seedIdentity(pool,key("USER",uid,raceApp),run);
      const db=o.config.database;
      const scoped=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:1,connectionTimeoutMillis:2000});
      const connect=scoped.connect.bind(scoped);let inserted=false;
      scoped.connect=(async()=>{const c=await connect();const query=c.query.bind(c);
        c.query=(async(sql:string,params:unknown[])=>{
          if(!inserted&&sql.includes('SELECT p.admin_user_id AS')){inserted=true;await updateOwnPresence({pool,appId:raceApp},adminContext(id,`${id}_s`),{availability:"AVAILABLE",connectionState:"CONNECTED",version:0},`req_${id}`);}
          return query(sql,params);
        }) as typeof c.query;return c;}) as typeof scoped.connect;
      try {
        const waiting=await createOrResumeUserConsultation({pool:scoped,appId:raceApp},userContext(uid,`${uid}_s`),"SERVICE",null,`req_${uid}`);
        assert.equal(inserted,true);assert.equal(waiting.consultation.state,"WAITING");
        await withTransaction(pool,async(c)=>{const locked=await lockSupportMutation(c,raceApp);assert.deepEqual((await readEligibleSupport(c,raceApp,locked)).map(s=>s.adminUserId),[id],"new staff is eligible only in the next fully locked round");});
      } finally {await scoped.end();}
    });

    await t.test("R2 callback exceptions cannot retry committed assignment or prevent later dispatch", async () => {
      const f=await paid("观察回调提交后抛错");
      const worker=new OrderDispatchLifecycle();
      const logs:string[]=[];
      (worker as unknown as {logger:{error:(value:string)=>void}}).logger.error=(value)=>{logs.push(value);};
      let seen=deferred(),failures=0;
      const cfg={pool,appId,batchLimit:10,intervalMs:100000};
      try {
        worker.start({...cfg,onResult:()=>{seen.resolve();throw new Error("private-result");},onFailure:()=>{failures++;}});
        await seen.promise;await worker.beforeApplicationShutdown();
        const committed=await group(f.orderId),clock=await stats(committed.assigned_admin_id);
        assert.equal(committed.provision_state,"ASSIGNED");assert.equal(failures,0);
        seen=deferred();worker.start({...cfg,onResult:()=>seen.resolve()});await seen.promise;await worker.beforeApplicationShutdown();
        assert.deepEqual(await group(f.orderId),committed);assert.deepEqual(await stats(committed.assigned_admin_id),clock);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='im.order.assigned' AND object_id=$1`,[f.orderId])).rows[0].n,1);
        const next=await paid("观察失败回调抛错");
        await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.config.database.user}"`);
        try {
          seen=deferred();worker.start({...cfg,onFailure:(code)=>{assert.equal(code,"DISPATCH_FAILED");seen.resolve();throw new Error("private-failure");}});
          await seen.promise;await worker.beforeApplicationShutdown();assert.equal((await group(next.orderId)).provision_state,"WAITING");
        } finally {await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.config.database.user}"`);}
        seen=deferred();worker.start({...cfg,onResult:()=>seen.resolve()});await seen.promise;await worker.beforeApplicationShutdown();
        assert.equal((await group(next.orderId)).provision_state,"ASSIGNED");
        assert.deepEqual(logs.map(l=>JSON.parse(l).kind),["RESULT","FAILURE"]);assert.doesNotMatch(logs.join(""),/private-/);
      } finally {await worker.beforeApplicationShutdown();}
    });
    assert.equal((await ownerPool.query(`SELECT deadlocks::text FROM pg_stat_database WHERE datname=current_database()`)).rows[0].deadlocks,deadlocksBefore);
    assert.equal(externalRequests,0);
    console.log("dispatch acceptance",JSON.stringify({externalRequests,deadlocksDelta:0}));
  } finally {globalThis.fetch=nativeFetch;}
}
