import { isIP } from "node:net";

/** BFF 写入、API 只在可信对端上读取。浏览器自带的同名头一律先删。 */
export const USER_CLIENT_IP_FORWARD_HEADER = "x-zzsh-user-client-ip";

export type UserClientIpConfig = {
  trustedProxies: readonly string[];
  header: "x-forwarded-for" | "x-real-ip";
};

export const DEFAULT_USER_CLIENT_IP_CONFIG: UserClientIpConfig = {
  trustedProxies: [],
  header: "x-forwarded-for",
};

const HEADERS = new Set(["x-forwarded-for", "x-real-ip"]);

export function normalizeClientIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let ip = value.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : undefined;
}

export function isLoopbackIp(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || (typeof ip === "string" && isIP(ip) === 4 && ip.startsWith("127."));
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function matchesEntry(ip: string, entry: string): boolean {
  if (entry === "loopback") return isLoopbackIp(ip);
  const [base, bits] = entry.split("/");
  if (bits === undefined) return normalizeClientIp(base) === ip;
  if (isIP(ip) !== 4 || isIP(base!) !== 4) return false;
  const prefix = Number(bits);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base!) & mask);
}

export function isTrustedProxy(ip: string | undefined, config: UserClientIpConfig): boolean {
  return !!ip && config.trustedProxies.some((entry) => matchesEntry(ip, entry));
}

/** prefix 默认 USER_，便于与管理员侧同形配置分开。非法配置抛普通 Error，由调用方包成配置错误。 */
export function parseUserClientIpConfig(env: NodeJS.ProcessEnv, prefix = "USER_"): UserClientIpConfig {
  const raw = env[`${prefix}TRUSTED_PROXIES`]?.trim() ?? "";
  const trustedProxies = raw ? raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) : [];
  for (const entry of trustedProxies) {
    if (entry === "loopback") continue;
    const [base, bits, extra] = entry.split("/");
    const valid = extra === undefined && !!normalizeClientIp(base) && (bits === undefined
      || (isIP(base!) === 4 && /^\d{1,2}$/.test(bits) && Number(bits) <= 32));
    if (!valid) throw new Error(`${prefix}TRUSTED_PROXIES must be a comma-separated list of IPs, IPv4 CIDRs or 'loopback'`);
  }
  const header = (env[`${prefix}CLIENT_IP_HEADER`]?.trim().toLowerCase() || "x-forwarded-for");
  if (!HEADERS.has(header)) throw new Error(`${prefix}CLIENT_IP_HEADER must be x-forwarded-for or x-real-ip`);
  return { trustedProxies, header: header as UserClientIpConfig["header"] };
}

type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null };

export type IpRequest = {
  headers: HeaderBag;
  socket?: { remoteAddress?: string };
};

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function forwardedClient(request: IpRequest, config: UserClientIpConfig): string | undefined {
  const raw = readHeader(request.headers, config.header);
  if (!raw) return undefined;
  if (config.header === "x-real-ip") return normalizeClientIp(raw.split(",")[0]);
  const hops = raw.split(",").map((part) => normalizeClientIp(part)).filter((part): part is string => !!part);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(hops[index], config)) return hops[index];
  }
  return undefined;
}

/**
 * 不可信对端只采用 socket，忽略转发头和内部头。
 * 可信对端优先采用 BFF 写入的内部头；否则从右向左去掉可信跳。
 * 解析不到客户端时返回 undefined，不用代理地址当共享硬锁桶。
 */
export function resolveUserClientIp(request: IpRequest, config: UserClientIpConfig = DEFAULT_USER_CLIENT_IP_CONFIG): string | undefined {
  const peer = normalizeClientIp(request.socket?.remoteAddress);
  if (!peer || !isTrustedProxy(peer, config)) return peer;
  const internal = normalizeClientIp(readHeader(request.headers, USER_CLIENT_IP_FORWARD_HEADER));
  if (internal) return internal;
  return forwardedClient(request, config);
}

/** 共享回环地址不是多用户 NAT，不进入 IP / 账号+IP 硬桶。真实客户端必须是非回环地址。 */
export function throttleClientIp(ip: string | undefined): string | undefined {
  return ip && !isLoopbackIp(ip) ? ip : undefined;
}

function withoutInternalHeader(headers: HeaderBag): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = {};
  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (headers as Headers).forEach((value, key) => { if (key !== USER_CLIENT_IP_FORWARD_HEADER) bag[key] = value; });
    return bag;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key === USER_CLIENT_IP_FORWARD_HEADER) continue;
    bag[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return bag;
}

/**
 * BFF 侧解析。看不到 socket 且未配置可信代理时返回 undefined，不采用浏览器带来的转发头。
 * 配置了可信代理但看不到 socket 时，按部署声明把入口视为可信，只走转发链。
 */
export function resolveBffClientIp(headers: HeaderBag, config: UserClientIpConfig, peer?: string): string | undefined {
  const cleaned = withoutInternalHeader(headers);
  if (peer) return resolveUserClientIp({ headers: cleaned, socket: { remoteAddress: peer } }, config);
  if (config.trustedProxies.length === 0) return undefined;
  return resolveUserClientIp(
    { headers: cleaned, socket: { remoteAddress: "0.0.0.0" } },
    { ...config, trustedProxies: ["0.0.0.0", ...config.trustedProxies] },
  );
}
