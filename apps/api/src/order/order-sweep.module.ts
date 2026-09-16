import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { ConfigurationError } from "../config/config";
import { OrderSweepWorker, type SweepResult } from "./order";

export type OrderSweepModuleOptions = {
  pool: Pool;
  intervalMs: number;
  batchLimit: number;
  lockTimeoutMs: number;
  scanLimit?: number;
  onResult?: (result: SweepResult) => void;
  onError?: (error: unknown) => void;
};

const ORDER_SWEEP_OPTIONS = Symbol("ORDER_SWEEP_OPTIONS");

/**
 * Minimal default observability for the standard assembly: incomplete batches
 * and batch-level failures are logged as bounded structured events (order ids
 * and counts only — never snapshots, bodies or secrets).
 */
function defaultOnResult(result: SweepResult): void {
  if (result.failed.length > 0 || result.skippedLocked.length > 0 || result.skippedChanged.length > 0) {
    console.error(JSON.stringify({
      event: "order.sweep.incomplete",
      candidates: result.candidates,
      cancelled: result.cancelled.length,
      skippedLocked: result.skippedLocked.length,
      skippedChanged: result.skippedChanged.length,
      failedIds: result.failed,
    }));
  }
}

function defaultOnError(error: unknown): void {
  console.error(JSON.stringify({
    event: "order.sweep.failed",
    message: error instanceof Error ? error.message : String(error),
  }));
}

function validateOrderSweepOptions(options: OrderSweepModuleOptions): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new ConfigurationError("order sweep intervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit <= 0) {
    throw new ConfigurationError("order sweep batchLimit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
    throw new ConfigurationError("order sweep lockTimeoutMs must be a positive integer");
  }
  if (options.scanLimit !== undefined && (!Number.isSafeInteger(options.scanLimit) || options.scanLimit < options.batchLimit)) {
    throw new ConfigurationError("order sweep scanLimit must be an integer >= batchLimit");
  }
}

@Injectable()
class OrderSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly worker: OrderSweepWorker;

  constructor(@Inject(ORDER_SWEEP_OPTIONS) options: OrderSweepModuleOptions) {
    this.worker = new OrderSweepWorker(options.pool, {
      intervalMs: options.intervalMs,
      batchLimit: options.batchLimit,
      lockTimeoutMs: options.lockTimeoutMs,
      ...(options.scanLimit !== undefined ? { scanLimit: options.scanLimit } : {}),
      onResult: options.onResult ?? defaultOnResult,
      onError: options.onError ?? defaultOnError,
    });
  }

  onModuleInit(): void {
    this.worker.start();
  }

  // Registered after BusinessDatabaseModule, so this hook fires before the
  // business pool is ended (Nest invokes shutdown hooks in reverse order).
  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

/**
 * In-process expired-hold sweeper, started only from an explicit, validated
 * configuration object. There is no environment-variable fallback: isolated
 * test/fake apps never start a worker unless they ask for one.
 */
@Module({})
export class OrderSweepModule {
  static register(options: OrderSweepModuleOptions): DynamicModule {
    validateOrderSweepOptions(options);
    return {
      module: OrderSweepModule,
      providers: [{ provide: ORDER_SWEEP_OPTIONS, useValue: options }, OrderSweepService],
    };
  }
}
