/**
 * 当前公网 IP 读取（展示层专用，独立于认证/交易/风控）。
 * Owner 2026-10-14 批准：浏览器直连 ipify 公共接口，仅当前会话展示，不落后端、不代理、不作授权或风控依据。
 * 依据：https://www.ipify.org/ 、https://github.com/rdegges/ipify-api （README 声明免费集成，源码 MIT）。
 * 该接口只返回公网 IP，不返回地区/运营商；缺失字段不推断、不用示例值填充。
 */
const NETWORK_PROVIDER = "https://api64.ipify.org?format=json";
// 冷请求包含 DNS/TLS 开销；超时仅降级当前网络行。
const TIMEOUT_MS = 10_000;

type ProviderPayload = { ip?: unknown };
export type NetworkInfo = { ip: string };
export type NetworkInfoFailure = "timeout" | "rate-limited" | "unreachable" | "invalid";

export class NetworkInfoError extends Error {
  readonly reason: NetworkInfoFailure;
  constructor(reason: NetworkInfoFailure) {
    super("Network info unavailable");
    this.name = "NetworkInfoError";
    this.reason = reason;
  }
}

export const networkFailureCopy: Record<NetworkInfoFailure, string> = {
  timeout: "读取超时，当前网络信息暂时无法获取。",
  "rate-limited": "查询过于频繁，请稍后再试。",
  unreachable: "网络服务暂时不可达，当前网络信息暂时无法获取。",
  invalid: "返回的信息无法确认，当前网络信息暂时无法获取。",
};

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
function isIpLiteral(value: string): boolean {
  if (!value.includes(":")) return IPV4.test(value) && value.split(".").every(part => Number(part) <= 255 && String(Number(part)) === part);
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

/** 校验 IP 字面量格式；这不证明地址的公网可达性或可信性。 */
export function parseNetworkInfo(payload: unknown): NetworkInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const ip = (payload as ProviderPayload).ip;
  if (typeof ip !== "string") return null;
  const value = ip.trim();
  return isIpLiteral(value) ? { ip: value } : null;
}

export async function readNetworkInfo(): Promise<NetworkInfo> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(NETWORK_PROVIDER, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response.status === 429) throw new NetworkInfoError("rate-limited");
    if (!response.ok) throw new NetworkInfoError("unreachable");
    const info = parseNetworkInfo(await response.json());
    if (!info) throw new NetworkInfoError("invalid");
    return info;
  } catch (error) {
    if (error instanceof NetworkInfoError) throw error;
    if (signal.reason?.name === "TimeoutError" || error instanceof DOMException && error.name === "TimeoutError") throw new NetworkInfoError("timeout");
    if (error instanceof SyntaxError) throw new NetworkInfoError("invalid");
    throw new NetworkInfoError("unreachable");
  }
}
