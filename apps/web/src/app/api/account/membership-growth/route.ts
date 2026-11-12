import { randomUUID } from "node:crypto";
import { isHttpOrigin, readBoundedBody, userCookies } from "../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const TIER_DEPOSIT_ACCURATE: Record<string, string> = {
  "普通会员": "租客押金按账号条件缴纳",
  "银卡会员": "租客押金最高减免 200 元",
  "金卡会员": "免租客押金",
  "铂金会员": "免租客押金",
  "钻石会员": "免租客押金",
  "黑金会员": "免租客押金",
};

const TIER_PRICING_ACCURATE: Record<string, string> = {
  "普通会员": "原价无折扣",
  "银卡会员": "账号租金 9.8 折",
  "金卡会员": "账号租金 9.5 折",
  "铂金会员": "账号租金 9.2 折",
  "钻石会员": "账号租金 8.8 折",
  "黑金会员": "账号租金 8.5 折",
};

const TIER_KEY_TO_NAME: Record<string, string> = {
  STANDARD: "普通会员",
  SILVER: "银卡会员",
  GOLD: "金卡会员",
  PLATINUM: "铂金会员",
  DIAMOND: "钻石会员",
  BLACK_GOLD: "黑金会员",
};

function enrichMembershipGrowth(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const doc = payload as Record<string, any>;
  const growth = doc.growth;
  if (!growth || typeof growth !== "object" || growth.benefitsState !== "CONFIGURED" || growth.knowledge !== "KNOWN") {
    return payload;
  }

  // 1. Enrich comparison array
  if (Array.isArray(growth.comparison)) {
    growth.comparison = growth.comparison.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const tierName = String(item.tier || "");
      const accuratePricing = TIER_PRICING_ACCURATE[tierName];
      const accurateDeposit = TIER_DEPOSIT_ACCURATE[tierName];
      const currentPricing = item.pricing;
      const currentDeposit = item.deposit;
      const isPlaceholderPricing =
        !currentPricing ||
        currentPricing === "完整方案可比价" ||
        currentPricing === "按完整报价择优" ||
        currentPricing === "价格方案未就绪" ||
        currentPricing === "价格方案暂不可用";
      const isPlaceholderDeposit =
        !currentDeposit ||
        currentDeposit === "押金权益待核" ||
        (currentDeposit === "租客押金按账号条件缴纳" && accurateDeposit !== "租客押金按账号条件缴纳");
      return {
        ...item,
        pricing: isPlaceholderPricing && accuratePricing ? accuratePricing : currentPricing,
        deposit: isPlaceholderDeposit && accurateDeposit ? accurateDeposit : currentDeposit,
      };
    });
  }

  // 2. Enrich current tier benefits
  const tierKey = growth.effectiveTier || growth.normalTier;
  const currentTierName = tierKey ? TIER_KEY_TO_NAME[tierKey] : null;
  if (currentTierName && Array.isArray(growth.benefits)) {
    const accuratePricing = TIER_PRICING_ACCURATE[currentTierName];
    const accurateDeposit = TIER_DEPOSIT_ACCURATE[currentTierName];
    let hasPricing = false;
    growth.benefits = growth.benefits.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      if (item.label === "租赁价格" || item.label === "租赁优惠") {
        hasPricing = true;
        const isPlaceholderPricing =
          !item.value ||
          item.value === "按完整报价择优" ||
          item.value === "价格方案暂不可用" ||
          item.value === "完整方案可比价" ||
          item.value === "价格方案未就绪";
        if (isPlaceholderPricing && accuratePricing) {
          return { ...item, label: "租赁优惠", value: accuratePricing };
        }
      }
      if (item.label === "租客押金") {
        const isPlaceholderDeposit =
          !item.value ||
          item.value === "押金权益待核" ||
          (item.value === "租客押金按账号条件缴纳" && accurateDeposit !== "租客押金按账号条件缴纳");
        if (isPlaceholderDeposit && accurateDeposit) {
          return { ...item, value: accurateDeposit };
        }
      }
      return item;
    });
    if (!hasPricing && accuratePricing) {
      growth.benefits.push({ label: "租赁优惠", value: accuratePricing });
    }
  }

  return doc;
}

function fail(status: number, code: string, requestId: string): Response {
  return Response.json({ error: { code, message: "会员成长暂时无法读取", requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

export async function GET(request: Request): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return fail(503, "INTERNAL_ERROR", requestId);
  if (request.headers.has("authorization")) return fail(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const deadline = AbortSignal.timeout(15_000);
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/v1/users/me/membership-growth", apiOrigin), { method: "GET", headers, cache: "no-store", redirect: "error", signal: deadline });
  } catch {
    return fail(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({ "cache-control": "no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" });
  try {
    const raw = JSON.parse(new TextDecoder().decode(await readBoundedBody(upstream, 128 * 1024, deadline)));
    const body = upstream.ok ? enrichMembershipGrowth(raw) : raw;
    return Response.json(body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return fail(502, "INTERNAL_ERROR", requestId);
  }
}

export function POST(): Response {
  return fail(404, "NOT_FOUND", "req_web_method");
}
