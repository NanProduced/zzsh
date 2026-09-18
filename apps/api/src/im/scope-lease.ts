import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type ScopeLease = {
  assertValid(): Promise<void>;
  mutate<T>(scope: string, action: (client: PoolClient) => Promise<T>): Promise<T>;
  stop(): Promise<void>;
};
const transactions = new WeakSet<PoolClient>();

/** One borrowed connection owns the remote mutex, renewal and callback writes.
 * This is a local mutex, NOT fencing of an already submitted provider request.
 */
export function createImScopeLease(pool: Pool, appId: string,
  renew: (db: Pool | PoolClient) => Promise<boolean>, failure: () => Error, intervalMs = 5_000): ScopeLease {
  let stopped = false, borrowing = false;
  let lost: Error | undefined, active: PoolClient | undefined, heartbeat: Promise<void> | undefined;
  const check = async (db: Pool | PoolClient): Promise<void> => {
    if (lost || stopped) throw lost ?? failure();
    try { if (!await renew(db)) throw failure(); }
    catch (error) { lost = error instanceof Error ? error : failure(); throw lost; }
  };
  const timer = setInterval(() => {
    // Renewal must not acquire an operation lock inside the callback's ordered
    // transaction before that callback has obtained the App/participant locks.
    if (stopped || heartbeat || borrowing || (active && transactions.has(active))) return;
    const work = check(active ?? pool).catch(() => undefined);
    heartbeat = work;
    void work.then(() => { if (heartbeat === work) heartbeat = undefined; });
  }, intervalMs);
  timer.unref?.();
  return {
    async assertValid() { if (heartbeat) await heartbeat; await check(active ?? pool); },
    async mutate<T>(scope: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
      if (active || borrowing) throw new Error("Nested remote mutex is forbidden");
      borrowing = true;
      if (heartbeat) await heartbeat;
      let client: PoolClient | undefined, locked = false, destroy: Error | undefined;
      const key = BigInt(`0x${createHash("sha256").update(`zzsh:im-scope:${appId}:${scope}`).digest("hex").slice(0, 15)}`).toString();
      try {
        client = await pool.connect(); active = client; borrowing = false;
        await client.query(`SET lock_timeout='750ms'`);
        await client.query(`SELECT pg_advisory_lock($1::bigint)`, [key]); locked = true;
        await check(client);
        const result = await action(client);
        if (heartbeat) await heartbeat;
        await check(client);
        return result;
      } finally {
        borrowing = true;
        if (heartbeat) await heartbeat;
        if (client) {
          try {
            if (locked) await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [key]);
            await client.query(`RESET lock_timeout`);
          } catch { destroy = failure(); lost = destroy; }
          active = undefined; client.release(destroy);
        }
        borrowing = false;
        if (destroy) throw destroy;
      }
    },
    async stop() { stopped = true; clearInterval(timer); if (heartbeat) await heartbeat; },
  };
}

export async function onLeaseConnection<T>(client: PoolClient, action: (client: PoolClient) => Promise<T>): Promise<T> {
  transactions.add(client);
  try {
    await client.query("BEGIN");
    try { const result = await action(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
  } finally { transactions.delete(client); }
}

/** Binding locks never span network I/O. Both business kinds acquire App gate first. */
export async function lockTeamBinding(client: PoolClient, appId: string, teamId: string): Promise<void> {
  const key = BigInt(`0x${createHash("sha256").update(`zzsh:im-team-binding:${appId}:${teamId}`).digest("hex").slice(0, 15)}`).toString();
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [key]);
}
