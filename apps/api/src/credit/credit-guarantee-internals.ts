import { createHash } from "node:crypto";

import { canonicalize } from "../supply/content-hash";
import { invalid } from "../supply/supply-util";

export const CREDIT_INITIAL_SCORE = 100;
export const CREDIT_BREACH_DELTA = -10;
export const CREDIT_RECOVERY_DELTA = 10;
export const CREDIT_GUARANTEE_THRESHOLD = 80;
export const CREDIT_RECOVERY_DAYS = 7;
export const CREDIT_GUARANTEE_CAP_CENTS = 10_000n;

export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT = /^.{2,500}$/su;

export function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

export function reason(value: unknown, label: string): string {
  if (typeof value !== "string" || !TEXT.test(value) || value.trim().length < 2) throw invalid(`${label} is invalid`);
  return value.trim();
}

export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
