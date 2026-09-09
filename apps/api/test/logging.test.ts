import "reflect-metadata";

import { strict as assert } from "node:assert";
import { request } from "node:http";
import { test } from "node:test";

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { installApiInfrastructure } from "../src/logging/request-logger";
import type { ApiHttpLogEvent, ApiLogSink } from "../src/logging/request-logger";

const SECRET = "sensitive-log-probe-value";
const SECRET_KEY = `private_${SECRET}`;

class MemoryLogSink implements ApiLogSink {
  readonly events: ApiHttpLogEvent[] = [];
  private readonly waiters = new Map<string, (event: ApiHttpLogEvent) => void>();

  write(event: ApiHttpLogEvent): void {
    this.events.push(event);
    this.waiters.get(event.requestId)?.(event);
    this.waiters.delete(event.requestId);
  }

  waitFor(requestId: string): Promise<ApiHttpLogEvent> {
    const existing = this.events.find((event) => event.requestId === requestId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.set(requestId, resolve));
  }
}

@Injectable()
class DelayedProbeGate {
  private startedResolve!: () => void;
  private releaseResolve!: () => void;
  private completedResolve!: () => void;
  readonly started: Promise<void>;
  readonly completed: Promise<void>;
  private readonly release: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => { this.startedResolve = resolve; });
    this.release = new Promise((resolve) => { this.releaseResolve = resolve; });
    this.completed = new Promise((resolve) => { this.completedResolve = resolve; });
  }

  markStarted(): void { this.startedResolve(); }
  markCompleted(): void { this.completedResolve(); }
  waitForRelease(): Promise<void> { return this.release; }
  releaseRequest(): void { this.releaseResolve(); }
}

@Controller("logging")
class LoggingProbeController {
  constructor(private readonly delayedGate: DelayedProbeGate) {}

  @Get("ok")
  ok(): { ok: true } {
    return { ok: true };
  }

  @Post("ok")
  @HttpCode(200)
  postOk(): { ok: true } {
    return { ok: true };
  }

  @Get("items/:id")
  item(): { ok: true } {
    return { ok: true };
  }

  @Get("delayed")
  async delayed(): Promise<{ ok: true }> {
    this.delayedGate.markStarted();
    await this.delayedGate.waitForRelease();
    this.delayedGate.markCompleted();
    return { ok: true };
  }

  @Get("bad-request")
  badRequest(): never {
    throw new BadRequestException(`private bad request ${SECRET}`);
  }

  @Get("unauthenticated")
  unauthenticated(): never {
    throw new UnauthorizedException(`private authentication ${SECRET}`);
  }

  @Get("forbidden")
  forbidden(): never {
    throw new ForbiddenException(`private authorization ${SECRET}`);
  }

  @Get("rate-limited")
  rateLimited(): never {
    throw new HttpException(`private rate limit ${SECRET}`, 429);
  }

  @Get("failure")
  failure(): never {
    throw new Error(`private provider stack ${SECRET}`);
  }
}

@Module({ controllers: [LoggingProbeController], providers: [DelayedProbeGate] })
class LoggingProbeModule {}

async function startLoggingProbe(sink: ApiLogSink) {
  const app = await NestFactory.create(LoggingProbeModule, { logger: false });
  installApiInfrastructure(app, { logSink: sink });
  await app.listen(0, "127.0.0.1");
  return app;
}

async function readJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function logKeys(event: ApiHttpLogEvent): string[] {
  return Object.keys(event).sort();
}

test("structured request logs are allowlisted, correlated and emitted once", async () => {
  const sink = new MemoryLogSink();
  const app = await startLoggingProbe(sink);
  try {
    const baseUrl = await app.getUrl();
    const successResponse = await fetch(
      `${baseUrl}/api/logging/ok?phone=${encodeURIComponent(SECRET)}&token=${encodeURIComponent(SECRET)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${SECRET}`,
          Cookie: `session=${SECRET}`,
          "X-Request-Id": "req_success_001",
        },
        body: JSON.stringify({ password: SECRET, [SECRET_KEY]: SECRET }),
      },
    );
    assert.equal(successResponse.status, 200);
    assert.equal(successResponse.headers.get("x-request-id"), "req_success_001");

    const templatedResponse = await fetch(
      `${baseUrl}/api/logging/items/${SECRET}?phone=${encodeURIComponent(SECRET)}`,
      { headers: { "X-Request-Id": "req_template_001" } },
    );
    assert.equal(templatedResponse.status, 200);
    assert.equal(templatedResponse.headers.get("x-request-id"), "req_template_001");

    const cases = [
      ["bad-request", 400, "req_bad_request", "INVALID_ARGUMENT"],
      ["unauthenticated", 401, "req_unauthenticated", "UNAUTHENTICATED"],
      ["forbidden", 403, "req_forbidden", "FORBIDDEN"],
      ["rate-limited", 429, "req_rate_limited", "RATE_LIMITED"],
      ["failure", 500, "req_failure", "INTERNAL_ERROR"],
    ] as const;

    for (const [route, expectedStatus, requestId, code] of cases) {
      const response = await fetch(`${baseUrl}/api/logging/${route}`, {
        headers: { "X-Request-Id": requestId },
      });
      assert.equal(response.status, expectedStatus);
      const body = await readJson(response);
      assert.equal(body.error.code, code);
      assert.equal(body.error.requestId, requestId);
      assert.equal(response.headers.get("x-request-id"), requestId);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
    }

    const notFoundResponse = await fetch(
      `${baseUrl}/api/logging/${SECRET}/missing?password=${encodeURIComponent(SECRET)}`,
      { headers: { "X-Request-Id": `../../${SECRET}` } },
    );
    assert.equal(notFoundResponse.status, 404);
    const notFoundBody = await readJson(notFoundResponse);
    const generatedRequestId = notFoundBody.error.requestId as string;
    assert.equal(notFoundBody.error.code, "NOT_FOUND");
    assert.match(generatedRequestId, /^req_[A-Za-z0-9-]+$/);
    assert.equal(notFoundResponse.headers.get("x-request-id"), generatedRequestId);

    const expectedRequestIds = [
      "req_success_001",
      "req_template_001",
      ...cases.map(([, , requestId]) => requestId),
      generatedRequestId,
    ];
    assert.equal(sink.events.length, expectedRequestIds.length);
    for (const requestId of expectedRequestIds) {
      const matching = sink.events.filter((event) => event.requestId === requestId);
      assert.equal(matching.length, 1);
      assert.deepEqual(logKeys(matching[0]!), [
        "completion",
        "durationMs",
        "event",
        "method",
        "outcome",
        "requestId",
        "route",
        "status",
      ]);
    }

    const notFoundEvent = sink.events.find((event) => event.requestId === generatedRequestId);
    assert.equal(notFoundEvent?.route, "<unmatched>");
    assert.equal(notFoundEvent?.status, 404);
    assert.equal(notFoundEvent?.outcome, "failure");
    assert.equal(notFoundEvent?.completion, "completed");
    const templatedEvent = sink.events.find((event) => event.requestId === "req_template_001");
    assert.equal(templatedEvent?.route, "/api/logging/items/:id");
    assert.equal(templatedEvent?.completion, "completed");
    assert.doesNotMatch(JSON.stringify(sink.events), new RegExp(SECRET));
  } finally {
    await app.close();
  }
});

test("concurrent requests keep request IDs and route fields isolated", async () => {
  const sink = new MemoryLogSink();
  const app = await startLoggingProbe(sink);
  try {
    const baseUrl = await app.getUrl();
    const requests = Array.from({ length: 20 }, (_, index) => {
      const requestId = `req_concurrent_${index}`;
      return fetch(`${baseUrl}/api/logging/ok?secret=${encodeURIComponent(SECRET)}`, {
        headers: { "X-Request-Id": requestId },
      }).then(async (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-request-id"), requestId);
      });
    });
    await Promise.all(requests);

    const concurrentEvents = sink.events.filter((event) => event.requestId.startsWith("req_concurrent_"));
    assert.equal(concurrentEvents.length, 20);
    assert.equal(new Set(concurrentEvents.map((event) => event.requestId)).size, 20);
    for (const event of concurrentEvents) {
      assert.equal(event.method, "GET");
      assert.equal(event.route, "/api/logging/ok");
      assert.equal(event.status, 200);
      assert.equal(event.outcome, "success");
      assert.equal(event.completion, "completed");
    }
    assert.doesNotMatch(JSON.stringify(concurrentEvents), new RegExp(SECRET));
  } finally {
    await app.close();
  }
});

test("an early client close is logged once as aborted without a fake success", async () => {
  const sink = new MemoryLogSink();
  const app = await startLoggingProbe(sink);
  try {
    const gate = app.get(DelayedProbeGate);
    const baseUrl = await app.getUrl();
    const requestId = "req_aborted_001";
    const eventPromise = sink.waitFor(requestId);
    const clientRequest = request(new URL(`${baseUrl}/api/logging/delayed`), {
      headers: { "X-Request-Id": requestId },
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end();
    await gate.started;
    clientRequest.destroy();

    const event = await eventPromise;
    assert.equal(event.requestId, requestId);
    assert.equal(event.completion, "aborted");
    assert.equal(event.outcome, "aborted");
    assert.equal(event.status, null);
    assert.equal(sink.events.filter((item) => item.requestId === requestId).length, 1);
    gate.releaseRequest();
    await gate.completed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sink.events.filter((item) => item.requestId === requestId).length, 1);
  } finally {
    await app.close();
  }
});

test("a failing log sink cannot fail the response or echo its exception", async () => {
  const warnings: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const failingSink: ApiLogSink = {
    write: () => { throw new Error(`sink-private ${SECRET}`); },
  };
  let app: Awaited<ReturnType<typeof startLoggingProbe>> | undefined;
  try {
    app = await startLoggingProbe(failingSink);
    const response = await fetch(`${await app.getUrl()}/api/logging/ok`);
    assert.equal(response.status, 200);
    const followUpResponse = await fetch(`${await app.getUrl()}/api/logging/ok?next=1`);
    assert.equal(followUpResponse.status, 200);
    assert.deepEqual(warnings, [
      '{"event":"logging.sink_failure","severity":"error"}\n',
      '{"event":"logging.sink_failure","severity":"error"}\n',
    ]);
    assert.doesNotMatch(warnings.join(""), new RegExp(SECRET));
  } finally {
    if (app) await app.close();
    process.stderr.write = originalWrite;
  }
});
