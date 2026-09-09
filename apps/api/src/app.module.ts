import { DynamicModule, Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import type { ReadinessModuleOptions } from "./health/readiness";

@Module({})
export class AppModule {
  static register(options: ReadinessModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(options)],
    };
  }
}
