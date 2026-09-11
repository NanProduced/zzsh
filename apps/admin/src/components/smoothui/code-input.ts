// Normalize copied separators before input-otp validates length and pattern.
// Backup codes are case-sensitive: never change their case.
export const normalizeCodePaste = (value: string): string => value.replace(/[\s-]/g, "");
