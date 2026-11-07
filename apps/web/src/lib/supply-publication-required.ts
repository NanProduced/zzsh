import type { DraftInput, PublishingOptions } from "./supply-types";

/**
 * New-account publication facts required by the old-site form and the current server
 * publication validation. Historic takeover drafts may carry a verified legacy source
 * reference; their missing facts stay governed by the server's legacy path.
 */
export type PublicationRequiredProblem = { field: string; message: string; target: string };
type Attributes = DraftInput["attributes"];
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const fallbackDivisions = (code: string): number[] => ["2", "3", "4", "5", "6", "7"].includes(code) ? [3, 2, 1] : [];

export function requiredAccountFactsProblem(attributes: Attributes, options: PublishingOptions | null): PublicationRequiredProblem | null {
  if (text(attributes.legacy_published_reference)) return null;
  if (!text(attributes.safe_box_code))
    return { field: "attributes.safe_box_code", message: "请选择安全箱档位。", target: "publish-attribute-safe-box" };
  const gradingCode = text(attributes.grading_code);
  if (!gradingCode)
    return { field: "attributes.grading_code", message: "请选择账号段位。", target: "publish-attribute-grading" };
  const grading = options?.gradingOptions?.find(option => option.code === gradingCode) as { divisions?: number[] } | undefined;
  if (options?.gradingOptions?.length && !grading)
    return { field: "attributes.grading_code", message: "请选择有效账号段位。", target: "publish-attribute-grading" };
  const divisions = grading?.divisions ?? fallbackDivisions(gradingCode);
  if (divisions.length && !Number.isSafeInteger(attributes.grading_division))
    return { field: "attributes.grading_division", message: "请补齐小段位。", target: "publish-attribute-grading" };
  if (grading?.divisions && attributes.grading_division != null && !grading.divisions.includes(attributes.grading_division as number))
    return { field: "attributes.grading_division", message: "请选择与账号段位匹配的小段位。", target: "publish-attribute-grading" };
  if (!integer(attributes.character_level, 0, 60))
    return { field: "attributes.character_level", message: "请填写0–60的账号等级。", target: "publish-character-level" };
  const kd = typeof attributes.secret_kd === "number" ? String(attributes.secret_kd) : text(attributes.secret_kd);
  if (!kd || !/^\d+(?:\.\d+)?$/.test(kd) || Number(kd) > 100)
    return { field: "attributes.secret_kd", message: "请填写0–100的绝密KD。", target: "publish-secret-kd" };
  if (!integer(attributes.vit_level, 4, 7))
    return { field: "attributes.vit_level", message: "请选择4–7级体力等级。", target: "publish-attribute-vit" };
  if (!integer(attributes.bear_level, 4, 7))
    return { field: "attributes.bear_level", message: "请选择4–7级负重等级。", target: "publish-attribute-bear" };
  if (!integer(attributes.dive_level, 0, 3))
    return { field: "attributes.dive_level", message: "请选择0–3级潜水等级。", target: "publish-attribute-dive" };
  const login = text(attributes.login_method_code);
  if (!login)
    return { field: "attributes.login_method_code", message: "请选择上号方式。", target: "publish-attribute-login" };
  if (options?.loginMethodOptions?.length && !options.loginMethodOptions.some(option => option.code === login))
    return { field: "attributes.login_method_code", message: "请选择有效上号方式。", target: "publish-attribute-login" };
  if (!text(attributes.region_province))
    return { field: "attributes.region_province", message: "请选择省份和城市。", target: "publish-region" };
  if (!text(attributes.region_city))
    return { field: "attributes.region_city", message: "请选择省份和城市。", target: "publish-region" };
  const start = attributes.service_window_start_minute, end = attributes.service_window_end_minute;
  if (!Number.isSafeInteger(start) || Number(start) < 0 || Number(start) > 1439 || !Number.isSafeInteger(end) || Number(end) < 0 || Number(end) > 1440 || end === start)
    return { field: "attributes.service_window_start_minute", message: "请选择完整的可配合上号时间，起止不能相同。", target: "publish-service-window" };
  if (attributes.service_window_timezone !== "Asia/Shanghai" || attributes.service_window_cross_midnight !== (Number(end) < Number(start)))
    return { field: "attributes.service_window_timezone", message: "请确认上号时段及跨日状态。", target: "publish-service-window" };
  if (typeof attributes.ban_record !== "boolean")
    return { field: "attributes.ban_record", message: "请选择封禁记录。", target: "publish-attribute-ban" };
  if (typeof attributes.face_is_self !== "boolean")
    return { field: "attributes.face_is_self", message: "请选择人脸归属。", target: "publish-attribute-face" };
  return null;
}
