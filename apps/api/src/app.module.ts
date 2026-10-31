import { DynamicModule, Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import type { ReadinessModuleOptions } from "./health/readiness";
import { BusinessDatabaseModule, type BusinessDatabaseOptions } from "./database/business";
import { OrderSweepModule, type OrderSweepModuleOptions } from "./order/order-sweep.module";
import { DistributionDueModule, type DistributionDueModuleOptions } from "./finance/distribution-due.module";
import { MessageScopeRecoveryLifecycle } from "./im/consultation";
import { OrderDispatchLifecycle } from "./im/order-dispatch";
import { OrderImEventRecoveryLifecycle } from "./im/order-im-events";
import { OrderTeamLifecycle } from "./im/order-team";
import { JoinpayCollectionRecoveryLifecycle } from "./order/joinpay-collection-recovery";
import { JoinpayFundsRecoveryLifecycle } from "./finance/joinpay-funds-recovery";
import { JoinpayAccountObservationLifecycle } from "./finance/joinpay-account-observer";

@Module({})
export class AppModule {
  static register(options: ReadinessModuleOptions, database?: BusinessDatabaseOptions, orderSweep?: OrderSweepModuleOptions, distributionDue?: DistributionDueModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.register(options),
        ...(database ? [BusinessDatabaseModule.register(database)] : []),
        // Registered after BusinessDatabaseModule so its shutdown hook (stopping
        // the sweeper and awaiting the in-flight batch) fires before the pool ends.
        ...(orderSweep ? [OrderSweepModule.register(orderSweep)] : []),
        ...(distributionDue ? [DistributionDueModule.register(distributionDue)] : []),
      ],
      providers: [MessageScopeRecoveryLifecycle, OrderDispatchLifecycle, OrderTeamLifecycle, OrderImEventRecoveryLifecycle, JoinpayCollectionRecoveryLifecycle, JoinpayFundsRecoveryLifecycle, JoinpayAccountObservationLifecycle],
    };
  }
}
