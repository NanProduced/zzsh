import { isIP } from "node:net";

import { ConfigurationError } from "../config/config";

/**
 * 管理员认证的客户端 IP 解析。默认只信任 TCP 对端地址（socket.remoteAddress），
 * 不读取任何 X-Forwarded-For 类请求头；只有对端地址命中 ADMIN_TRUSTED_PROXIES
 * 时才按 ADMIN_CLIENT_IP_HEADER 读取上游代理写入的客户端地址。
 */
export type AdminClientIpConfig = {
  trustedProxies: readonly string[];
  header: "x-forwarded-for" | "x-real-ip";
};

export const ADMIN_CLIENT_IP_FORWARD_HEADER = "x-zzsh-admin-client-ip";
const HEADERS = new Set(["x-forwarded-for", "x-real-ip"]);

export const DEFAULT_ADMIN_CLIENT_IP_CONFIG: AdminClientIpConfig = { trustedProxies: [], header: "x-forwarded-for" };

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let ip = value.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : undefined;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function matchesEntry(ip: string, entry: string): boolean {
  if (entry === "loopback") return ip === "127.0.0.1" || ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
  const [base, bits] = entry.split("/");
  if (bits === undefined) return normalizeIp(base) === ip;
  if (isIP(ip) !== 4 || isIP(base!) !== 4) return false;
  const prefix = Number(bits);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base!) & mask);
}

export function isTrustedProxy(ip: string | undefined, config: AdminClientIpConfig): boolean {
  return !!ip && config.trustedProxies.some((entry) => matchesEntry(ip, entry));
}

export function parseAdminClientIpConfig(env: NodeJS.ProcessEnv): AdminClientIpConfig {
  const raw = env.ADMIN_TRUSTED_PROXIES?.trim() ?? "";
  const trustedProxies = raw ? raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) : [];
  for (const entry of trustedProxies) {
    if (entry === "loopback") continue;
    const [base, bits, extra] = entry.split("/");
    const valid = extra === undefined && !!normalizeIp(base) && (bits === undefined
      || (isIP(base!) === 4 && /^\d{1,2}$/.test(bits) && Number(bits) <= 32));
    if (!valid) throw new ConfigurationError("ADMIN_TRUSTED_PROXIES must be a comma-separated list of IPs, IPv4 CIDRs or 'loopback'");
  }
  const header = (env.ADMIN_CLIENT_IP_HEADER?.trim().toLowerCase() || "x-forwarded-for");
  if (!HEADERS.has(header)) throw new ConfigurationError("ADMIN_CLIENT_IP_HEADER must be x-forwarded-for or x-real-ip");
  return { trustedProxies, header: header as AdminClientIpConfig["header"] };
}

type IpRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

/** 返回经过信任链校验的客户端 IP；无法确定时返回 undefined（调用方只按账号限流）。 */
export function resolveAdminClientIp(request: IpRequest, config: AdminClientIpConfig = DEFAULT_ADMIN_CLIENT_IP_CONFIG): string | undefined {
  const peer = normalizeIp(request.socket?.remoteAddress);
  if (!peer || !isTrustedProxy(peer, config)) return peer;
  const raw = first(request.headers[config.header]);
  if (!raw) return peer;
  if (config.header === "x-real-ip") return normalizeIp(raw) ?? peer;
  const hops = raw.split(",").map((part) => normalizeIp(part)).filter((part): part is string => !!part);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(hops[index], config)) return hops[index];
  }
  return hops[0] ?? peer;
}
