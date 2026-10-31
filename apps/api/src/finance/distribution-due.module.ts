import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ConfigurationError } from '../config/config';
import type { DistributionEarningStore, MaintenanceOperator } from './distribution-earning-store';

export type DistributionDueModuleOptions = { pool: Pool; store: DistributionEarningStore; intervalMs: number; batchLimit: number; workerId: string };
const LOCK_KEY = '806007';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function loadDistributionDueRuntime(pool: Pool | undefined, store: DistributionEarningStore | undefined, env: NodeJS.ProcessEnv = process.env): DistributionDueModuleOptions | undefined {
  const enabled = env.DISTRIBUTION_DUE_WORKER_ENABLED?.trim() ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new ConfigurationError('DISTRIBUTION_DUE_WORKER_ENABLED must be true or false');
  if (enabled === 'false') return undefined;
  if (!pool || !store) throw new ConfigurationError('DISTRIBUTION_DUE_WORKER_ENABLED=true requires explicit NATIVE distribution assembly');
  const intervalMs = Number(env.DISTRIBUTION_DUE_INTERVAL_MS ?? '300000'), batchLimit = Number(env.DISTRIBUTION_DUE_BATCH_LIMIT ?? '20');
  const workerId = env.DISTRIBUTION_DUE_WORKER_ID?.trim() ?? 'main';
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000 || intervalMs > 3600000) throw new ConfigurationError('DISTRIBUTION_DUE_INTERVAL_MS must be 60000-3600000');
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new ConfigurationError('DISTRIBUTION_DUE_BATCH_LIMIT must be 1-100');
  if (!ID.test(workerId)) throw new ConfigurationError('DISTRIBUTION_DUE_WORKER_ID must be a bounded identifier');
  return { pool, store, intervalMs, batchLimit, workerId };
}
@Injectable()
export class DistributionDueService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private locking: PoolClient | null = null;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | null = null;
  constructor(@Inject('DISTRIBUTION_DUE_OPTIONS') private readonly options: DistributionDueModuleOptions) {}
  private get operator(): MaintenanceOperator {
    return { userId: `distribution-due-${this.options.workerId}`, sessionId: 'system', system: true, authorize: async () => {} };
  }
  async onModuleInit(): Promise<void> {
    // The timer always runs: an instance that lost the lock has to be able to take over later.
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }
  /** Advisory locks die with their session, so the live session holding this exact key is the only execution right.
   *  pg_locks exposes an int8 advisory key as classid=high 32 bits, objobjid=low 32 bits, objsubid=2. */
  private async ensureLock(): Promise<PoolClient | null> {
    if (this.locking) {
      try {
        const held = await this.locking.query(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objsubid=2
          AND classid=(($1::bigint >> 32) & 4294967295)::int AND objobjid=($1::bigint & 4294967295)::int`, [LOCK_KEY]);
        if (Number(held.rows[0]?.held ?? 0) > 0) return this.locking;
      } catch { /* the session is gone */ }
      console.error(JSON.stringify({ event: 'distribution.due.lock.lost', reason: 'the driving session no longer holds 806007' }));
      await this.releaseLock();
      return null;
    }
    const client = await this.options.pool.connect();
    try {
      const acquired = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [LOCK_KEY])).rows[0]?.acquired === true;
      if (!acquired) { client.release(); return null; }
      client.once('error', () => { if (this.locking === client) this.locking = null; });
      client.once('end', () => { if (this.locking === client) this.locking = null; });
      this.locking = client;
      return client;
    } catch { client.release(); return null; }
  }
  private async releaseLock(): Promise<void> {
    const client = this.locking;
    this.locking = null;
    if (!client) return;
    try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]); } catch { /* the session already dropped the lock */ }
    try { client.release(); } catch { /* destroyed sessions release themselves */ }
  }
  /** One drive cycle: holding the session lock is the only execution right, and an unfinished original batch always wins. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        const client = await this.ensureLock();
        if (!client) return;
        const operator = this.operator;
        const unfinished = await this.options.store.findUnfinishedBatch(this.options.pool, { operator, client });
        const result = unfinished
          ? await this.options.store.resumeBatch(this.options.pool, { requestId: unfinished.requestId, operator, client })
          : await this.options.store.runDueBatch(this.options.pool, { limit: this.options.batchLimit, requestId: `due_${this.options.workerId}_${Date.now()}`, operator, client });
        if (result.batch.state === 'UNKNOWN') console.error(JSON.stringify({ event: 'distribution.due.unknown', requestId: result.batch.requestId, notAttempted: result.batch.notAttempted, recovery: 'RESUME_ORIGINAL_KEY' }));
        else if (result.batch.state === 'COMPLETE' && result.batch.results.length && !unfinished) console.log(JSON.stringify({ event: 'distribution.due.complete', requestId: result.batch.requestId, attempted: result.batch.results.length }));
      } catch (error) {
        // An exception may sit after the money commit, so the key is never replaced here; the next tick resumes it.
        console.error(JSON.stringify({ event: 'distribution.due.failed', reason: error instanceof Error ? error.message : String(error), recovery: 'RESUME_ORIGINAL_KEY' }));
        if (this.stopping) await this.releaseLock();
      } finally { this.running = false; }
    })();
    await this.inFlight;
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.releaseLock();
  }
}
@Module({})
export class DistributionDueModule {
  static register(options: DistributionDueModuleOptions): DynamicModule {
    return { module: DistributionDueModule, providers: [{ provide: 'DISTRIBUTION_DUE_OPTIONS', useValue: options }, DistributionDueService] };
  }
}
