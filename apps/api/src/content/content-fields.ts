import { invalid } from "../supply/supply-util";

export const CONTENT_TYPES = ["ANNOUNCEMENT", "NEWS"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const CAROUSEL_SLOTS = ["HOME_HERO"] as const;
export type CarouselSlot = (typeof CAROUSEL_SLOTS)[number];

export const CONTENT_LIMITS = {
  title: 200,
  summary: 500,
  bodyBytes: 20_000,
  carouselTitle: 120,
  carouselDescription: 300,
  imageAlt: 300,
  link: 300,
} as const;

// Only implemented user-web routes may be carousel targets; a carousel entry can
// never point at an external scheme, script URL or an unimplemented order action.
const ALLOWED_LINK_SEGMENTS = new Set(["accounts", "publish", "account", "help"]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}

export function isCarouselSlot(value: string): value is CarouselSlot {
  return (CAROUSEL_SLOTS as readonly string[]).includes(value);
}

// Minimal plain-text format: NFC + LF only, no control characters and a hard
// UTF-8 byte ceiling. HTML-looking input stays inert text; nothing is executed.
export function normalizeContentText(value: string, field: "title" | "summary" | "body" | "carouselTitle" | "carouselDescription" | "imageAlt"): string {
  const normalized = value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (CONTROL_CHARACTERS.test(normalized)) throw invalid(`${field} contains control characters`);
  const maxBytes = field === "body" ? CONTENT_LIMITS.bodyBytes : field === "summary" ? CONTENT_LIMITS.summary : field === "title" ? CONTENT_LIMITS.title : field === "carouselTitle" ? CONTENT_LIMITS.carouselTitle : field === "carouselDescription" ? CONTENT_LIMITS.carouselDescription : CONTENT_LIMITS.imageAlt;
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw invalid(`${field} exceeds the allowed length`);
  if (field !== "body" && field !== "summary" && field !== "carouselDescription" && [...normalized].length > maxBytes) throw invalid(`${field} exceeds the allowed length`);
  return normalized;
}

export function validateInternalLink(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid("linkUrl is invalid");
  if (value.length === 0 || value.length > CONTENT_LIMITS.link) throw invalid("linkUrl is invalid");
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTERS.test(value) || /\s/.test(value)) throw invalid("linkUrl must be a same-site relative path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalid("linkUrl is invalid");
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) throw invalid("linkUrl must be a same-site relative path");
  const path = decoded.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) throw invalid("linkUrl must not contain relative segments");
  if (segments.length === 0) return decoded === "/" ? decoded : normalizeLink(value);
  if (!ALLOWED_LINK_SEGMENTS.has(segments[0]!)) throw invalid("linkUrl target is not available");
  return normalizeLink(value);
}

function normalizeLink(value: string): string {
  return value.normalize("NFC");
}

export function parseRfc3339Timestamp(value: unknown, field: string): { date: Date; text: string } | null {
  if (value === null) return null;
  if (typeof value !== "string" || !RFC3339.test(value) || value.startsWith("0000-")) throw invalid(`${field} is invalid`);
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart!.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = timePart!.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "").split(":").map(Number) as [number, number, number];
  // Calendar and clock fields are validated directly: Date.parse normalizes
  // impossible input (e.g. February 30 or 24:00:00) instead of rejecting it.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) throw invalid(`${field} is invalid`);
  if (hour > 23 || minute > 59 || second > 59) throw invalid(`${field} is invalid`);
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw invalid(`${field} is invalid`);
  return { date: new Date(millis), text: value };
}

export type ContentScope = { platform: true; gameId: null } | { platform: false; gameId: string };

export function itemScope(row: { gameId: string | null }): ContentScope {
  return row.gameId === null ? { platform: true, gameId: null } : { platform: false, gameId: row.gameId };
}
