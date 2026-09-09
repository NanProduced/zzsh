import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import {
  ReadinessService,
  ShutdownGateMiddleware,
  type ReadinessModuleOptions,
} from "./health/readiness";
import {
  installApiInfrastructure,
  type ApiAppInfrastructureOptions,
} from "./logging/request-logger";

export type ApiAppOptions = ApiAppInfrastructureOptions & {
  health: ReadinessModuleOptions;
};

export async function createApp(options: ApiAppOptions) {
  const app = await NestFactory.create(
    AppModule.register(options.health),
    { logger: ["error", "warn"], rawBody: true },
  );
  installApiInfrastructure(app, options);
  const shutdownGate = new ShutdownGateMiddleware(app.get(ReadinessService));
  app.use(shutdownGate.use.bind(shutdownGate));
  app.enableShutdownHooks();
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder().setTitle("ZZSH API").setVersion("0.0.0").build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }
  return app;
}
