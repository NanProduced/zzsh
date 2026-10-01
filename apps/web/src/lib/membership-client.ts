const TIERS = ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER", "UNKNOWN"] as const;

export type MembershipTier = (typeof TIERS)[number];

export type MembershipSnapshot = { tier: MembershipTier; version: string };

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

/** Read-only self membership. The server returns tier and version; it does not return benefit copy. */
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
  return { tier, version };
}
