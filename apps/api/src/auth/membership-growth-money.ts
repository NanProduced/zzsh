/** 时间、瞬间与金额。从 membership-growth 原样移出，判定不变。 */
import { normalizeTime } from "../supply/content-hash";

export const MEMBERSHIP_GROWTH_SCHEMA = "membership-growth-v1" as const;
export const GROWTH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** E-R3-02: every instant comparison in this model runs on epoch microseconds (PG timestamptz precision, safe integer). */
export const GROWTH_WINDOW_US = GROWTH_WINDOW_MS * 1000;
export const GRACE_WINDOW_US = GRACE_WINDOW_MS * 1000;

export class GrowthRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GrowthRuleError";
  }
}

export function fail(code: string, message: string): never {
  throw new GrowthRuleError(code, message);
}

/**
 * Parses an RFC3339 UTC instant with at most microsecond precision (shared normalizeTime) into epoch microseconds.
 * Millisecond and second inputs keep their old meaning; more than six fractional digits are rejected, never truncated.
 */
export function parseInstant(value: string, field: string): number {
  if (typeof value !== "string" || value.length < 20 || !value.endsWith("Z")) fail("INVALID_INSTANT", `${field} must be an RFC3339 UTC instant`);
  let canonical: string | null;
  try { canonical = normalizeTime(value); } catch { canonical = null; }
  if (!canonical) fail("INVALID_INSTANT", `${field} is invalid or exceeds microsecond precision`);
  const ms = Date.parse(`${canonical.slice(0, 23)}Z`);
  if (!Number.isFinite(ms)) fail("INVALID_INSTANT", `${field} is invalid`);
  const us = ms * 1000 + Number(canonical.slice(23, 26));
  if (!Number.isSafeInteger(us)) fail("INVALID_INSTANT", `${field} is outside the supported range`);
  return us;
}

/** Formats epoch microseconds; whole milliseconds keep the historical toISOString form (frozen v1–v3 facts unchanged). */
export function formatInstant(us: number): string {
  const ms = Math.floor(us / 1000);
  const iso = new Date(ms).toISOString();
  const sub = us - ms * 1000;
  return sub === 0 ? iso : `${iso.slice(0, 23)}${String(sub).padStart(3, "0")}Z`;
}

/** Canonical instant compare/format helpers shared with the integration layer (same microsecond model). */
export function growthInstantMicros(value: string): number {
  return parseInstant(value, "instant");
}
export function growthWindowStartAt(asOf: string): string {
  return formatInstant(parseInstant(asOf, "asOf") - GROWTH_WINDOW_US);
}

export function parseCents(value: string, field: string, signed = true): bigint {
  const pattern = signed ? /^-?(0|[1-9]\d{0,23})$/ : /^(0|[1-9]\d{0,23})$/;
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_AMOUNT", `${field} must be integer cents`);
  return BigInt(value);
}

/** A missing field is the immutable legacy zero allowance; malformed or conflicting benefits fail closed. */
export function parseDepositAllowanceCents(value: unknown, depositWaived: unknown = false): string {
  if (typeof depositWaived !== "boolean") fail("INVALID_AMOUNT", "depositWaived must be boolean");
  const allowance = value === undefined ? 0n : parseCents(value as string, "depositAllowanceCents", false);
  if (depositWaived && allowance !== 0n) fail("INVALID_AMOUNT", "A full waiver cannot carry a finite allowance");
  return allowance.toString();
}

export function tenantDepositAfterBenefit(baseCents: string | null, depositWaived: boolean, allowanceCents?: string): string | null {
  const allowance = BigInt(parseDepositAllowanceCents(allowanceCents, depositWaived));
  if (depositWaived) return "0";
  if (baseCents === null) return null;
  const base = parseCents(baseCents, "tenantDepositCents", false);
  return (base > allowance ? base - allowance : 0n).toString();
}

export function parseId(value: string, field: string, maxLength = 127): string {
  if (typeof value !== "string" || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail("INVALID_REFERENCE", `${field} is invalid`);
  return value;
}

export function parseMoneyCents(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) fail("INVALID_AMOUNT", `${field} must be yuan with at most two decimals`);
  const parts = value.split(".");
  const whole = parts[0]!;
  const fraction = parts[1] ?? "";
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

export function roundHalfUpCents(cents: bigint): bigint {
  const sign = cents < 0n ? -1n : 1n;
  const absolute = cents < 0n ? -cents : cents;
  return sign * ((absolute + 50n) / 100n);
}
