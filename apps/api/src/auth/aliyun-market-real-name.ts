import { ConfigurationError } from "../config/config";
import { normalizeIdentityDocument } from "./identity-subject";
import { verifiedMainlandAgeStatus } from "./aliyun-user-providers";
import type { RealNameProvider } from "./user-identity";

const provider = "aliyun-market-id2" as const;
const endpoint = "https://sfzybx.market.alicloudapi.com/idcard/verify";

/** Alibaba Cloud Marketplace product cmapi00071828; no request is made at construction. */
export function createAliyunMarketRealNameProvider(appCode: string, send: typeof fetch = fetch, clock: () => Date = () => new Date()): RealNameProvider {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(appCode)) throw new ConfigurationError("Valid identity marketplace AppCode is required");
  return { provider, available: true, async verify(input) {
    const document = normalizeIdentityDocument(input.documentNumber), name = input.fullName.trim().normalize("NFC");
    if (!/^\d{17}[0-9X]$/.test(document) || !name || name.length > 64 || /[\p{Cc}\p{Cs}]/u.test(name)) {
      return { status: "REJECTED", ageStatus: "UNKNOWN", provider, providerReference: null, reasonCode: "provider_rejected" };
    }
    try {
      const response = await send(endpoint, { method: "POST", headers: { Authorization: `APPCODE ${appCode}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams({ idcard: document, name }), redirect: "error", signal: AbortSignal.timeout(8000) });
      if (response.status !== 200) throw new Error();
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
      const body = payload as Record<string, unknown>, rawReference = body.requestid;
      const gatewayReference = response.headers.get("x-ca-request-id");
      const reference = rawReference === undefined || rawReference === null
        ? typeof gatewayReference === "string" && /^[A-Za-z0-9._:-]{1,248}$/.test(gatewayReference) ? `gateway:${gatewayReference}` : null
        : typeof rawReference === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(rawReference) ? rawReference : null;
      if ((body.code !== 200 && body.code !== "200") || !reference
        || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error();
      const result = (body.data as Record<string, unknown>).result;
      if (result === 1 || result === "1") return { status: "VERIFIED", ageStatus: verifiedMainlandAgeStatus(document, clock()), provider, providerReference: reference };
      if (result === 2 || result === "2") return { status: "REJECTED", ageStatus: "UNKNOWN", provider, providerReference: reference, reasonCode: "provider_rejected" };
      return { status: "UNKNOWN", ageStatus: "UNKNOWN", provider, providerReference: reference, reasonCode: "provider_unknown" };
    } catch {
      // Provider errors may contain the submitted identity or AppCode.
      throw new Error("REAL_NAME_DEPENDENCY_UNAVAILABLE");
    }
  } };
}
