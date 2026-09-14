import { invalid } from "./supply-util";
import { escapeLike } from "./catalog";

export const LISTING_SEARCH_MAX_LENGTH = 120;

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

export type PublicSafeBox = { code: string; displayName: string | null };
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
  return {
    safeBox: safeBoxCode ? { code: safeBoxCode, displayName: null } : null,
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
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "UNAVAILABLE";

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
    row.reviewState === "PENDING" ||
    row.reviewState === "APPROVED" ||
    row.reviewState === "REJECTED"
      ? row.reviewState
      : "UNAVAILABLE";
  const publicDisplayEligible =
    purpose === "ACCOUNT_DISPLAY" &&
    row.reviewState === "APPROVED" &&
    row.accessClass === "PUBLIC_DISPLAY" &&
    Boolean(row.publicStorageKey);
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
