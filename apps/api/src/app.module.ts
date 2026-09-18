import { DynamicModule, Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import type { ReadinessModuleOptions } from "./health/readiness";
import { BusinessDatabaseModule, type BusinessDatabaseOptions } from "./database/business";
import { OrderSweepModule, type OrderSweepModuleOptions } from "./order/order-sweep.module";
import { MessageScopeRecoveryLifecycle } from "./im/consultation";
import { OrderDispatchLifecycle } from "./im/order-dispatch";
import { OrderTeamLifecycle } from "./im/order-team";

@Module({})
export class AppModule {
  static register(options: ReadinessModuleOptions, database?: BusinessDatabaseOptions, orderSweep?: OrderSweepModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.register(options),
        ...(database ? [BusinessDatabaseModule.register(database)] : []),
        // Registered after BusinessDatabaseModule so its shutdown hook (stopping
        // the sweeper and awaiting the in-flight batch) fires before the pool ends.
        ...(orderSweep ? [OrderSweepModule.register(orderSweep)] : []),
      ],
      providers: [MessageScopeRecoveryLifecycle, OrderDispatchLifecycle, OrderTeamLifecycle],
    };
  }
}
