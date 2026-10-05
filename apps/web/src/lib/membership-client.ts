const TIERS = ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER", "UNKNOWN"] as const;

export type MembershipTier = (typeof TIERS)[number];

export type MembershipBenefitPolicy = {
  version: string;
  scope: "DELTA_ACCOUNT_RENTAL";
  scopeLabel: string;
  tenantDeposit: Record<Exclude<MembershipTier, "UNKNOWN">, "ACCOUNT_BASE" | "WAIVED">;
  resourcePrice: "PERSONAL_QUOTE";
  validity: "UNKNOWN";
  acquisition: "UNKNOWN";
  notice: string;
};
export type MembershipSnapshot = { tier: MembershipTier; version: string; benefitPolicy: MembershipBenefitPolicy | null };

/** Invalid/old policy is unavailable; it must not discard a separately valid qualification. */
export function parseMembershipBenefitPolicy(value: unknown): MembershipBenefitPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const deposits = p.tenantDeposit;
  if (!deposits || typeof deposits !== "object" || Array.isArray(deposits)) return null;
  const d = deposits as Record<string, unknown>;
  if (typeof p.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.version)
    || p.scope !== "DELTA_ACCOUNT_RENTAL" || typeof p.scopeLabel !== "string" || !p.scopeLabel.trim() || p.scopeLabel.length > 100
    || p.resourcePrice !== "PERSONAL_QUOTE" || p.validity !== "UNKNOWN" || p.acquisition !== "UNKNOWN"
    || typeof p.notice !== "string" || !p.notice.trim() || p.notice.length > 500
    || d.STANDARD !== "ACCOUNT_BASE" || d.DISCOUNT_USER !== "ACCOUNT_BASE" || d.VIP !== "WAIVED" || d.SVIP !== "WAIVED") return null;
  return { version: p.version, scope: p.scope, scopeLabel: p.scopeLabel,
    tenantDeposit: { STANDARD: d.STANDARD, VIP: d.VIP, SVIP: d.SVIP, DISCOUNT_USER: d.DISCOUNT_USER },
    resourcePrice: p.resourcePrice, validity: p.validity, acquisition: p.acquisition, notice: p.notice };
}

type ErrorBody = { error?: { code?: unknown; message?: unknown; requestId?: unknown } };

export class MembershipRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: unknown) {
    const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as ErrorBody).error : undefined;
    super(typeof payload?.message === "string" ? payload.message : "会员等级暂时无法读取");
    this.name = "MembershipRequestError";
    this.status = status;
    this.code = typeof payload?.code === "string" ? payload.code : status === 0 ? "NETWORK_ERROR" : "INTERNAL_ERROR";
  }
}

function isTier(value: string): value is MembershipTier {
  return (TIERS as readonly string[]).includes(value);
}

/** Qualification and public benefit policy are read together with independent versions. */
export async function readMyMembership(signal?: AbortSignal): Promise<MembershipSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/account/rental-membership", { credentials: "same-origin", cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MembershipRequestError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  if (!response.ok || body === null) throw new MembershipRequestError(body === null && response.ok ? 502 : response.status, body);
  const membership = body.membership;
  const tier = membership && typeof membership === "object" ? membership.tier : undefined;
  const version = membership && typeof membership === "object" ? membership.version : undefined;
  if (typeof tier !== "string" || !isTier(tier) || typeof version !== "string" || !/^(0|[1-9]\d{0,18})$/.test(version)) {
    throw new MembershipRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "会员等级暂未由服务端提供" } });
  }
  return { tier, version, benefitPolicy: parseMembershipBenefitPolicy(body.benefitPolicy) };
}
