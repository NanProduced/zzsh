import { readFileSync } from "node:fs";
import { isIP } from "node:net";

/**
 * 会话设备信息的离线投影：UA 粗解析、IP 脱敏与 ip2region（MIT，xdb v2）地区查询。
 * 不引入第三方依赖；地区库文件由 ADMIN_IP2REGION_XDB 指向，缺失或损坏时一律返回 null，不影响会话列表与登录。
 */

export type SessionClient = {
  browser: string | null;
  os: string | null;
  deviceType: "desktop" | "mobile" | "tablet" | "script" | "unknown";
  /** 非浏览器客户端（node/curl/脚本/空 UA）需要在界面上醒目标记。 */
  isScript: boolean;
  label: string;
};

const SCRIPT_PATTERNS: Array<[RegExp, string]> = [
  [/^node(?:-fetch)?$|\bnode(?:\.js)?\b|undici/i, "Node.js"],
  [/\bcurl\//i, "curl"],
  [/\bwget\//i, "Wget"],
  [/python-requests|python-urllib|aiohttp|httpx/i, "Python"],
  [/\bGo-http-client\//i, "Go"],
  [/\bokhttp\//i, "OkHttp"],
  [/\bJava\//i, "Java"],
  [/PostmanRuntime/i, "Postman"],
  [/insomnia/i, "Insomnia"],
  [/axios\//i, "axios"],
  [/HeadlessChrome|Playwright|Puppeteer/i, "无头浏览器"],
];

function browserOf(ua: string): string | null {
  const pick = (re: RegExp, name: string) => {
    const match = re.exec(ua);
    return match ? `${name}${match[1] ? " " + match[1].split(".")[0] : ""}` : null;
  };
  return pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge")
    ?? pick(/OPR\/([\d.]+)/, "Opera")
    ?? pick(/MicroMessenger\/([\d.]+)/, "微信")
    ?? pick(/Firefox\/([\d.]+)/, "Firefox")
    ?? pick(/CriOS\/([\d.]+)/, "Chrome")
    ?? pick(/Chrome\/([\d.]+)/, "Chrome")
    ?? (/Safari\//.test(ua) ? pick(/Version\/([\d.]+)/, "Safari") ?? "Safari" : null);
}

function osOf(ua: string): string | null {
  if (/Windows NT 10\.0/.test(ua)) return "Windows 10/11";
  if (/Windows NT/.test(ua)) return "Windows";
  const ios = /(?:iPhone|iPad|iPod).*?OS (\d+)/.exec(ua);
  if (ios) return `iOS ${ios[1]}`;
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (mac) return "macOS";
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

export function parseSessionUserAgent(raw: string | null | undefined): SessionClient {
  const ua = (raw ?? "").trim();
  if (!ua) return { browser: null, os: null, deviceType: "script", isScript: true, label: "脚本/非浏览器客户端（未提供 UA）" };
  for (const [re, name] of SCRIPT_PATTERNS) {
    if (re.test(ua)) return { browser: name, os: osOf(ua), deviceType: "script", isScript: true, label: `脚本/非浏览器客户端（${name}）` };
  }
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (!browser && !/Mozilla\//.test(ua)) {
    return { browser: null, os, deviceType: "script", isScript: true, label: "脚本/非浏览器客户端" };
  }
  const deviceType = /iPad|Tablet/.test(ua) ? "tablet" : /Mobile|iPhone|Android/.test(ua) ? "mobile" : browser || os ? "desktop" : "unknown";
  const label = [browser ?? "未知浏览器", os].filter(Boolean).join(" · ");
  return { browser, os, deviceType, isScript: false, label };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function normalizeSessionIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip)!;
    const a = n >>> 24, b = (n >>> 16) & 0xff;
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** 他人会话只显示网段：IPv4 保留前两段，IPv6 保留前两组。 */
export function maskSessionIp(ip: string): string {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".");
    return `${a}.${b}.*.*`;
  }
  const groups = ip.split(":").filter(Boolean);
  return `${groups.slice(0, 2).join(":")}:****`;
}

const XDB_HEADER = 256;
const XDB_VECTOR_COLS = 256;
const XDB_VECTOR_SIZE = 8;
const XDB_SEGMENT_SIZE = 14;
const XDB_MIN_SIZE = XDB_HEADER + XDB_VECTOR_COLS * XDB_VECTOR_COLS * XDB_VECTOR_SIZE;

export type Ip2RegionSearcher = (ip: string) => string | null;

/** ip2region xdb v2（IPv4）整库内存查询；格式不符直接返回 undefined。 */
export function createIp2RegionSearcher(buffer: Buffer): Ip2RegionSearcher | undefined {
  if (buffer.length < XDB_MIN_SIZE) return undefined;
  return (ip: string) => {
    const value = ipv4ToInt(ip);
    if (value === null) return null;
    const idx = ((value >>> 24) * XDB_VECTOR_COLS + ((value >>> 16) & 0xff)) * XDB_VECTOR_SIZE;
    const sPtr = buffer.readUInt32LE(XDB_HEADER + idx);
    const ePtr = buffer.readUInt32LE(XDB_HEADER + idx + 4);
    if (sPtr === 0 || ePtr < sPtr || ePtr + XDB_SEGMENT_SIZE > buffer.length) return null;
    let low = 0;
    let high = (ePtr - sPtr) / XDB_SEGMENT_SIZE;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const p = sPtr + mid * XDB_SEGMENT_SIZE;
      const startIp = buffer.readUInt32LE(p);
      const endIp = buffer.readUInt32LE(p + 4);
      if (value < startIp) high = mid - 1;
      else if (value > endIp) low = mid + 1;
      else {
        const length = buffer.readUInt16LE(p + 8);
        const dataPtr = buffer.readUInt32LE(p + 10);
        if (dataPtr + length > buffer.length) return null;
        return buffer.toString("utf8", dataPtr, dataPtr + length);
      }
    }
    return null;
  };
}

/** 「中国|0|广东省|深圳市|电信」→「广东省 深圳市 · 电信」；占位 0 与重复项省略。 */
export function formatIp2Region(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split("|").map((part) => part.trim()).filter((part) => part && part !== "0");
  if (parts.length === 0) return null;
  const isp = raw.split("|").length >= 5 ? raw.split("|")[4]?.trim() : undefined;
  const place = parts.filter((part) => part !== isp);
  const unique = place.filter((part, index) => place.indexOf(part) === index);
  const geo = unique.length > 1 && unique[0] === "中国" ? unique.slice(1) : unique;
  return [geo.join(" "), isp && isp !== "0" ? isp : null].filter(Boolean).join(" · ") || null;
}

let cached: { path: string; searcher: Ip2RegionSearcher | undefined } | undefined;

export function loadIp2RegionFromEnv(env: NodeJS.ProcessEnv = process.env): Ip2RegionSearcher | undefined {
  const path = env.ADMIN_IP2REGION_XDB?.trim();
  if (!path) return undefined;
  if (cached?.path === path) return cached.searcher;
  let searcher: Ip2RegionSearcher | undefined;
  try {
    searcher = createIp2RegionSearcher(readFileSync(path));
  } catch {
    searcher = undefined;
  }
  cached = { path, searcher };
  return searcher;
}

export function sessionRegion(ip: string | null, searcher: Ip2RegionSearcher | undefined): string | null {
  if (!ip) return null;
  if (isPrivateIp(ip)) return "本机/内网";
  if (!searcher || isIP(ip) !== 4) return null;
  try {
    return formatIp2Region(searcher(ip));
  } catch {
    return null;
  }
}
