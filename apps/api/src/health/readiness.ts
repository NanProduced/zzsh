import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { createClient } from "redis";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import type { AppConfig } from "../config/config";

export const HEALTH_DEPENDENCIES = Symbol("zzsh.health.dependencies");
export const READINESS_TIMEOUT_MS = Symbol("zzsh.health.timeoutMs");
export const SHUTDOWN_TIMEOUT_MS = Symbol("zzsh.health.shutdownTimeoutMs");
export const DEFAULT_READINESS_TIMEOUT_MS = 1_000;

export type HealthDependency = {
  check: () => Promise<void>;
  close: () => Promise<void>;
};

export type HealthDependencies = {
  postgres: HealthDependency;
  redis: HealthDependency;
};

export type ReadinessModuleOptions = {
  dependencies: HealthDependencies;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizedTimeout(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) && timeoutMs !== undefined
    ? Math.max(1, Math.min(10_000, Math.floor(timeoutMs)))
    : DEFAULT_READINESS_TIMEOUT_MS;
}

@Injectable()
export class ReadinessService implements BeforeApplicationShutdown {
  private ready = false;
  private stopping = false;
  private checkPromise: Promise<boolean> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly activeRequests = new Set<ActiveRequest>();
  private drainResolve: (() => void) | undefined;

  constructor(
    @Inject(HEALTH_DEPENDENCIES)
    private readonly dependencies: HealthDependencies,
    @Inject(READINESS_TIMEOUT_MS)
    timeoutMs: number,
    @Inject(SHUTDOWN_TIMEOUT_MS)
    shutdownTimeoutMs: number,
  ) {
    this.timeoutMs = normalizedTimeout(timeoutMs);
    this.shutdownTimeoutMs = normalizedTimeout(shutdownTimeoutMs);
  }

  private readonly timeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  get isStopping(): boolean {
    return this.stopping;
  }

  beginRequest(forceClose: () => void): RequestLease | undefined {
    if (this.stopping) return undefined;
    const request: ActiveRequest = {
      forceClose,
      released: false,
      release: () => {
        if (request.released) return;
        request.released = true;
        this.activeRequests.delete(request);
        if (this.activeRequests.size === 0) this.drainResolve?.();
      },
    };
    this.activeRequests.add(request);
    return { release: request.release };
  }

  async check(): Promise<boolean> {
    if (this.stopping) return false;
    if (!this.checkPromise) {
      let current: Promise<boolean>;
      current = this.runCheck().finally(() => {
        if (this.checkPromise === current) this.checkPromise = undefined;
      });
      this.checkPromise = current;
    }
    return this.checkPromise;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (!this.closePromise) {
      this.closePromise = this.shutdownDependencies();
    }
    await this.closePromise;
  }

  private async shutdownDependencies(): Promise<void> {
    await this.drainRequests();
    await Promise.allSettled([
      withTimeout(
        Promise.resolve().then(() => this.dependencies.postgres.close()),
        this.timeoutMs,
        "postgres close timeout",
      ),
      withTimeout(
        Promise.resolve().then(() => this.dependencies.redis.close()),
        this.timeoutMs,
        "redis close timeout",
      ),
    ]);
  }

  private async drainRequests(): Promise<void> {
    if (this.activeRequests.size === 0) return;
    const wait = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
    try {
      await withTimeout(wait, this.shutdownTimeoutMs, "http drain timeout");
    } catch {
      const pending = [...this.activeRequests];
      for (const request of pending) {
        try {
          request.forceClose();
        } catch {
          // Forced HTTP termination is best effort; the request lease is released below.
        }
        request.release();
      }
    } finally {
      this.drainResolve = undefined;
    }
  }

  private async runCheck(): Promise<boolean> {
    const results = await Promise.allSettled([
      withTimeout(this.dependencies.postgres.check(), this.timeoutMs, "postgres readiness timeout"),
      withTimeout(this.dependencies.redis.check(), this.timeoutMs, "redis readiness timeout"),
    ]);
    const healthy = results.every((result) => result.status === "fulfilled");
    this.ready = healthy && !this.stopping;
    return this.ready;
  }
}

type ActiveRequest = {
  forceClose: () => void;
  released: boolean;
  release: () => void;
};

export type RequestLease = {
  release: () => void;
};

type ShutdownRequest = {
  url?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

type ShutdownResponse = {
  status: (code: number) => ShutdownResponse;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
  once: (event: "finish" | "close", listener: () => void) => void;
  destroy?: () => void;
};

function isHealthProbe(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const path = url.split("?", 1)[0];
  return path === "/api/health" || path === "/api/ready";
}

export class ShutdownGateMiddleware {
  constructor(private readonly readiness: ReadinessService) {}

  use(request: ShutdownRequest, response: ShutdownResponse, next: () => void): void {
    if (this.readiness.isStopping && isHealthProbe(request.url)) {
      next();
      return;
    }

    if (this.readiness.isStopping) {
      this.reject(request, response);
      return;
    }

    const lease = this.readiness.beginRequest(() => response.destroy?.());
    if (!lease) {
      this.reject(request, response);
      return;
    }
    const release = () => lease.release();
    response.once("finish", release);
    response.once("close", release);
    try {
      next();
    } catch (error) {
      release();
      throw error;
    }
  }

  private reject(request: ShutdownRequest, response: ShutdownResponse): void {
    const requestId = ensureApiV1RequestId(request);
    response.status(503);
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId,
      },
    }));
  }
}

export function createFakeHealthDependencies(): HealthDependencies {
  return {
    postgres: { check: async () => undefined, close: async () => undefined },
    redis: { check: async () => undefined, close: async () => undefined },
  };
}

function createPostgresHealthDependency(
  config: AppConfig,
  timeoutMs: number,
): HealthDependency {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    application_name: "zzsh-api-readiness",
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  pool.on("error", () => undefined);
  let closed = false;

  return {
    async check(): Promise<void> {
      await pool.query("SELECT 1");
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await withTimeout(pool.end(), timeoutMs, "postgres close timeout");
      } catch {
        // A bounded close must not keep shutdown or diagnostics hanging.
      }
    },
  };
}

function createRedisHealthDependency(
  config: AppConfig,
  timeoutMs: number,
): HealthDependency {
  const client = createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
      connectTimeout: timeoutMs,
      reconnectStrategy: false,
    },
    password: config.redis.password,
    disableOfflineQueue: true,
  });
  client.on("error", () => undefined);

  let connecting: Promise<boolean> | undefined;
  let closed = false;

  async function connectIfNeeded(): Promise<void> {
    if (client.isReady) return;
    if (!connecting) {
      const attempt = Promise.resolve()
        .then(() => client.connect())
        .then(() => true, () => false);
      let tracked: Promise<boolean>;
      tracked = attempt.finally(() => {
        if (connecting === tracked) connecting = undefined;
      });
      connecting = tracked;
    }
    const connected = await withTimeout(
      connecting,
      timeoutMs,
      "redis connect timeout",
    );
    if (!connected || !client.isReady) throw new Error("redis is not ready");
  }

  return {
    async check(): Promise<void> {
      if (closed) throw new Error("redis is closed");
      await connectIfNeeded();
      try {
        const response = await withTimeout(client.ping(), timeoutMs, "redis ping timeout");
        if (response !== "PONG") throw new Error("redis ping rejected");
      } catch (error) {
        client.destroy();
        throw error;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        if (client.isOpen) {
          await withTimeout(client.close(), timeoutMs, "redis close timeout");
        } else {
          client.destroy();
        }
      } catch {
        client.destroy();
      }
    },
  };
}

export function createRealHealthDependencies(
  config: AppConfig,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
): HealthDependencies {
  const boundedTimeout = normalizedTimeout(timeoutMs);
  return {
    postgres: createPostgresHealthDependency(config, boundedTimeout),
    redis: createRedisHealthDependency(config, boundedTimeout),
  };
}
