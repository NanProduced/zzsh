import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"], rawBody: true });
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder().setTitle("ZZSH API").setVersion("0.0.0").build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }
  return app;
}
