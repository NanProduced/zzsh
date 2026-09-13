export type Decimal = { value: bigint; scale: number };

export function formatDecimalExact(value: Decimal): string {
  return value.scale === 0 ? value.value.toString() : formatScaledInteger(value.value, value.scale).replace(/\.?0+$/, "");
}

export class DecimalError extends Error {}

const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const SIGNED_DECIMAL = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/;

function parse(text: string, pattern: RegExp, maxScale: number, label: string): Decimal {
  const match = pattern.exec(text);
  if (!match) throw new DecimalError(`${label} is not a plain decimal string`);
  const negative = text.startsWith("-");
  const fraction = match[2] ?? "";
  if (fraction.length > maxScale) throw new DecimalError(`${label} exceeds ${maxScale} decimal places`);
  const combined = `${match[1]}${fraction}`;
  const value = BigInt(combined) * (negative ? -1n : 1n);
  if (value === 0n && negative) throw new DecimalError(`${label} must not be negative zero`);
  return { value, scale: fraction.length };
}

export function parseNonNegativeDecimal(text: string, maxScale: number, label: string): Decimal {
  return parse(text, UNSIGNED_DECIMAL, maxScale, label);
}

export function parseSignedDecimal(text: string, maxScale: number, label: string): Decimal {
  return parse(text, SIGNED_DECIMAL, maxScale, label);
}

export function decimalToBigInt(value: Decimal, targetScale: number): bigint {
  if (value.scale === targetScale) return value.value;
  if (value.scale < targetScale) return value.value * 10n ** BigInt(targetScale - value.scale);
  const divisor = 10n ** BigInt(value.scale - targetScale);
  const remainder = value.value % divisor;
  if (remainder !== 0n) throw new DecimalError("decimal cannot be represented at the target scale");
  return value.value / divisor;
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { value: decimalToBigInt(left, scale) + decimalToBigInt(right, scale), scale };
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { value: decimalToBigInt(left, scale) - decimalToBigInt(right, scale), scale };
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  return { value: left.value * right.value, scale: left.scale + right.scale };
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new DecimalError("denominator must be positive");
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** Rounds a rational value to `targetScale`, half away from zero. Rejects non-finite results. */
export function divideToScale(numerator: Decimal, denominator: Decimal, targetScale: number): Decimal {
  if (denominator.value === 0n) throw new DecimalError("denominator must not be zero");
  const numeratorScale = numerator.scale;
  const denominatorScale = denominator.scale;
  const exponent = BigInt(targetScale + denominatorScale - numeratorScale);
  const scaled = exponent >= 0n ? numerator.value * 10n ** exponent : numerator.value;
  const divisor = exponent >= 0n ? denominator.value : denominator.value * 10n ** -exponent;
  return { value: roundHalfUp(scaled, divisor), scale: targetScale };
}

export function formatDecimalAtScale(value: Decimal, targetScale: number): string {
  const integer = decimalToBigInt(value, targetScale);
  return formatScaledInteger(integer, targetScale);
}

export function formatScaledInteger(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  if (scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const divisor = 10n ** BigInt(scale);
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new DecimalError("denominator must be positive");
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function yuanAmountObject(cents: bigint): { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 } {
  return { currency: "CNY", unit: "yuan", amount: formatScaledInteger(cents, 2), scale: 2 };
}
