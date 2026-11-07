import { randomInt } from "node:crypto";

export type UserVerificationChannel = "phone" | "email";
export const USER_SMS_CODE_LENGTH = 4;
const USER_EMAIL_CODE_LENGTH = 6;

export function isUserVerificationCode(channel: UserVerificationChannel, value: unknown): value is string {
  return typeof value === "string" && (channel === "phone" ? /^\d{4}$/ : /^\d{6}$/).test(value);
}

/** Only user contact challenges use this contract; admin TOTP and PIN are independent. */
export function makeUserVerificationCode(channel: UserVerificationChannel, localMock = false): string {
  const length = channel === "phone" ? USER_SMS_CODE_LENGTH : USER_EMAIL_CODE_LENGTH;
  if (localMock) return "8".repeat(length);
  return String(randomInt(0, 10 ** length)).padStart(length, "0");
}
