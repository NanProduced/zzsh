/**
 * 咨询请求体解析与校验：只把外部输入转成已校验契约，不写库、不发起云信调用。
 */

import {
  AVAILABILITY,
  CONNECTION_ID_PATTERN,
  CONNECTION_STATES,
  type ConsultationEntryIntent,
  ID_PATTERN,
  SUPPORT_TYPES,
  type SupportAvailability,
  type SupportConnectionState,
  type SupportType,
  invalid,
  isRecord,
} from "./consultation-internals";

export function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

export function parseSupportType(value: unknown): SupportType {
  if (typeof value !== "string" || !SUPPORT_TYPES.has(value as SupportType)) throw invalid("Support type is invalid");
  return value as SupportType;
}

export function parseSubjectRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid("Subject reference is invalid");
  return value;
}

export function parseConsultationBody(value: unknown): { type: SupportType; entryIntent: ConsultationEntryIntent; subjectRef: string | null } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  const allowed = new Set(["type", "subjectRef"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid("Request body contains an unknown field");
  const entryIntent = parseSupportType(value.type);
  // 投诉与业务咨询各自保留持久线程；入口意图只决定欢迎语，不再改写线程 kind。
  return { type: entryIntent, entryIntent, subjectRef: parseSubjectRef(value.subjectRef) };
}

export function parseConnectionIdBody(value: unknown): { connectionId: string } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "connectionId")) throw invalid("Request body contains an unknown field");
  if (typeof value.connectionId !== "string" || !CONNECTION_ID_PATTERN.test(value.connectionId)) throw invalid("Connection id is invalid");
  return { connectionId: value.connectionId };
}

export function parsePresenceHeartbeatBody(value: unknown): { connectionState: SupportConnectionState; stateRevision: number; connectionId: string } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "connectionState" && key !== "stateRevision" && key !== "connectionId")) throw invalid("Request body contains an unknown field");
  if (typeof value.connectionState !== "string" || !CONNECTION_STATES.has(value.connectionState as SupportConnectionState)) {
    throw invalid("Connection state is invalid");
  }
  if (!Number.isSafeInteger(value.stateRevision) || (value.stateRevision as number) < 1) throw invalid("Presence state revision is invalid");
  if (typeof value.connectionId !== "string" || !CONNECTION_ID_PATTERN.test(value.connectionId)) throw invalid("Connection id is invalid");
  return { connectionState: value.connectionState as SupportConnectionState, stateRevision: value.stateRevision as number, connectionId: value.connectionId };
}

export function parsePresenceBody(value: unknown): { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number; takeover?: boolean; connectionId?: string } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "availability" && key !== "connectionState" && key !== "version" && key !== "takeover" && key !== "connectionId")) throw invalid("Request body contains an unknown field");
  if (typeof value.availability !== "string" || !AVAILABILITY.has(value.availability as SupportAvailability)) throw invalid("Availability is invalid");
  if (typeof value.connectionState !== "string" || !CONNECTION_STATES.has(value.connectionState as SupportConnectionState)) throw invalid("Connection state is invalid");
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || (value.version as number) < 0)) throw invalid("Presence version is invalid");
  if (value.takeover !== undefined && typeof value.takeover !== "boolean") throw invalid("Presence takeover flag is invalid");
  if (value.connectionId !== undefined && (typeof value.connectionId !== "string" || !CONNECTION_ID_PATTERN.test(value.connectionId))) throw invalid("Connection id is invalid");
  return {
    availability: value.availability as SupportAvailability,
    connectionState: value.connectionState as SupportConnectionState,
    ...(value.version === undefined ? {} : { version: value.version as number }),
    ...(value.takeover === undefined ? {} : { takeover: value.takeover as boolean }),
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId as string }),
  };
}

/** 评价分值只接受 1..5 整数；文字可选，去首尾空白后按码点不超过 200。 */
export function parseSupportRatingBody(value: unknown): { score: number; comment: string | null } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "score" && key !== "comment")) throw invalid("Request body contains an unknown field");
  const score = value.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) throw invalid("Rating score is invalid");
  if (value.comment === undefined || value.comment === null) return { score, comment: null };
  if (typeof value.comment !== "string") throw invalid("Rating comment is invalid");
  const comment = value.comment.trim();
  if (!comment) return { score, comment: null };
  if ([...comment].length > 200) throw invalid("Rating comment is invalid");
  return { score, comment };
}

/** 用户主动结束本轮：客户端提供稳定的 operationId，重放返回同一结果。 */
export function parseUserCloseBody(value: unknown): { operationId: string } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "operationId")) throw invalid("Request body contains an unknown field");
  if (typeof value.operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value.operationId)) throw invalid("Invalid operation identity");
  return { operationId: value.operationId };
}
