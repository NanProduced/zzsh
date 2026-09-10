import { DynamicModule, Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import type { ReadinessModuleOptions } from "./health/readiness";
import { BusinessDatabaseModule, type BusinessDatabaseOptions } from "./database/business";

@Module({})
export class AppModule {
  static register(options: ReadinessModuleOptions, database?: BusinessDatabaseOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.register(options),
        ...(database ? [BusinessDatabaseModule.register(database)] : []),
      ],
    };
  }
}
