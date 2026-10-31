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
class DistributionDueService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private locking: PoolClient | null = null;
  private running = false;
  private halted = false;
  private pendingRequestId: string | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(@Inject('DISTRIBUTION_DUE_OPTIONS') private readonly options: DistributionDueModuleOptions) {}
  async onModuleInit(): Promise<void> {
    const client = await this.options.pool.connect();
    const acquired = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [LOCK_KEY])).rows[0]?.acquired === true;
    if (!acquired) { client.release(); return; }
    this.locking = client;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    if (this.running || this.halted) return;
    this.running = true;
    const requestId = this.pendingRequestId ?? `due_${this.options.workerId}_${Date.now()}`;
    const operator: MaintenanceOperator = { userId: `distribution-due-${this.options.workerId}`, sessionId: 'system', system: true, authorize: async () => {} };
    this.inFlight = (async () => {
      try {
        const result = await this.options.store.runDueBatch(this.options.pool, { limit: this.options.batchLimit, requestId, operator });
        if (result.batch.state === 'UNKNOWN') { this.pendingRequestId = requestId; this.halted = true; console.error(JSON.stringify({ event: 'distribution.due.unknown', requestId, notAttempted: result.batch.notAttempted })); return; }
        this.pendingRequestId = null;
        if (result.batch.state === 'COMPLETE' && result.batch.results.length) console.log(JSON.stringify({ event: 'distribution.due.complete', requestId, attempted: result.batch.results.length }));
      } catch (error) { console.error(JSON.stringify({ event: 'distribution.due.failed', requestId, reason: error instanceof Error ? error.message : String(error) })); }
      finally { this.running = false; }
    })();
    await this.inFlight;
  }
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (this.locking) { await this.locking.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {}); this.locking.release(); this.locking = null; }
  }
}
@Module({})
export class DistributionDueModule {
  static register(options: DistributionDueModuleOptions): DynamicModule {
    return { module: DistributionDueModule, providers: [{ provide: 'DISTRIBUTION_DUE_OPTIONS', useValue: options }, DistributionDueService] };
  }
}
