import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ConfigurationError } from "../config/config";
import type { EcsTestDemoRuntime } from "../finance/ecs-test-demo-runtime";
import { demoForChannelRequestCapability } from "./channel-payment-store";
import { runEcsDemoRefundBatch } from "./ecs-demo-refund-service";
import { runRegisteredControlledWithdrawalBatch } from "../finance/controlled-withdrawal-worker";
import { assertEcsTestDemoResource } from "../finance/ecs-test-demo-resource";
import { DISTRIBUTION_DUE_LOCK_KEY, runDistributionAccrualTasks } from "../finance/distribution-accrual-tasks";

/** Demo tasks use the same session lock, and the demo store selects only its CONTROLLED payments. */
export async function runEcsDemoAccrualTasks(pool: Pool, runtime: EcsTestDemoRuntime, limit: number) {
  if (demoForChannelRequestCapability(runtime.refund.capability) !== runtime.demo)
    throw new ConfigurationError("ECS_TEST_DEMO_REFUND_WORKER_INVALID");
  const client = await pool.connect();
  let held = false, lost = false, destroy = false;
  const onLost = () => { lost = true; };
  client.once('error', onLost); client.once('end', onLost);
  try {
    await client.query('BEGIN');
    try { await assertEcsTestDemoResource(client, runtime.demo); await client.query('COMMIT'); }
    catch (error) { try { await client.query('ROLLBACK'); } catch { /* the connection is destroyed below */ } throw error; }
    held = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [DISTRIBUTION_DUE_LOCK_KEY])).rows[0]?.acquired === true;
    if (!held) return null;
    return await runDistributionAccrualTasks(client, runtime.earnings,
      { userId: 'distribution-due-demo', sessionId: 'system', system: true, authorize: async () => {} }, limit, () => held && !lost);
  } catch (error) { destroy = true; throw error; }
  finally {
    client.removeListener('error', onLost); client.removeListener('end', onLost);
    if (held && !lost && !destroy) {
      try { if ((await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [DISTRIBUTION_DUE_LOCK_KEY])).rows[0]?.released !== true) destroy = true; }
      catch { destroy = true; }
    } else if (held || lost) destroy = true;
    client.release(destroy ? true : undefined);
  }
}

/** Explicitly installed only with the registered ECS demo bundle. */
@Injectable()
export class EcsDemoRefundLifecycle implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private nextEarningCheck = 0;
  private earningsNeedReview = false;

  start(pool: Pool, runtime: EcsTestDemoRuntime): void {
    if (this.timer || this.stopped || demoForChannelRequestCapability(runtime.refund.capability) !== runtime.demo)
      throw new ConfigurationError("ECS_TEST_DEMO_REFUND_WORKER_INVALID");
    const tick = () => {
      if (this.pending || this.stopped) return;
      this.pending = (async()=>{
        try { await runEcsDemoRefundBatch(pool, runtime.refund, 10, "ecs_demo_refund_worker"); }
        catch { console.error("Test simulated refund worker failed; original intents remain queryable"); }
        try { await runRegisteredControlledWithdrawalBatch(pool,runtime.withdrawal.scope,10); }
        catch { console.error("Test simulated withdrawal worker failed; original intents remain queryable"); }
        if (Date.now()>=this.nextEarningCheck) {
          this.nextEarningCheck=Date.now()+60000;
          let taskPass = false;
          try {
            taskPass = await runEcsDemoAccrualTasks(pool,runtime,20) !== null;
          } catch { console.error("Test simulated accrual tasks require original-record review"); }
          if (taskPass && !this.earningsNeedReview) try {
            const result=await runtime.earnings.settleDue(pool,20,"demo_due_"+randomUUID().replaceAll('-',''));
            if(result.recoveryRequired){this.earningsNeedReview=true;console.error("Test simulated earnings require original-record review");}
          } catch { this.earningsNeedReview=true;console.error("Test simulated earnings worker failed; original records require review"); }
        }
      })().finally(() => { this.pending = undefined; });
    };
    this.timer = setInterval(tick, 5000); this.timer.unref(); tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); await this.pending;
  }
}
