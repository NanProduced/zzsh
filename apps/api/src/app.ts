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
import { mountAuthHandlers, type AuthRuntimeOptions } from "./auth/auth-runtime";
import type { BusinessDatabaseOptions } from "./database/business";
import type { OrderSweepModuleOptions } from "./order/order-sweep.module";

export type ApiAppOptions = ApiAppInfrastructureOptions & {
  health: ReadinessModuleOptions;
  database?: BusinessDatabaseOptions;
  auth?: AuthRuntimeOptions;
  orderSweep?: OrderSweepModuleOptions;
};

const LARGE_IM_MESSAGE_PATHS = new Set([
  "/api/v1/im/user/messages",
  "/api/v1/im/admin/messages",
  "/api/bff/admin/im/messages",
]);
const ORDER_IM_CALLBACK_PATHS = new Set([
  "/api/v1/im/order-events/copy",
  "/api/v1/im/order-events/pre-send",
]);

type ImBodyRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  on: (event: "data" | "end" | "error", listener: (chunk?: Buffer | string) => void) => void;
};

type ImBodyResponse = { statusCode?: number; end: () => void };

function installImMessageBodyParser(app: { getHttpAdapter: () => { getInstance: () => { use: (middleware: (request: ImBodyRequest, response: ImBodyResponse, next: () => void) => void) => void } } }): void {
  app.getHttpAdapter().getInstance().use((request, response, next) => {
    const path = (request.originalUrl ?? request.url ?? "/").split("?", 1)[0] ?? "/";
    const contentType = request.headers["content-type"];
    const json = (Array.isArray(contentType) ? contentType[0] : contentType)?.toLowerCase().includes("application/json") ?? false;
    const callback = request.method?.toUpperCase() === "POST" && ORDER_IM_CALLBACK_PATHS.has(path);
    if (callback) {
      const chunks: Buffer[] = [];
      let total = 0;
      let closed = false;
      request.on("data", (chunk) => {
        if (closed || chunk === undefined) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > 100 * 1024) {
          closed = true;
          response.statusCode = 413;
          response.end();
          return;
        }
        chunks.push(bytes);
      });
      request.on("end", () => {
        if (closed) return;
        request.rawBody = Buffer.concat(chunks);
        next();
      });
      request.on("error", () => {
        if (closed) return;
        closed = true;
        response.statusCode = 400;
        response.end();
      });
      return;
    }
    if (request.method?.toUpperCase() !== "POST" || !LARGE_IM_MESSAGE_PATHS.has(path) || !json) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let closed = false;
    request.on("data", (chunk) => {
      if (closed || chunk === undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > 15 * 1024 * 1024) {
        closed = true;
        response.statusCode = 413;
        response.end();
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (closed) return;
      if (total === 0) {
        next();
        return;
      }
      try {
        request.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        next();
      } catch {
        response.statusCode = 400;
        response.end();
      }
    });
    request.on("error", () => {
      if (closed) return;
      closed = true;
      response.statusCode = 400;
      response.end();
    });
  });
}

export async function createApp(options: ApiAppOptions) {
  const app = await NestFactory.create(
    AppModule.register(options.health, options.database, options.orderSweep),
    { logger: ["error", "warn"], bodyParser: false, rawBody: true },
  );
  installImMessageBodyParser(app);
  (app as unknown as { useBodyParser: (parser: "json", options?: { limit?: string }) => void }).useBodyParser("json", { limit: "100kb" });
  installApiInfrastructure(app, options);
  const shutdownGate = new ShutdownGateMiddleware(app.get(ReadinessService));
  app.use(shutdownGate.use.bind(shutdownGate));
  app.enableShutdownHooks();
  if (options.auth) {
    if (!options.database) throw new Error("Auth requires a business database");
    await mountAuthHandlers(app, options.auth);
  }
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder().setTitle("ZZSH API").setVersion("0.0.0").build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }
  return app;
}
