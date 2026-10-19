/**
 * 当前公网 IP 及网络出口信息读取（展示层专用，独立于认证/交易/风控）。
 * Specs 2026-10-16:
 * - 仅在用户主动查询时调用：优先查询 ipwho.is，直连浏览器无认证请求，获取公网 IP、IP 类型、近似地区、ISP、组织、ASN。
 * - 超时 4 秒。
 * - 成功快照 TTL 2 分钟。
 * - 若 429 / 额度耗尽：立即清除旧地区/ISP 等详细信息；最多调用一次已有 api64.ipify.org 兜底。
 *   - 若兜底成功：仅返回可靠 IP（IP-only），隐藏详细信息；
 *   - 若兜底失败/无 IP：抛出 rate-limited 错误，UI 提供手动重试。
 * - 429 冷却：遵守 Retry-After 头；无有效头时保守冷却 24 小时。
 * - 普通失败不设冷却：仅在用户再次主动查询时重试。
 * Owner 2026-10-17 确认：改用 ipwho.is 并展示近似地区/运营商/ASN（原 ipify 只返回 IP）为指定改动。
 */

export const IPWHOIS_PROVIDER = "https://ipwho.is/?fields=success,message,ip,type,country,country_code,region,city,connection.isp,connection.org,connection.asn&lang=zh-CN";
export const IPIFY_PROVIDER = "https://api64.ipify.org?format=json";

export const TIMEOUT_MS = 4_000;
export const CACHE_TTL_MS = 2 * 60 * 1000; // 2 分钟
export const RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 小时

export type NetworkDetails = {
  type?: string;
  location?: string;
  isp?: string;
  org?: string;
  asn?: string;
};

export type NetworkInfo = {
  ip: string;
  details?: NetworkDetails;
  queryTime?: string;
  isRateLimited?: boolean;
};

export type NetworkInfoFailure = "timeout" | "rate-limited" | "unreachable" | "invalid";

export class NetworkInfoError extends Error {
  readonly reason: NetworkInfoFailure;
  constructor(reason: NetworkInfoFailure) {
    super("Network info unavailable");
    this.name = "NetworkInfoError";
    this.reason = reason;
  }
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
export function isIpLiteral(value: string): boolean {
  if (!value.includes(":")) return IPV4.test(value) && value.split(".").every(part => Number(part) <= 255 && String(Number(part)) === part);
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

function formatQueryTime(date: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const hour = parts.find(p => p.type === "hour")?.value ?? "00";
    const minute = parts.find(p => p.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
  } catch {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

function parseRetryAfter(header: string | null | undefined): number {
  if (!header) return RATE_LIMIT_COOLDOWN_MS;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > Date.now()) {
    return dateMs - Date.now();
  }
  return RATE_LIMIT_COOLDOWN_MS;
}

let cachedRecord: { data: NetworkInfo; timestamp: number } | null = null;
let lastKnownIpRecord: { ip: string; timestamp: number } | null = null;
let rateLimitUntil = 0;
let inFlight: Promise<NetworkInfo> | null = null;

export function resetNetworkInfoCacheForTest() {
  cachedRecord = null;
  lastKnownIpRecord = null;
  rateLimitUntil = 0;
  inFlight = null;
}

/** 校验 IP 字面量并解析字段；若仅有基础 IP 则返回基础对象。 */
export function parseNetworkInfo(payload: unknown): NetworkInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const ip = typeof raw.ip === "string" ? raw.ip.trim() : null;
  if (!ip || !isIpLiteral(ip)) return null;

  const details: NetworkDetails = {};
  if (typeof raw.type === "string" && raw.type.trim()) details.type = raw.type.trim();

  const locParts = [raw.country, raw.region, raw.city]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(v => v.trim())
    .filter((v, idx, arr) => arr.indexOf(v) === idx);
  if (locParts.length > 0) details.location = locParts.join(" · ");

  const conn = raw.connection as Record<string, unknown> | undefined;
  if (conn && typeof conn === "object") {
    if (typeof conn.isp === "string" && conn.isp.trim()) details.isp = conn.isp.trim();
    if (typeof conn.org === "string" && conn.org.trim()) details.org = conn.org.trim();
    if (conn.asn !== undefined && conn.asn !== null && String(conn.asn).trim()) {
      const asnStr = String(conn.asn).trim();
      details.asn = asnStr.startsWith("AS") ? asnStr : `AS${asnStr}`;
    }
  }

  const hasDetails = Boolean(details.location || details.isp || details.org || details.asn || details.type);
  if (!hasDetails) {
    return { ip };
  }
  return {
    ip,
    details,
    queryTime: formatQueryTime(),
    isRateLimited: false,
  };
}

async function fetchIpifyFallback(): Promise<string | null> {
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(IPIFY_PROVIDER, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { ip?: unknown } | null;
    if (json && typeof json.ip === "string" && isIpLiteral(json.ip.trim())) {
      return json.ip.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function readNetworkInfo(): Promise<NetworkInfo> {
  const now = Date.now();
  if (cachedRecord && now - cachedRecord.timestamp < CACHE_TTL_MS) {
    return cachedRecord.data;
  }
  if (inFlight) return inFlight;

  const runner = (async () => {
    // 处于 429 额度冷却期
    if (now < rateLimitUntil) {
      if (lastKnownIpRecord && now - lastKnownIpRecord.timestamp < CACHE_TTL_MS) {
        return {
          ip: lastKnownIpRecord.ip,
          queryTime: formatQueryTime(),
          isRateLimited: true,
        };
      }
      const fallbackIp = await fetchIpifyFallback();
      if (fallbackIp) {
        lastKnownIpRecord = { ip: fallbackIp, timestamp: Date.now() };
        return {
          ip: fallbackIp,
          queryTime: formatQueryTime(),
          isRateLimited: true,
        };
      }
      throw new NetworkInfoError("rate-limited");
    }

    try {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetch(IPWHOIS_PROVIDER, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });

      if (response.status === 429) {
        const cooldown = parseRetryAfter(response.headers?.get?.("retry-after"));
        rateLimitUntil = Date.now() + cooldown;
        cachedRecord = null; // 立即清除详细缓存
        if (lastKnownIpRecord && Date.now() - lastKnownIpRecord.timestamp < CACHE_TTL_MS) {
          return {
            ip: lastKnownIpRecord.ip,
            queryTime: formatQueryTime(),
            isRateLimited: true,
          };
        }
        const fallbackIp = await fetchIpifyFallback();
        if (fallbackIp) {
          lastKnownIpRecord = { ip: fallbackIp, timestamp: Date.now() };
          return {
            ip: fallbackIp,
            queryTime: formatQueryTime(),
            isRateLimited: true,
          };
        }
        throw new NetworkInfoError("rate-limited");
      }

      if (!response.ok) {
        throw new NetworkInfoError("unreachable");
      }

      const json = (await response.json()) as Record<string, unknown> | null;
      if (json && typeof json === "object" && json.success === false) {
        const msg = String(json.message ?? "");
        if (/rate limit|exceeded|quota/i.test(msg)) {
          rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          cachedRecord = null;
          if (lastKnownIpRecord && Date.now() - lastKnownIpRecord.timestamp < CACHE_TTL_MS) {
            return { ip: lastKnownIpRecord.ip, queryTime: formatQueryTime(), isRateLimited: true };
          }
          const fallbackIp = await fetchIpifyFallback();
          if (fallbackIp) {
            lastKnownIpRecord = { ip: fallbackIp, timestamp: Date.now() };
            return { ip: fallbackIp, queryTime: formatQueryTime(), isRateLimited: true };
          }
          throw new NetworkInfoError("rate-limited");
        }
        throw new NetworkInfoError("invalid");
      }

      const info = parseNetworkInfo(json);
      if (!info) throw new NetworkInfoError("invalid");

      const completeInfo: NetworkInfo = {
        ...info,
        queryTime: info.queryTime || formatQueryTime(),
        isRateLimited: false,
      };

      lastKnownIpRecord = { ip: completeInfo.ip, timestamp: Date.now() };
      cachedRecord = { data: completeInfo, timestamp: Date.now() };
      return completeInfo;
    } catch (err) {
      if (err instanceof NetworkInfoError && err.reason === "rate-limited") throw err;

      // 普通失败：若已有未过期 IP 则降级为 IP-only
      if (lastKnownIpRecord && Date.now() - lastKnownIpRecord.timestamp < CACHE_TTL_MS) {
        return {
          ip: lastKnownIpRecord.ip,
          queryTime: formatQueryTime(),
          isRateLimited: false,
        };
      }

      if (err instanceof NetworkInfoError) throw err;
      if (err instanceof DOMException && err.name === "TimeoutError") throw new NetworkInfoError("timeout");
      if (err instanceof SyntaxError) throw new NetworkInfoError("invalid");
      throw new NetworkInfoError("unreachable");
    }
  })();

  inFlight = runner;
  try {
    return await runner;
  } finally {
    if (inFlight === runner) inFlight = null;
  }
}
