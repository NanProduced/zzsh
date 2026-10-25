import { randomUUID } from "node:crypto";
import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import { assertJoinpayAccountReadProfile, JoinpayAccountError, type AccountQueryDependencies, type BoundJoinpayAccountProfile } from "./joinpay-account";
import { AccountObservationWriteError, refreshJoinpayAccountBySystem } from "./joinpay-account-store";

export type JoinpayAccountObservationOptions = Readonly<{
  pool: Pool; profiles: readonly BoundJoinpayAccountProfile[]; dependencies: AccountQueryDependencies; intervalSeconds: number;
}>;
function options(value: JoinpayAccountObservationOptions): JoinpayAccountObservationOptions {
  if (!value || !Array.isArray(value.profiles) || value.profiles.length < 1 || value.profiles.length > 2
    || !Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 60 || value.intervalSeconds > 86400
    || typeof value.pool?.connect !== "function" || typeof value.dependencies?.keyFor !== "function"
    || value.dependencies.fetch !== undefined && typeof value.dependencies.fetch !== "function") throw new JoinpayAccountError("ACCOUNT_OBSERVER_OPTIONS_INVALID");
  const descriptions = value.profiles.map(assertJoinpayAccountReadProfile), first = descriptions[0]!;
  if (new Set(descriptions.map(p => p.operation)).size !== descriptions.length || descriptions.some(p =>
    p.resourceDatabase !== first.resourceDatabase || p.resourceRuntimeUser !== first.resourceRuntimeUser
    || p.merchantIdentityId !== first.merchantIdentityId || p.userNo !== first.userNo)) throw new JoinpayAccountError("ACCOUNT_OBSERVER_SCOPE_MISMATCH");
  return { ...value, profiles: Object.freeze([...value.profiles]) };
}

/** 一轮只查询显式配置的账户类型；页面读取不调用本函数。 */
export async function observeJoinpayAccountBatch(value: JoinpayAccountObservationOptions, signal?: AbortSignal) {
  const o = options(value); let recorded = 0;
  for (const profile of o.profiles) {
    if (signal?.aborted) break;
    const result = await refreshJoinpayAccountBySystem(o.pool, profile, { ...o.dependencies, signal }, `account_observe_${randomUUID().replaceAll("-", "")}`);
    if (result.integration === "NOT_INTEGRATED") throw new JoinpayAccountError("ACCOUNT_SCHEMA_NOT_DEPLOYED");
    recorded++;
  }
  return { recorded };
}

@Injectable()
export class JoinpayAccountObservationLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private configured?: JoinpayAccountObservationOptions;
  private bootstrapped = false;
  private closing = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private failure: { code: string; attemptId?: string } | null = null;

  start(value: JoinpayAccountObservationOptions) {
    if (this.configured || this.closing) throw new JoinpayAccountError("ACCOUNT_OBSERVER_ALREADY_STARTED");
    this.configured = options(value);
    if (this.bootstrapped) this.schedule(0);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      if (this.controller.signal.aborted) return;
      this.active = observeJoinpayAccountBatch(this.configured!, this.controller.signal).then(() => {
        if (!this.controller.signal.aborted) this.schedule(this.configured!.intervalSeconds * 1000);
      }, error => {
        this.failure = error instanceof AccountObservationWriteError ? { code: error.code, attemptId: error.attemptId }
          : { code: error instanceof JoinpayAccountError ? error.code : "ACCOUNT_OBSERVER_FAILED" };
        this.controller.abort();
      });
    }, delay);
    this.timer.unref();
  }
  onApplicationBootstrap() { this.bootstrapped = true; if (this.configured && !this.closing) this.schedule(0); }
  status() { return { stopped: !this.configured || this.controller.signal.aborted, failure: this.failure && { ...this.failure } }; }
  async beforeApplicationShutdown() {
    this.closing = true; this.controller.abort(); if (this.timer) clearTimeout(this.timer); await this.active;
  }
}
