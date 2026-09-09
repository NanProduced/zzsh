import "reflect-metadata";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Module,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@nestjs/swagger";

import {
  API_V1_ERROR_CODES,
  ApiV1ContractRequestDto,
  ApiV1ContractResponseDto,
  ApiV1ContractValidationPipe,
  ApiV1ErrorResponseDto,
  ApiV1ExceptionFilter,
  ApiV1RequestIdInterceptor,
  API_V1_TOKEN_PATTERN,
  idempotencyScopeKey,
  resolveIdempotencyDecision,
  validateApiV1ContractRequest,
  validateIdempotencyKey,
} from "../src/contracts/api-v1";

const VALID_REQUEST = {
  resourceId: "account_123",
  amount: { currency: "CNY", unit: "yuan", amount: "123.45", scale: 2 },
  occurredAt: "2026-09-10T12:30:00+08:00",
  page: { cursor: "cursor_001", limit: 20 },
};

@ApiTags("api-v1-contract")
@Controller("v1/contracts")
class ContractProbeController {
  @Post("validate")
  @HttpCode(200)
  @ApiOperation({ summary: "Isolated contract validation probe; not a production business endpoint" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Required for side-effecting operations; scoped by principal, operation and resource.",
    example: "idem_contract_001",
  })
  @ApiHeader({
    name: "X-Request-Id",
    required: false,
    description: "Optional safe correlation identifier; a server identifier is generated when absent or invalid.",
    example: "req_contract_001",
  })
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId", "amount", "occurredAt"],
      properties: {
        resourceId: {
          type: "string",
          pattern: API_V1_TOKEN_PATTERN,
          minLength: 1,
          maxLength: 128,
          example: "account_123",
        },
        amount: {
          type: "object",
          additionalProperties: false,
          required: ["currency", "unit", "amount", "scale"],
          properties: {
            currency: { type: "string", enum: ["CNY"] },
            unit: { type: "string", enum: ["yuan"] },
            amount: { type: "string", pattern: "^(0|[1-9]\\d*)\\.\\d{2}$" },
            scale: { type: "integer", enum: [2] },
          },
        },
        occurredAt: { type: "string", format: "date-time" },
        page: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", pattern: API_V1_TOKEN_PATTERN, minLength: 1, maxLength: 128 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    examples: {
      valid: { value: VALID_REQUEST },
    },
  })
  @ApiOkResponse({
    type: ApiV1ContractResponseDto,
    examples: {
      valid: {
        summary: "valid response",
        value: {
          id: "account_123",
          amount: VALID_REQUEST.amount,
          occurredAt: VALID_REQUEST.occurredAt,
          page: { items: ["account_123"], nextCursor: null, limit: 20 },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    type: ApiV1ErrorResponseDto,
    examples: {
      invalidArgument: {
        summary: "invalid argument",
        value: {
          error: {
            code: API_V1_ERROR_CODES.INVALID_ARGUMENT,
            message: "Request validation failed",
            requestId: "req_contract_001",
            details: [{ path: "amount.amount", code: "INVALID_FIELD" }],
          },
        },
      },
    },
  })
  @ApiConflictResponse({
    type: ApiV1ErrorResponseDto,
    description: "The same idempotency scope and key was reused with a different request fingerprint.",
    examples: {
      idempotencyConflict: {
        summary: "idempotency conflict",
        value: {
          error: {
            code: API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
            message: "Idempotency key was already used for a different request",
            requestId: "req_contract_001",
          },
        },
      },
    },
  })
  validate(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ApiV1ContractValidationPipe()) body: ApiV1ContractRequestDto,
  ): ApiV1ContractResponseDto {
    validateIdempotencyKey(idempotencyKey);
    return {
      id: body.resourceId,
      amount: body.amount,
      occurredAt: body.occurredAt,
      page: {
        items: [body.resourceId],
        nextCursor: null,
        limit: body.page?.limit ?? 20,
      },
    };
  }

  @Get("failure")
  @ApiInternalServerErrorResponse({ type: ApiV1ErrorResponseDto })
  fail(): never {
    throw new Error("private provider response must never be returned");
  }

  @Get("unauthenticated")
  unauthenticated(): never {
    throw new UnauthorizedException("private authentication detail");
  }

  @Get("forbidden")
  forbidden(): never {
    throw new ForbiddenException("private authorization detail");
  }

  @Get("rate-limited")
  rateLimited(): never {
    throw new HttpException("private rate detail", 429);
  }
}

@Module({ controllers: [ContractProbeController] })
class ContractProbeModule {}

async function startContractProbe() {
  const app = await NestFactory.create(ContractProbeModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalInterceptors(new ApiV1RequestIdInterceptor());
  app.useGlobalFilters(new ApiV1ExceptionFilter());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("ZZSH API v1 contract probe").setVersion("1.0.0").build(),
  );
  SwaggerModule.setup("docs", app, document);
  await app.listen(0, "127.0.0.1");
  return app;
}

async function jsonResponse(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

test("API v1 OpenAPI and runtime contract use portable JSON semantics", async () => {
  const app = await startContractProbe();
  try {
    const baseUrl = await app.getUrl();
    const specResponse = await fetch(`${baseUrl}/docs-json`);
    assert.equal(specResponse.status, 200);
    const spec = (await specResponse.json()) as {
      paths: Record<string, {
        post?: {
          parameters?: Array<{ name: string }>;
          examples?: unknown;
          requestBody?: { content?: Record<string, { schema?: Record<string, any> }> };
        };
      }>;
      components?: { schemas?: Record<string, any> };
    };
    const operation = spec.paths["/api/v1/contracts/validate"]?.post;
    assert.ok(operation);
    assert.deepEqual(
      operation.parameters?.map((parameter) => parameter.name).sort(),
      ["Idempotency-Key", "X-Request-Id"].sort(),
    );
    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema as {
      additionalProperties: boolean;
      properties: Record<string, any>;
    };
    assert.equal(requestSchema.additionalProperties, false);
    assert.equal(requestSchema.properties.resourceId.pattern, API_V1_TOKEN_PATTERN);
    assert.equal(requestSchema.properties.resourceId.maxLength, 128);
    assert.equal(requestSchema.properties.page.additionalProperties, false);
    assert.equal(requestSchema.properties.page.properties.limit.type, "integer");
    const errorSchema = spec.components?.schemas?.ApiV1ErrorDto as {
      properties: { code: { enum: string[] } };
    };
    assert.ok(errorSchema);
    assert.deepEqual(errorSchema.properties.code.enum, Object.values(API_V1_ERROR_CODES));
    assert.match(JSON.stringify(operation), /CNY/);
    assert.match(JSON.stringify(operation), /idem_contract_001/);

    const validResponse = await fetch(`${baseUrl}/api/v1/contracts/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "idem_contract_001",
        "X-Request-Id": "req_contract_001",
      },
      body: JSON.stringify(VALID_REQUEST),
    });
    assert.equal(validResponse.status, 200);
    assert.equal(validResponse.headers.get("x-request-id"), "req_contract_001");
    assert.deepEqual(await jsonResponse(validResponse), {
      id: "account_123",
      amount: VALID_REQUEST.amount,
      occurredAt: VALID_REQUEST.occurredAt,
      page: { items: ["account_123"], nextCursor: null, limit: 20 },
    });

    const sensitiveInput = "provider-secret-must-not-echo";
    const sensitiveKey = `private_${sensitiveInput}`;
    const invalidResponse = await fetch(`${baseUrl}/api/v1/contracts/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "idem_contract_invalid",
        "X-Request-Id": "req_contract_invalid",
      },
      body: JSON.stringify({
        ...VALID_REQUEST,
        resourceId: "bad id",
        amount: { ...VALID_REQUEST.amount, amount: sensitiveInput, [sensitiveKey]: sensitiveInput },
        occurredAt: "2026-09-10T12:30:00",
        page: { ...VALID_REQUEST.page, [sensitiveKey]: sensitiveInput },
        [sensitiveKey]: sensitiveInput,
      }),
    });
    assert.equal(invalidResponse.status, 400);
    const invalidBody = await jsonResponse(invalidResponse);
    assert.equal(invalidBody.error.code, API_V1_ERROR_CODES.INVALID_ARGUMENT);
    assert.equal(invalidBody.error.requestId, "req_contract_invalid");
    assert.doesNotMatch(JSON.stringify(invalidBody), new RegExp(sensitiveInput));
    assert.ok(invalidBody.error.details.length <= 8);
    assert.ok(
      invalidBody.error.details.every((detail: { path: string }) =>
        ["body", "amount", "amount.amount", "resourceId", "occurredAt", "page"].includes(detail.path),
      ),
    );

    const missingKeyResponse = await fetch(`${baseUrl}/api/v1/contracts/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Request-Id": "req_missing_key" },
      body: JSON.stringify(VALID_REQUEST),
    });
    assert.equal(missingKeyResponse.status, 400);
    const missingKeyBody = await jsonResponse(missingKeyResponse);
    assert.equal(missingKeyBody.error.code, API_V1_ERROR_CODES.MISSING_IDEMPOTENCY_KEY);
    assert.equal(missingKeyBody.error.requestId, "req_missing_key");
  } finally {
    await app.close();
  }
});

test("API v1 request IDs and unknown errors are safe", async () => {
  const app = await startContractProbe();
  try {
    const baseUrl = await app.getUrl();
    const response = await fetch(`${baseUrl}/api/v1/contracts/failure`, {
      headers: { "X-Request-Id": "../../do-not-echo" },
    });
    assert.equal(response.status, 500);
    const body = await jsonResponse(response);
    assert.equal(body.error.code, API_V1_ERROR_CODES.INTERNAL_ERROR);
    assert.equal(body.error.message, "Internal server error");
    assert.match(body.error.requestId, /^req_[A-Za-z0-9-]+$/);
    assert.doesNotMatch(JSON.stringify(body), /private provider response/);
    assert.notEqual(body.error.requestId, "../../do-not-echo");

    const mappedStatuses = [
      ["unauthenticated", 401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required"],
      ["forbidden", 403, API_V1_ERROR_CODES.FORBIDDEN, "Access denied"],
      ["rate-limited", 429, API_V1_ERROR_CODES.RATE_LIMITED, "Too many requests"],
    ] as const;
    for (const [route, status, code, message] of mappedStatuses) {
      const mappedResponse = await fetch(`${baseUrl}/api/v1/contracts/${route}`, {
        headers: { "X-Request-Id": `req_${route}` },
      });
      assert.equal(mappedResponse.status, status);
      const mappedBody = await jsonResponse(mappedResponse);
      assert.equal(mappedBody.error.code, code);
      assert.equal(mappedBody.error.message, message);
      assert.equal(mappedBody.error.requestId, `req_${route}`);
      assert.doesNotMatch(JSON.stringify(mappedBody), /private (authentication|authorization|rate) detail/);
    }
  } finally {
    await app.close();
  }
});

test("RFC3339 subset validates calendar, leap years, clock and offset ranges", () => {
  assert.equal(
    validateApiV1ContractRequest({ ...VALID_REQUEST, resourceId: "1e3", occurredAt: "2024-02-29T23:59:59+23:59" }).length,
    0,
  );
  for (const occurredAt of [
    "2026-02-29T12:30:00Z",
    "2026-02-30T12:30:00Z",
    "2026-04-31T12:30:00Z",
    "2026-09-10T24:00:00Z",
    "2026-09-10T12:60:00Z",
    "2026-09-10T12:30:00+24:00",
  ]) {
    assert.ok(validateApiV1ContractRequest({ ...VALID_REQUEST, occurredAt }).some((issue) => issue.path === "occurredAt"));
  }
});

test("idempotency scope and request fingerprint semantics are explicit", () => {
  const scope = idempotencyScopeKey({
    principalId: "principal_123",
    operation: "contract.validate",
    resourceId: "account_123",
  });
  const current = { scopeKey: scope, key: "idem_123", requestFingerprint: "sha256:a" };
  assert.equal(resolveIdempotencyDecision(current), "new");
  assert.equal(resolveIdempotencyDecision(current, current), "replay");
  assert.equal(
    resolveIdempotencyDecision(current, { ...current, requestFingerprint: "sha256:b" }),
    "conflict",
  );
  assert.equal(
    resolveIdempotencyDecision(current, {
      ...current,
      scopeKey: idempotencyScopeKey({ principalId: "principal_456", operation: "contract.validate" }),
    }),
    "new",
  );
});
