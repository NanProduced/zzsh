// User-facing DTOs only. Pricing and authorization remain in the API.
export type Money = { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 };
export type UnitAmount = {
  currency: "CNY";
  unit: "yuan";
  amount: string;
  scale: 8;
};
export type PublicQuote = {
  schemaVersion: 1;
  currency: "CNY";
  ruleReleaseId: string | null;
  lines: Array<{
    itemId: string;
    quantity: string;
    unit: string;
    unitQuantity: string;
    buyerUnitAmount: UnitAmount;
    buyerAmount: Money;
  }>;
  resourceTotal: Money;
  tenantDeposit: Money | null;
  termSeconds: string;
  expiryDisclosures: Array<{
    entitlementId: string;
    expiresAt: string | null;
    fullTermGuaranteed: false;
  }>;
  unitAmountsInformational: boolean;
};
export type OwnerQuote = PublicQuote & {
  ownerTotal: Money;
  publisherBailRequirement: Money | null;
  contentHash?: string;
  lines: Array<
    PublicQuote["lines"][number] & {
      ownerUnitAmount: UnitAmount;
      ownerAmount: Money;
    }
  >;
};
export type PublicListing = {
  safeBox?: { code: string; displayName: string | null } | null;
  termOption?: { code: string; displayName: string | null; dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null } | null;
  id: string;
  versionId: string;
  title: string;
  description: string | null;
  attributes: Record<string, string | number | boolean | null>;
  presentation: {
    items: Array<{ id: string; name: string; unit: string }>;
    skins: Array<{ id: string; name: string }>;
    entitlements: Array<{ id: string; name: string }>;
  };
  quote: PublicQuote;
  media: Array<{ assetId: string; position: number; url: string }>;
};
export type Favorite = {
  accountId: string;
  savedAt: string;
  state: "AVAILABLE" | "UNAVAILABLE";
  message: string | null;
  listing: PublicListing | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type SupplyGame = {
  id: string;
  code: string;
  name: string;
  description: string | null;
};
export type PublicGunsmithGame = SupplyGame;
export type PublicFirearm = {
  id: string;
  gameId: string;
  code: string;
  name: string;
  classificationId: string | null;
  classificationCode: string | null;
  classificationName: string | null;
  enabled: boolean;
  sortOrder: number;
  mediaId: string | null;
  codeCount: number;
  updatedAt: string;
};
export type PublicGunsmithCode = {
  id: string;
  firearmId: string;
  code: string;
  note: string;
  modeCode: "HAZARD" | "BATTLEFIELD" | "GENERAL" | null;
  updatedAt: string;
};
export type PublicGunsmithPage = {
  items: PublicFirearm[];
  classifications: Array<{ id: string; code: string; name: string; sortOrder: number }>;
  nextCursor: string | null;
  limit: number;
};
export type PublicGunsmithCodesPage = {
  firearm: PublicFirearm;
  items: PublicGunsmithCode[];
  nextCursor: string | null;
  limit: number;
};
export type PublicCatalog = {
  game: SupplyGame & { catalogRevision: string; currentReleaseId: string | null };
  items: Array<{
    id: string;
    code: string;
    name: string;
    unit: "HAFF_BASE" | "ROUND" | "PIECE";
    quantityScale: number;
    required: boolean;
    sortOrder: number;
  }>;
  categories: Array<{
    id: string;
    code: string;
    name: string;
    parentId: string | null;
  }>;
  rarities: Array<{ code: string; name: string }>;
  skins: Array<{
    id: string;
    code: string;
    name: string;
    categoryId: string;
    rarityCode: string | null;
    mediaId: string | null;
  }>;
  nextCursor: string | null;
  limit: number;
};
export type PublishingCatalog = {
  game: {
    id: string;
    code: string;
    name: string;
    catalogRevision: string;
    currentReleaseId: string | null;
  };
  inputScale: 0;
  ready: boolean;
  blockers: Array<{
    code: "RULE_UNCONFIGURED" | "REQUIRED_ITEM_UNPRICED";
    path: string;
    itemId?: string;
    name?: string;
  }>;
  items: Array<{
    id: string;
    code: string;
    name: string;
    unit: "HAFF_BASE" | "ROUND" | "PIECE";
    quantityScale: number;
    required: boolean;
    sortOrder: number;
  }>;
  categories: Array<{
    id: string;
    code: string;
    name: string;
    parentId: string | null;
  }>;
  rarities: Array<{ code: string; name: string }>;
  skins: Array<{
    id: string;
    code: string;
    name: string;
    categoryId: string;
    rarityCode: string | null;
    mediaId: string | null;
  }>;
  entitlements: Array<{
    id: string;
    code: string;
    name: string;
    valueKind: "FLAG" | "LEVEL" | "CAPACITY";
    expiryKind: "PERMANENT" | "TIMED";
  }>;
  nextCursor: string | null;
  limit: number;
};
export type PublishingOptions = {
  releaseId: string;
  generation: string;
  termOptions: Array<{
    code: string;
    name: string;
    dailyConsumption: string;
    durationRounding: "CEIL_DAY";
  }>;
  safeBoxCodes: string[];
  vitalityLevels: number[];
  bearLevels: number[];
  pricingOptionCodes: string[];
  agreement: { id: string; title: string; body: string; digest: string };
};
export type DraftInput = {
  title: string;
  description: string | null;
  attributes: Record<string, string | number | boolean | null>;
  termOptionCode: string;
  pricingOptionCode: string;
  inventory: Array<{ itemId: string; quantity: string | null }>;
  skins: string[];
  entitlements: Array<{
    entitlementId: string;
    value: boolean | number | null;
    expiresAt: string | null;
    expiryKnowledge: "KNOWN" | "UNKNOWN";
  }>;
  mediaBindings: Array<{ assetId: string; position: number }>;
};
export type VersionToken = {
  expectedRevision: string;
  versionId: string;
  releaseId: string;
  contentHash: string;
};
export type SavedDeclaration = Omit<DraftInput, "mediaBindings"> & {
  mediaBindings: Array<{
    assetId: string;
    position: number;
    purpose: "ACCOUNT_EVIDENCE" | "ACCOUNT_DISPLAY";
    byteHash: string | null;
    reviewState?: "PENDING" | "APPROVED" | "REJECTED" | "UNAVAILABLE";
    publicDisplayEligible?: boolean;
    publiclyReadable?: boolean;
  }>;
};
export type MySupply = {
  account: {
    id: string;
    game_id: string;
    revision: string;
    current_version_id: string | null;
    owner_paused: boolean;
    staff_restricted: boolean;
    restriction_reason: string | null;
  };
  version: null | {
    id: string;
    schemaVersion: 1;
    sequence: string;
    reviewState:
      | "DRAFT"
      | "SUBMITTED"
      | "WITHDRAWN"
      | "REJECTED"
      | "APPROVED"
      | "IMPORTED_UNVERIFIED";
    releaseId: string | null;
    contentHash: string | null;
    declaration: SavedDeclaration;
    quote: OwnerQuote | null;
  };
  agreement?: PublishingOptions["agreement"] | null;
  available?: boolean;
  blockers?: string[];
  decisions?: Array<{
    id: string;
    version_id: string;
    decision: "APPROVE" | "REJECT";
    reason: string;
  }>;
};
export type SupplyFieldError = { path: string; code: string };
export type SupplyErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: SupplyFieldError[];
  };
};
