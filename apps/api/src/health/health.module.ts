import { DynamicModule, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ReadinessController } from "./readiness.controller";
import {
  HEALTH_DEPENDENCIES,
  ReadinessService,
  READINESS_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  type ReadinessModuleOptions,
} from "./readiness";

@Module({})
export class HealthModule {
  static register(options: ReadinessModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController, ReadinessController],
      providers: [
        { provide: HEALTH_DEPENDENCIES, useValue: options.dependencies },
        {
          provide: READINESS_TIMEOUT_MS,
          useValue: options.timeoutMs,
        },
        {
          provide: SHUTDOWN_TIMEOUT_MS,
          useValue: options.shutdownTimeoutMs,
        },
        ReadinessService,
      ],
      exports: [ReadinessService],
    };
  }
}
