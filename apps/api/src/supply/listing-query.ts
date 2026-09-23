import { invalid } from "./supply-util";
import { escapeLike } from "./catalog";

export const LISTING_SEARCH_MAX_LENGTH = 120;

// Keep public, confirmation and order consumers on the same publication contract.
export function effectivePublicationStateSql(versionAlias = "v", publicationAlias = "p"): string {
  return `((${versionAlias}.review_state='PUBLISHED' AND ${publicationAlias}.source='OWNER_DIRECT') OR (${versionAlias}.review_state='APPROVED' AND ${publicationAlias}.source='LEGACY_APPROVED'))`;
}
export const EFFECTIVE_PUBLICATION_STATE_SQL = effectivePublicationStateSql();
export function isEffectivePublicationState(versionState: unknown, source: unknown): boolean {
  return (versionState === "PUBLISHED" && source === "OWNER_DIRECT") ||
    (versionState === "APPROVED" && source === "LEGACY_APPROVED");
}

export function parsePublicListingSearch(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = raw.normalize("NFC").trim();
  if (normalized.length === 0) return null;
  if (normalized.length > LISTING_SEARCH_MAX_LENGTH)
    throw invalid("Search text is too long", "q");
  if (normalized.includes("\u0000")) throw invalid("Search text is invalid", "q");
  return normalized;
}

export function listingSearchPattern(q: string): string {
  return `%${escapeLike(q)}%`;
}

export type PublicListingGame = { id: string; code: string; name: string };

// Public listing context only carries the rented account's own game identity.
// Missing or partial rows project to null so clients fall back to a generic
// trail instead of guessing a game.
export function projectPublicListingGame(
  row: { id?: string | null; code?: string | null; name?: string | null } | null | undefined,
): PublicListingGame | null {
  if (!row?.id || !row.code || !row.name) return null;
  return { id: row.id, code: row.code, name: row.name };
}

export type PublicSafeBox = { code: string; displayName: string | null };
export type PublicCodeLabel = {
  code: string;
  displayName: string | null;
  mappingStatus: "CONFIRMED" | "UNCONFIRMED";
  issueCode: string | null;
};
export type PublicAttributeDisplay = {
  safeBox: PublicCodeLabel | null;
  grading: PublicCodeLabel | null;
  loginMethod: PublicCodeLabel | null;
  serviceWindow: {
    startMinute: number;
    endMinute: number;
    displayName: string;
  } | null;
};
export type PublicTermOption = {
  code: string;
  displayName: string | null;
  dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null;
};
export type BoundTermOption = {
  code: string;
  name: string;
  dailyConsumption: string;
};

const SAFE_BOX_DISPLAY_NAMES: Record<string, string> = {
  safe_box_1x2: "基础安全箱(1*2)",
  safe_box_2x2: "进阶安全箱(2*2)",
  safe_box_2x3: "高级安全箱(2*3)",
  safe_box_3x3: "顶级安全箱(3*3)",
};
const GRADING_DISPLAY_NAMES: Record<string, string> = {
  "1": "无",
  "2": "青铜",
  "3": "白银",
  "4": "黄金",
  "5": "铂金",
  "6": "钻石",
  "7": "黑鹰",
  "8": "巅峰",
};
const LOGIN_METHOD_DISPLAY_NAMES: Record<string, string> = {
  legacy_login_qq: "QQ账密",
  legacy_login_wechat: "微信扫码",
  legacy_login_steam_cn: "Steam国服",
  legacy_login_steam_global: "Steam国际服",
};

function codeOptions(
  names: Record<string, string>,
  codes: string[],
  issueCode: string,
): PublicCodeLabel[] {
  return codes
    .map((code) => codeLabel(code, names, issueCode))
    .filter((option): option is PublicCodeLabel => option !== null);
}

export function publicSafeBoxOptions(codes: string[]): PublicCodeLabel[] {
  return codeOptions(SAFE_BOX_DISPLAY_NAMES, codes, "SAFE_BOX_CODE_UNMAPPED");
}

export function publicGradingOptions(): PublicCodeLabel[] {
  return codeOptions(
    GRADING_DISPLAY_NAMES,
    Object.keys(GRADING_DISPLAY_NAMES),
    "GRADING_CODE_UNMAPPED",
  );
}

export function publicLoginMethodOptions(): PublicCodeLabel[] {
  return codeOptions(
    LOGIN_METHOD_DISPLAY_NAMES,
    Object.keys(LOGIN_METHOD_DISPLAY_NAMES),
    "LOGIN_METHOD_CODE_UNMAPPED",
  );
}

function attributeCode(value: unknown): string | null {
  if (typeof value === "string") {
    const code = value.trim();
    return code || null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function codeLabel(
  value: unknown,
  names: Record<string, string>,
  issueCode: string,
): PublicCodeLabel | null {
  const code = attributeCode(value);
  if (!code) return null;
  const displayName = names[code] ?? null;
  return {
    code,
    displayName,
    mappingStatus: displayName ? "CONFIRMED" : "UNCONFIRMED",
    issueCode: displayName ? null : issueCode,
  };
}

function displayMinute(value: unknown): number | null {
  const minute = typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(minute) && minute >= 0 && minute <= 1_440 ? minute : null;
}

function minuteText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function projectPublicAttributeDisplay(
  attributes: Record<string, unknown>,
): PublicAttributeDisplay {
  const startMinute = displayMinute(attributes.service_window_start_minute);
  const endMinute = displayMinute(attributes.service_window_end_minute);
  return {
    safeBox: codeLabel(attributes.safe_box_code, SAFE_BOX_DISPLAY_NAMES, "SAFE_BOX_CODE_UNMAPPED"),
    grading: codeLabel(attributes.grading_code, GRADING_DISPLAY_NAMES, "GRADING_CODE_UNMAPPED"),
    loginMethod: codeLabel(attributes.login_method_code, LOGIN_METHOD_DISPLAY_NAMES, "LOGIN_METHOD_CODE_UNMAPPED"),
    serviceWindow:
      startMinute === null || endMinute === null
        ? null
        : {
            startMinute,
            endMinute,
            displayName: `${minuteText(startMinute)}–${minuteText(endMinute)}`,
          },
  };
}

export function projectPublicOffer(input: {
  attributes: Record<string, unknown>;
  termOptionCode: string;
  boundTerm: BoundTermOption | null;
}): { safeBox: PublicSafeBox | null; termOption: PublicTermOption | null } {
  const rawCode = input.attributes.safe_box_code;
  const safeBoxCode =
    typeof rawCode === "string" && rawCode.length > 0 ? rawCode : null;
  const termCode =
    typeof input.termOptionCode === "string" ? input.termOptionCode.trim() : "";
  const bound =
    input.boundTerm && input.boundTerm.code === termCode
      ? input.boundTerm
      : null;
  const quantity = bound?.dailyConsumption;
  const display = projectPublicAttributeDisplay(input.attributes);
  return {
    safeBox: safeBoxCode
      ? { code: safeBoxCode, displayName: display.safeBox?.displayName ?? null }
      : null,
    termOption: termCode
      ? {
          code: termCode,
          displayName: bound?.name ?? null,
          dailyConsumption:
            typeof quantity === "string" && quantity.length > 0
              ? { quantity, unit: "HAFF_BASE" }
              : null,
        }
      : null,
  };
}

export type OwnerMediaReviewState =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "QUARANTINED"
  | "UNAVAILABLE";

type PublicDisplayMediaRow = {
  purpose: string | null;
  reviewState: string | null;
  accessClass: string | null;
  publicStorageKey: string | null;
  technicalState?: string | null;
};

export function mediaReviewAllowsPublication(reviewState: unknown): boolean {
  return reviewState === "PENDING" || reviewState === "APPROVED";
}

export function isAccountDisplayPubliclyEligible(
  row: PublicDisplayMediaRow,
  targetAccessClass = row.accessClass,
): boolean {
  return row.purpose === "ACCOUNT_DISPLAY" &&
    mediaReviewAllowsPublication(row.reviewState) &&
    row.technicalState === "READY" &&
    targetAccessClass === "PUBLIC_DISPLAY" &&
    Boolean(row.publicStorageKey);
}

export type PublicMediaRoute = {
  listingPublic: boolean;
  displayAssetIds: ReadonlySet<string>;
  ownerUserId: string;
};

export function projectOwnerMediaBinding(
  row: {
    assetId: string;
    position: number;
    purpose: string | null;
    byteHash: string | null;
    reviewState: string | null;
    accessClass: string | null;
    publicStorageKey: string | null;
    technicalState?: string | null;
    ownerUserId: string | null;
  },
  publicRoute: PublicMediaRoute,
): {
  assetId: string;
  position: number;
  purpose: "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE" | null;
  byteHash: string | null;
  reviewState: OwnerMediaReviewState;
  publicDisplayEligible: boolean;
  publiclyReadable: boolean;
} {
  const purpose =
    row.purpose === "ACCOUNT_DISPLAY" || row.purpose === "ACCOUNT_EVIDENCE"
      ? row.purpose
      : null;
  const reviewState: OwnerMediaReviewState =
    purpose === "ACCOUNT_DISPLAY" && row.reviewState === "PENDING"
      ? "NOT_REQUIRED"
      : row.reviewState === "PENDING" ||
          row.reviewState === "APPROVED" ||
          row.reviewState === "REJECTED" ||
          row.reviewState === "QUARANTINED"
        ? row.reviewState
        : "UNAVAILABLE";
  const publicDisplayEligible = isAccountDisplayPubliclyEligible(row);
  return {
    assetId: row.assetId,
    position: row.position,
    purpose,
    byteHash: row.byteHash,
    reviewState,
    publicDisplayEligible,
    publiclyReadable:
      publicRoute.listingPublic &&
      publicDisplayEligible &&
      row.ownerUserId === publicRoute.ownerUserId &&
      publicRoute.displayAssetIds.has(row.assetId),
  };
}
