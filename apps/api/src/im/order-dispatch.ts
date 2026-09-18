import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { lockSupportMutation, readEligibleSupport, reserveSupportCandidate, type SupportCandidate } from "./support-dispatch";

export type DispatchResult = { assigned: string[]; more: boolean };

/** The locked roster filters non-dispatchable games BEFORE the batch limit. */
async function pendingOrders(client: PoolClient, appId: string, staff: SupportCandidate[], limit: number) {
  return (await client.query<{ id: string; account_id: string; game_id: string }>(`SELECT o.id,o.account_id,o.game_id
    FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
    JOIN zzsh_order.payment_confirmation p ON p.id=g.payment_confirmation_id
    WHERE g.app_id=$1 AND g.provision_state='WAITING' AND o.status='PAID'
      AND ($2::boolean OR o.game_id=ANY($3::text[]))
    ORDER BY p.accepted_at,o.id LIMIT $4`, [appId, staff.some((c) => c.allGames), [...new Set(staff.flatMap((c) => c.gameIds))], limit])).rows;
}

/** Caller already holds the App gate and qualification/presence locks. */
export async function assignWaitingOrders(client: PoolClient, appId: string, staff: SupportCandidate[], limit = 10): Promise<DispatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid dispatch batch limit");
  const pending = await pendingOrders(client, appId, staff, limit + 1);
  const assigned: string[] = [];
  for (const order of pending.slice(0, limit)) {
    await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [order.account_id]);
    const current = (await client.query(`SELECT status FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE`, [order.id])).rows[0];
    const group = (await client.query(`SELECT provision_state FROM zzsh_order.im_order_group WHERE order_id=$1 AND app_id=$2 FOR UPDATE`, [order.id, appId])).rows[0];
    if (current?.status !== "PAID" || group?.provision_state !== "WAITING") continue;
    const candidate = await reserveSupportCandidate(client, appId, "ORDER", staff.filter((s) => s.allGames || s.gameIds.includes(order.game_id)));
    if (!candidate) break; // TTL can expire inside a batch; never manufacture an assignee.
    await client.query(`UPDATE zzsh_order.im_order_group SET provision_state='ASSIGNED',assigned_admin_id=$2,
      assigned_at=clock_timestamp(),wait_reason=NULL,version=version+1 WHERE order_id=$1`, [order.id, candidate.adminUserId]);
    await recordAudit(client, { actorType: "system", action: "im.order.assigned", objectType: "rental_order", objectId: order.id,
      outcome: "SUCCESS", requestId: `dispatch_${order.id}`, details: { appId, assignedAdminId: candidate.adminUserId, teamReady: false } });
    assigned.push(order.id);
  }
  // A durable, bounded supervisor-pending fact; no notification platform or repeated audit spam.
  await client.query(`UPDATE zzsh_order.im_order_group SET wait_reason='NO_ELIGIBLE_STAFF',version=version+1
    WHERE order_id IN (SELECT g.order_id FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
      WHERE g.app_id=$1 AND g.provision_state='WAITING' AND g.wait_reason IS NULL
        AND NOT ($2::boolean OR o.game_id=ANY($3::text[])) ORDER BY g.created_at,g.order_id LIMIT $4)`,
  [appId, staff.some((c) => c.allGames), [...new Set(staff.flatMap((c) => c.gameIds))], limit]);
  return { assigned, more: (await pendingOrders(client, appId, staff, 1)).length > 0 };
}

export async function dispatchPaidOrders(pool: Pool, appId: string, batchLimit = 10): Promise<DispatchResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(appId)) throw new Error("Invalid dispatch App");
  return withTransaction(pool, async (client) => {
    const locked = await lockSupportMutation(client, appId);
    return assignWaitingOrders(client, appId, await readEligibleSupport(client, appId, locked), batchLimit);
  });
}

export type OrderDispatchOptions = { pool: Pool; appId: string; batchLimit: number; intervalMs: number;
  onResult?: (result: DispatchResult) => void; onFailure?: (code: string) => void };

@Injectable()
export class OrderDispatchLifecycle implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OrderDispatchLifecycle.name);
  private options?: OrderDispatchOptions;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  start(options: OrderDispatchOptions): void {
    if (this.options) throw new Error("Order dispatcher already started");
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || !Number.isSafeInteger(options.batchLimit)
      || options.batchLimit < 1 || options.batchLimit > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.appId)) throw new Error("Invalid order dispatch configuration");
    this.options = options;
    this.timer = setInterval(() => this.wake(), options.intervalMs);
    this.timer.unref?.();
    this.wake();
  }
  wake(): void {
    if (!this.options || this.inFlight) return;
    const options = this.options;
    const work = dispatchPaidOrders(options.pool, options.appId, options.batchLimit).then((result) => this.observe("RESULT", () => options.onResult?.(result)), (error: unknown) => {
      const raw = (error as { code?: string } | null)?.code;
      const code = raw === "55P03" ? "LOCK_BUSY" : raw === "40P01" ? "DEADLOCK" : "DISPATCH_FAILED";
      if (options.onFailure) return this.observe("FAILURE", () => options.onFailure!(code));
      else this.logger.error(JSON.stringify({ event: "im.order.dispatch.failed", code }));
    });
    const clear = () => { if (this.inFlight === settled) this.inFlight = undefined; };
    const settled = work.then(clear, clear);
    this.inFlight = settled;
  }
  private async observe(kind: "RESULT" | "FAILURE", callback: () => unknown): Promise<void> {
    try { await callback(); }
    catch { this.logger.error(JSON.stringify({ event: "im.order.dispatch.observer_failed", kind })); }
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.options = undefined;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }
}
