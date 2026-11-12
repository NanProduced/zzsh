import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ConfigurationError } from "../config/config";
import type { EcsTestDemoRuntime } from "../finance/ecs-test-demo-runtime";
import { demoForChannelRequestCapability } from "./channel-payment-store";
import { runEcsDemoRefundBatch } from "./ecs-demo-refund-service";
import { runRegisteredControlledWithdrawalBatch } from "../finance/controlled-withdrawal-worker";
import { runDemoGuaranteeRefundBatch } from "../credit/demo-guarantee";

/** Explicitly installed only with the registered ECS demo bundle. */
@Injectable()
export class EcsDemoRefundLifecycle implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private nextEarningCheck = 0;
  private earningsNeedReview = false;

  start(pool: Pool, runtime: EcsTestDemoRuntime, creditGuaranteeEnabled = false): void {
    if (this.timer || this.stopped || demoForChannelRequestCapability(runtime.refund.capability) !== runtime.demo)
      throw new ConfigurationError("ECS_TEST_DEMO_REFUND_WORKER_INVALID");
    const tick = () => {
      if (this.pending || this.stopped) return;
      this.pending = (async()=>{
        try { await runEcsDemoRefundBatch(pool, runtime.refund, 10, "ecs_demo_refund_worker"); }
        catch { console.error("Test simulated refund worker failed; original intents remain queryable"); }
        try { await runRegisteredControlledWithdrawalBatch(pool,runtime.withdrawal.scope,10); }
        catch { console.error("Test simulated withdrawal worker failed; original intents remain queryable"); }
        if (creditGuaranteeEnabled) try {
          const result = await runDemoGuaranteeRefundBatch(pool, runtime.demo, 10);
          if (result.failed) console.error("Test simulated guarantee refund requires review");
        } catch { console.error("Test simulated guarantee refund worker failed; original intents remain queryable"); }
        if (!this.earningsNeedReview && Date.now()>=this.nextEarningCheck) {
          this.nextEarningCheck=Date.now()+60000;
          try {
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
