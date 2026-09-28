import { randomUUID } from "node:crypto";

import {
  ArgumentMetadata,
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  NestInterceptor,
  PipeTransform,
  CallHandler,
} from "@nestjs/common";
import {
  ApiProperty,
  ApiPropertyOptional,
} from "@nestjs/swagger";

export const API_V1_ERROR_CODES = {
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  MISSING_IDEMPOTENCY_KEY: "MISSING_IDEMPOTENCY_KEY",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  UNSUPPORTED_GAME_SERVICE: "UNSUPPORTED_GAME_SERVICE",
  OCCUPIED: "OCCUPIED",
  RULE_CHANGED: "RULE_CHANGED",
  VERSION_CHANGED: "VERSION_CHANGED",
  DEPOSIT_UNCONFIGURED: "DEPOSIT_UNCONFIGURED",
  PRICING_SCHEMA_UNSUPPORTED: "PRICING_SCHEMA_UNSUPPORTED",
  CONFIRMATION_INVALID: "CONFIRMATION_INVALID",
  CONFIRMATION_USED: "CONFIRMATION_USED",
  LISTING_QUERY_UNAVAILABLE: "LISTING_QUERY_UNAVAILABLE",
  CONFIRMATION_CHANGED: "CONFIRMATION_CHANGED",
  CONFIRMATION_EXPIRED: "CONFIRMATION_EXPIRED",
  CONFIRMATION_SIGNING_UNAVAILABLE: "CONFIRMATION_SIGNING_UNAVAILABLE",
  CONFIRMATION_DEPENDENCY_UNAVAILABLE: "CONFIRMATION_DEPENDENCY_UNAVAILABLE",
  EVIDENCE_UNAVAILABLE: "EVIDENCE_UNAVAILABLE",
  MEMBERSHIP_UNKNOWN: "MEMBERSHIP_UNKNOWN",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  IM_UNAVAILABLE: "IM_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export const API_V1_TOKEN_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";

export type ApiV1ErrorCode = (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES];

export type ApiV1ErrorDetailCode =
  | "INVALID_BODY"
  | "REQUIRED_FIELD"
  | "INVALID_FIELD"
  | "UNKNOWN_FIELD";

export type ApiV1ErrorDetail = {
  path: string;
  code: ApiV1ErrorDetailCode;
};

export type ApiV1ErrorBody = {
  error: {
    code: ApiV1ErrorCode;
    message: string;
    requestId: string;
    details?: readonly ApiV1ErrorDetail[];
  };
};

export class ApiV1ErrorDetailDto {
  @ApiProperty({ example: "amount.amount" })
  path!: string;

  @ApiProperty({
    enum: ["INVALID_BODY", "REQUIRED_FIELD", "INVALID_FIELD", "UNKNOWN_FIELD"],
    example: "INVALID_FIELD",
  })
  code!: ApiV1ErrorDetailCode;
}

export class ApiV1ErrorDto {
  @ApiProperty({ enum: Object.values(API_V1_ERROR_CODES), example: "INVALID_ARGUMENT" })
  code!: ApiV1ErrorCode;

  @ApiProperty({ example: "Request validation failed" })
  message!: string;

  @ApiProperty({ example: "req_contract_001" })
  requestId!: string;

  @ApiPropertyOptional({ type: [ApiV1ErrorDetailDto] })
  details?: ApiV1ErrorDetailDto[];
}

export class ApiV1ErrorResponseDto {
  @ApiProperty({ type: ApiV1ErrorDto })
  error!: ApiV1ErrorDto;
}

export class ApiV1MoneyDto {
  @ApiProperty({ enum: ["CNY"], example: "CNY" })
  currency!: "CNY";

  @ApiProperty({ enum: ["yuan"], example: "yuan" })
  unit!: "yuan";

  @ApiProperty({ example: "123.45", pattern: "^(0|[1-9]\\d*)\\.\\d{2}$" })
  amount!: string;

  @ApiProperty({ example: 2, minimum: 2, maximum: 2 })
  scale!: 2;
}

export class ApiV1PageRequestDto {
  @ApiPropertyOptional({ example: "cursor_001", pattern: API_V1_TOKEN_PATTERN, minLength: 1, maxLength: 128 })
  cursor?: string;

  @ApiPropertyOptional({ type: "integer", example: 20, minimum: 1, maximum: 100, default: 20 })
  limit?: number;
}

export class ApiV1ContractRequestDto {
  @ApiProperty({
    example: "account_123",
    pattern: API_V1_TOKEN_PATTERN,
    minLength: 1,
    maxLength: 128,
  })
  resourceId!: string;

  @ApiProperty({ type: ApiV1MoneyDto })
  amount!: ApiV1MoneyDto;

  @ApiProperty({ example: "2026-09-10T12:30:00+08:00", format: "date-time" })
  occurredAt!: string;

  @ApiPropertyOptional({ type: ApiV1PageRequestDto })
  page?: ApiV1PageRequestDto;
}

export class ApiV1PageResponseDto {
  @ApiProperty({ type: [String], example: ["account_123"] })
  items!: string[];

  @ApiProperty({ type: String, nullable: true, example: null })
  nextCursor!: string | null;

  @ApiProperty({ example: 20 })
  limit!: number;
}

export class ApiV1ContractResponseDto {
  @ApiProperty({ example: "account_123" })
  id!: string;

  @ApiProperty({ type: ApiV1MoneyDto })
  amount!: ApiV1MoneyDto;

  @ApiProperty({ example: "2026-09-10T12:30:00+08:00", format: "date-time" })
  occurredAt!: string;

  @ApiProperty({ type: ApiV1PageResponseDto })
  page!: ApiV1PageResponseDto;
}

export class ApiV1HttpException extends HttpException {
  constructor(
    status: number,
    readonly code: ApiV1ErrorCode,
    readonly safeMessage: string,
    readonly details?: readonly ApiV1ErrorDetail[],
  ) {
    super(safeMessage, status);
  }
}

const TOKEN_PATTERN = new RegExp(API_V1_TOKEN_PATTERN);
const MONEY_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const OFFSET_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_ERROR_DETAILS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function isOffsetDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = OFFSET_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!offsetText) return false;
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (offsetText !== "Z") {
    const offset = offsetText.match(/^[+-](\d{2}):(\d{2})$/);
    if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function addIssue(
  issues: ApiV1ErrorDetail[],
  path: string,
  code: ApiV1ErrorDetailCode,
): void {
  if (issues.length >= MAX_ERROR_DETAILS) return;
  if (!issues.some((issue) => issue.path === path && issue.code === code)) {
    issues.push({ path, code });
  }
}

function validateMoney(value: unknown, issues: ApiV1ErrorDetail[]): void {
  if (!isRecord(value)) {
    addIssue(issues, "amount", "INVALID_FIELD");
    return;
  }
  const knownFields = new Set(["currency", "unit", "amount", "scale"]);
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) addIssue(issues, "amount", "UNKNOWN_FIELD");
  }
  if (value.currency !== "CNY") addIssue(issues, "amount.currency", "INVALID_FIELD");
  if (value.unit !== "yuan") addIssue(issues, "amount.unit", "INVALID_FIELD");
  if (typeof value.amount !== "string" || !MONEY_PATTERN.test(value.amount)) {
    addIssue(issues, "amount.amount", "INVALID_FIELD");
  }
  if (value.scale !== 2) addIssue(issues, "amount.scale", "INVALID_FIELD");
}

function validatePage(value: unknown, issues: ApiV1ErrorDetail[]): void {
  if (!isRecord(value)) {
    addIssue(issues, "page", "INVALID_FIELD");
    return;
  }
  const knownFields = new Set(["cursor", "limit"]);
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) addIssue(issues, "page", "UNKNOWN_FIELD");
  }
  if (value.cursor !== undefined && !isToken(value.cursor)) {
    addIssue(issues, "page.cursor", "INVALID_FIELD");
  }
  if (
    value.limit !== undefined &&
    (typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 100)
  ) {
    addIssue(issues, "page.limit", "INVALID_FIELD");
  }
}

export function validateApiV1ContractRequest(value: unknown): ApiV1ErrorDetail[] {
  if (!isRecord(value)) return [{ path: "$", code: "INVALID_BODY" }];
  const issues: ApiV1ErrorDetail[] = [];
  const knownFields = new Set(["resourceId", "amount", "occurredAt", "page"]);
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) addIssue(issues, "body", "UNKNOWN_FIELD");
  }
  if (!isToken(value.resourceId)) addIssue(issues, "resourceId", "INVALID_FIELD");
  if (value.amount === undefined) addIssue(issues, "amount", "REQUIRED_FIELD");
  else validateMoney(value.amount, issues);
  if (!isOffsetDateTime(value.occurredAt)) addIssue(issues, "occurredAt", "INVALID_FIELD");
  if (value.page !== undefined) validatePage(value.page, issues);
  return issues;
}

export class ApiV1ContractValidationPipe
  implements PipeTransform<unknown, ApiV1ContractRequestDto>
{
  transform(value: unknown, _metadata: ArgumentMetadata): ApiV1ContractRequestDto {
    const issues = validateApiV1ContractRequest(value);
    if (issues.length > 0) {
      throw new ApiV1HttpException(
        400,
        API_V1_ERROR_CODES.INVALID_ARGUMENT,
        "Request validation failed",
        issues,
      );
    }
    return value as ApiV1ContractRequestDto;
  }
}

export function validateIdempotencyKey(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    throw new ApiV1HttpException(
      400,
      API_V1_ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
      "Idempotency-Key is required",
    );
  }
  if (!isToken(value)) {
    throw new ApiV1HttpException(
      400,
      API_V1_ERROR_CODES.INVALID_ARGUMENT,
      "Request validation failed",
      [{ path: "Idempotency-Key", code: "INVALID_FIELD" }],
    );
  }
  return value;
}

export type ApiV1IdempotencyScope = {
  principalId: string;
  operation: string;
  resourceId?: string;
};

export type ApiV1IdempotencyRecord = {
  scopeKey: string;
  key: string;
  requestFingerprint: string;
};

export type ApiV1IdempotencyDecision = "new" | "replay" | "conflict";

export function idempotencyScopeKey(scope: ApiV1IdempotencyScope): string {
  if (!isToken(scope.principalId) || !isToken(scope.operation)) {
    throw new Error("invalid idempotency scope");
  }
  if (scope.resourceId !== undefined && !isToken(scope.resourceId)) {
    throw new Error("invalid idempotency scope");
  }
  return JSON.stringify([scope.principalId, scope.operation, scope.resourceId ?? null]);
}

export function resolveIdempotencyDecision(
  current: ApiV1IdempotencyRecord,
  existing?: ApiV1IdempotencyRecord,
): ApiV1IdempotencyDecision {
  if (!existing) return "new";
  if (existing.scopeKey !== current.scopeKey || existing.key !== current.key) return "new";
  return existing.requestFingerprint === current.requestFingerprint ? "replay" : "conflict";
}

type RequestWithApiId = {
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

type ResponseLike = {
  status: (code: number) => ResponseLike;
  setHeader: (name: string, value: string) => void;
  json: (body: ApiV1ErrorBody) => void;
};

const REQUEST_ID_PROPERTY = "__zzshApiV1RequestId";

function requestIdHeader(request: RequestWithApiId): string | undefined {
  const header = request.headers?.["x-request-id"];
  return typeof header === "string" && isToken(header) ? header : undefined;
}

export function ensureApiV1RequestId(request: RequestWithApiId): string {
  const existing = request[REQUEST_ID_PROPERTY];
  if (typeof existing === "string" && isToken(existing)) return existing;
  const requestId = requestIdHeader(request) ?? `req_${randomUUID().replaceAll("-", "")}`;
  request[REQUEST_ID_PROPERTY] = requestId;
  return requestId;
}

export class ApiV1RequestIdInterceptor implements NestInterceptor {
  intercept(context: ArgumentsHost, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithApiId>();
    const response = http.getResponse<ResponseLike>();
    response.setHeader("X-Request-Id", ensureApiV1RequestId(request));
    return next.handle();
  }
}

function fallbackErrorCode(status: number): ApiV1ErrorCode {
  if (status === 401) return API_V1_ERROR_CODES.UNAUTHENTICATED;
  if (status === 403) return API_V1_ERROR_CODES.FORBIDDEN;
  if (status === 404) return API_V1_ERROR_CODES.NOT_FOUND;
  if (status === 409) return API_V1_ERROR_CODES.CONFLICT;
  if (status === 429) return API_V1_ERROR_CODES.RATE_LIMITED;
  if (status >= 400 && status < 500) return API_V1_ERROR_CODES.INVALID_ARGUMENT;
  return API_V1_ERROR_CODES.INTERNAL_ERROR;
}

function fallbackErrorMessage(status: number): string {
  if (status === 401) return "Authentication required";
  if (status === 403) return "Access denied";
  if (status === 404) return "Resource not found";
  if (status === 409) return "Request conflicts with current state";
  if (status === 429) return "Too many requests";
  if (status >= 400 && status < 500) return "Request rejected";
  return "Internal server error";
}

@Catch()
export class ApiV1ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithApiId>();
    const response = http.getResponse<ResponseLike>();
    const requestId = ensureApiV1RequestId(request);
    let status = 500;
    let code: ApiV1ErrorCode = API_V1_ERROR_CODES.INTERNAL_ERROR;
    let message = "Internal server error";
    let details: readonly ApiV1ErrorDetail[] | undefined;

    if (exception instanceof ApiV1HttpException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.safeMessage;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = fallbackErrorCode(status);
      message = fallbackErrorMessage(status);
    }

    response.status(status).setHeader("X-Request-Id", requestId);
    response.json({
      error: {
        code,
        message,
        requestId,
        ...(details && details.length > 0 ? { details } : {}),
      },
    });
  }
}
