import {
  INestApplication,
} from "@nestjs/common";

import {
  ApiV1ExceptionFilter,
  ApiV1RequestIdInterceptor,
  ensureApiV1RequestId,
} from "../contracts/api-v1";

export type ApiHttpLogEvent = Readonly<{
  event: "http.request.completed";
  requestId: string;
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  outcome: "success" | "failure" | "aborted";
  completion: "completed" | "aborted";
}>;

export interface ApiLogSink {
  write(event: ApiHttpLogEvent): void;
}

export class JsonStdoutApiLogSink implements ApiLogSink {
  write(event: ApiHttpLogEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

export class ApiStructuredLogger {
  constructor(private readonly sink: ApiLogSink = new JsonStdoutApiLogSink()) {}

  logHttpRequest(fields: Omit<ApiHttpLogEvent, "event">): void {
    const event: ApiHttpLogEvent = Object.freeze({
      event: "http.request.completed",
      requestId: fields.requestId,
      method: fields.method,
      route: fields.route,
      status: fields.status,
      durationMs: fields.durationMs,
      outcome: fields.outcome,
      completion: fields.completion,
    });
    try {
      this.sink.write(event);
    } catch {
      try {
        process.stderr.write('{"event":"logging.sink_failure","severity":"error"}\n');
      } catch {
        // Diagnostics must never become a second request failure.
      }
    }
  }
}

type RequestLike = {
  method?: unknown;
  baseUrl?: unknown;
  route?: { path?: unknown };
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

type ResponseLike = {
  statusCode?: unknown;
  writableFinished?: boolean;
  once: (event: "finish" | "close", listener: () => void) => void;
};

const UNMATCHED_ROUTE = "<unmatched>";
const MATCHED_ROUTE = "<matched>";
const SAFE_ROUTE_TEMPLATE = /^\/[A-Za-z0-9_./:()*?{}-]{1,255}$/;

function safeMethod(request: RequestLike): string {
  return typeof request.method === "string" && /^[A-Z]{3,10}$/.test(request.method)
    ? request.method
    : "<unknown>";
}

function safeRouteTemplate(request: RequestLike): string {
  const routePath = request.route?.path;
  if (typeof routePath !== "string" || routePath.length === 0) return UNMATCHED_ROUTE;
  const baseUrl = typeof request.baseUrl === "string" ? request.baseUrl : "";
  const route = `${baseUrl}${routePath}`;
  return SAFE_ROUTE_TEMPLATE.test(route) ? route : MATCHED_ROUTE;
}

function safeStatus(response: ResponseLike): number {
  return typeof response.statusCode === "number" &&
    Number.isInteger(response.statusCode) &&
    response.statusCode >= 100 &&
    response.statusCode <= 599
    ? response.statusCode
    : 500;
}

export class ApiRequestLoggingMiddleware {
  constructor(private readonly logger: ApiStructuredLogger) {}

  use(request: RequestLike, response: ResponseLike, next: () => void): void {
    const requestId = ensureApiV1RequestId(request);
    const startedAt = process.hrtime.bigint();
    let logged = false;

    const logOnce = (completion: "completed" | "aborted") => {
      if (logged) return;
      logged = true;
      const aborted = completion === "aborted";
      const status = aborted ? null : safeStatus(response);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logger.logHttpRequest({
        requestId,
        method: safeMethod(request),
        route: safeRouteTemplate(request),
        status,
        durationMs: Math.max(0, Math.round(durationMs)),
        outcome: aborted ? "aborted" : status !== null && status >= 400 ? "failure" : "success",
        completion,
      });
    };

    response.once("finish", () => logOnce("completed"));
    response.once("close", () => logOnce(response.writableFinished ? "completed" : "aborted"));
    next();
  }
}

export type ApiAppInfrastructureOptions = {
  logSink?: ApiLogSink;
};

export function installApiInfrastructure(
  app: INestApplication,
  options: ApiAppInfrastructureOptions = {},
): void {
  app.setGlobalPrefix("api");
  const loggingMiddleware = new ApiRequestLoggingMiddleware(
    new ApiStructuredLogger(options.logSink),
  );
  app.use(loggingMiddleware.use.bind(loggingMiddleware));
  app.useGlobalInterceptors(
    new ApiV1RequestIdInterceptor(),
  );
  app.useGlobalFilters(new ApiV1ExceptionFilter());
}
