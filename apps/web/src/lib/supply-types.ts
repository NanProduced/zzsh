// User-facing DTOs only. Pricing and authorization remain in the API.
export type Money = { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 };
export type UnitAmount = {
  currency: "CNY";
  unit: "yuan";
  amount: string;
  scale: 8;
};
export type PublicQuote = {
  catalogRevision?: string;
  schemaVersion: 1 | 2;
  rentalMode?: "ordinary" | "custom" | "fast";
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
  tenantPayableTotal: Money | null;
  termSeconds: string;
  expiryDisclosures: Array<{
    entitlementId: string;
    expiresAt: string | null;
    fullTermGuaranteed: false;
  }>;
  unitAmountsInformational: boolean;
};
export type OwnerQuote = Omit<PublicQuote, "lines"> & {
  ownerTotal: Money;
  ownerHaffRatio?: string;
  publisherBailRequirement: Money | null;
  contentHash?: string;
  lines: Array<
    PublicQuote["lines"][number] & {
      ownerUnitAmount: UnitAmount;
      ownerAmount: Money;
    }
  >;
};
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
export type PublicListing = {
  displayNo?: string | null;
  safeBox?: { code: string; displayName: string | null } | null;
  termOption?: { code: string; displayName: string | null; dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null } | null;
  attributeDisplay?: PublicAttributeDisplay;
  id: string;
  versionId: string;
  releaseId?: string;
  title: string;
  description: string | null;
  publishedAt?: string | null;
  game?: { id: string; code: string; name: string } | null;
  attributes: Record<string, string | number | boolean | null>;
  presentation: {
    items: Array<{ id: string; code?: string; name: string; unit: string }>;
    skins: PublicListingSkin[];
    /** Migrated accounts only: declared references whose skin is not public yet (count, never names). */
    skinsWithheld?: number;
    entitlements: Array<{ id: string; name: string }>;
  };
  quote: PublicQuote | null;
  source?: "LEGACY_READ_ONLY";
  rentalMode?: "ordinary" | "custom" | "fast" | null;
  displaySchema?: "legacy-listing-display-v1";
  canCreateOrder?: boolean;
  /** Owner's sealed full-payout declaration: true/false declared, null = not declared (unknown). */
  fullPayoutSelected?: boolean | null;
  availability?: { state: PublicAvailabilityState };
  sourceAvailability?: { state: "LISTED" | "OFFLINE" | "RENTED" | "PENDING_PAYMENT" | "UNKNOWN"; asOfUtc: string };
  sourceUpdatedAt?: string;
  historicalQuote?: { haffRent: Money; goods: Money; deposit: Money; termDays: string };
  inventory?: Array<{ itemId: string; quantity: string | null; unit: string }>;
  media: Array<{ assetId: string; position: number; url: string; category?: "SHOWCASE" | "PENALTY" }>;
};
export type PublicAvailabilityState = "RENTABLE" | "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | "OFFLINE" | "UNKNOWN" | "UNAVAILABLE" | "LEGACY_READ_ONLY";
export type Favorite = {
  accountId: string;
  savedAt: string;
  state: "AVAILABLE" | "UNAVAILABLE";
  message: string | null;
  listing: PublicListing | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type ListingFilterConditions = {
  resources?: Array<{ itemId: string; minQuantity?: string; maxQuantity?: string }>;
  safeBoxCodes?: string[];
  gradingCodes?: string[];
  loginMethodCodes?: string[];
  vitality?: { min: number };
  bear?: { min: number };
  regions?: Array<{ province: string; city: string }>;
  serviceWindow?: {
    startMinute: number;
    endMinute: number;
    crossMidnight: boolean;
    timezone: "Asia/Shanghai";
  };
  skinGroups?: Array<{ categoryId: string; ids: string[]; match: "ANY" | "ALL" }>;
};
export type PublicListingFilterField = {
  key: string;
  operator: string;
  label: string;
  enabled: boolean;
  order: number;
  items?: Array<{ itemId: string; min: string; max: string }>;
  options?: Array<{ value: string; label: string }>;
  levels?: number[];
  regions?: Array<{ province: string; city: string }>;
  categoryIds?: string[];
};
export type PublicListingFilterMetadata = {
  available: boolean;
  readMode?: "LEGACY_READ_ONLY";
  reasonCode: string | null;
  gameId: string;
  queryVersion: 2;
  resourceQuantityRange?: boolean;
  filterRevision: string | null;
  catalogRevision: string | null;
  ruleReleaseId: string | null;
  defaultSort: { sort: string; direction: "ASC" | "DESC"; label: string };
  fields: PublicListingFilterField[];
  sorts: Array<{ key: string; label: string; enabled: boolean; order: number; itemIds?: string[] }>;
  directions: Array<"ASC" | "DESC">;
  items: Array<{ id: string; code: string; name: string; unit: string }>;
  categories: Array<{ id: string; parentId: string | null; name: string }>;
  skinCatalogUrl: string;
  limits: {
    urlBytes: number;
    resources: number;
    skinGroups: number;
    skinIds: number;
    enumValues: number;
    regions: number;
    limit: number;
    scanBudget: number;
  };
  livePages: boolean;
};
export type PublicListingPageV2 = Page<PublicListing> & {
  queryVersion: 2;
  sort: string;
  direction: "ASC" | "DESC";
  sortLabel: string;
  filterRevision: string;
  catalogRevision: string;
  ruleReleaseId: string;
  scannedCount: number;
  scanBudget: number;
  scanBudgetReached: boolean;
  limit: number;
};
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
export type PublicSkinSummary = {
  id: string;
  code: string;
  name: string;
  baseName: string | null;
  ownerName: string | null;
  categoryId: string;
  rarityCode: string | null;
  mediaId: string | null;
};
export type PublicListingSkin = {
  id: string;
  name: string;
  baseName?: string | null;
  ownerName?: string | null;
  mediaId?: string | null;
  categoryCode?: string;
  categoryName?: string;
};
export type PublicCatalog = {
  game: SupplyGame & { catalogRevision: string; currentReleaseId: string | null };
  items: Array<{
    id: string;
    code: string;
    name: string;
    unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
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
  skins: PublicSkinSummary[];
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
    priced: boolean;
    unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
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
  skins: PublicSkinSummary[];
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
  safeBoxOptions?: PublicCodeLabel[];
  pricingInputOptions?: { safeBoxCodes: string[]; vitalityLevels: number[]; bearLevels: number[] };
  gradingOptions?: PublicCodeLabel[];
  loginMethodOptions?: PublicCodeLabel[];
  vitalityLevels: number[];
  bearLevels: number[];
  diveLevels?: number[];
  pricingOptionCodes: string[];
  pricingSchema?: "haff-ratio-v2";
  rentalModes?: Record<
    RentalMode,
    {
      enabled: boolean;
      min?: { base: "C" | "ABSOLUTE"; value: string };
      max?: { base: "C" | "ABSOLUTE"; value: string };
    }
  >;
  agreement: { id: string; title: string; body: string; digest: string };
};
export type ResourceIncomePreview = {available:false;reason:string} | {
  available:true;informationalOnly:true;binding:{gameId:string;catalogRevision:string;releaseId:string;releaseGeneration:string;priceVersionId:string};
  lines:Array<{itemId:string;code:string;name:string;unit:string;unitQuantity:string;ownerUnitAmount:{currency:"CNY";unit:"yuan";amount:string;scale:number};quantity:string|null;ownerAmount:{currency:"CNY";unit:"yuan";amount:string;scale:2}|null}>;
  ownerTotal:{currency:"CNY";unit:"yuan";amount:string;scale:2}|null;unreportedItemIds:string[];unpricedItemIds:string[];
};
export type RentalMode = "ordinary" | "custom" | "fast";
export type DepositRecommendation =
  | {
      available: true;
      amountCents: string;
      minCents: string;
      fullPayoutMinCents: string;
      capCents: string;
      policyVersion: string;
      accountId: string;
      accountRevision: string;
      versionId: string;
      versionRevision: string;
      ruleReleaseId: string;
      priceVersionId: string;
      inputs: {
        safeBoxCode: string | null;
        vitality: number | null;
        bear: number | null;
        dive: number | null;
        skinIds: string[];
      };
    }
  | {
      available: false;
      reason: "FUNDING_POLICY_UNCONFIGURED" | "INPUTS_UNAVAILABLE";
      releaseId?: string;
    };
export type RentalPricingSelection = { rentalMode: RentalMode; ownerRatioB?: string };
export type DraftInput = {
  title: string;
  description: string | null;
  attributes: Record<string, string | number | boolean | null | RentalPricingSelection | { schema: "full-payout-declaration-v1"; selected: boolean } | { schema: "owner-deposit-declaration-v1"; amountCents: string; declarationVersion: string }>;
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
  mediaBindings: Array<{ assetId: string; position: number; category?: "SHOWCASE" | "PENALTY" }>;
};
export type VersionToken = {
  expectedRevision: string;
  versionId: string;
  releaseId: string;
  contentHash: string;
};
/** Sealed full-payout terms the renter must accept when the owner declared full payout. */
export type FullPayoutTermsAcceptance = { termsVersionId: string; termsDigest: string; disclosureVersion: string };
export type FullPayoutTerms = FullPayoutTermsAcceptance & {
  policyRef: string;
  policyVersion: string;
  title: string;
  body: string;
};
export type SavedDeclaration = Omit<DraftInput, "mediaBindings"> & {
  mediaBindings: Array<{
    assetId: string;
    position: number;
    purpose: "ACCOUNT_EVIDENCE" | "ACCOUNT_DISPLAY";
    category?: "SHOWCASE" | "PENALTY";
    byteHash: string | null;
    reviewState?: "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "QUARANTINED" | "UNAVAILABLE";
    publicDisplayEligible?: boolean;
    publiclyReadable?: boolean;
  }>;
};
export type LegacyHistoricalRead = {
  canCreateOrder: false;
  trade: "UNKNOWN";
  quote?: null;
  historicalQuote: { haffRentYuan: string; goodsYuan: string; depositYuan: string; termDays: string; dailyHaffBase: string };
  display?: { state: "NOT_IMPORTED"; facts: null } | { state: "KNOWN"; facts: {
    schema: "legacy-listing-display-v1";
    rentalMode: "ordinary" | "custom" | "fast" | null;
    attributes: Record<string, string | number | boolean | null>;
    resources: Array<{ code: string; name: string; quantity: string | null; unit: string }>;
    attributeDisplay: PublicAttributeDisplay;
    sourceUpdatedAt: string;
  } };
};
export type MySupply = {
  historicalRead?: LegacyHistoricalRead | null;
  account: {
    id: string;
    game_id: string;
    revision: string;
    current_version_id: string | null;
    owner_paused: boolean;
    staff_restricted: boolean;
    restriction_reason: string | null;
    /** Canonical AC number; legacy rows stay null until their reviewed public admission. */
    display_no?: string | null;
    lifecycle?: string | null;
    legacy_hold?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  };
  version: null | {
    id: string;
    schemaVersion: 1 | 2;
    sequence: string;
    revision?: string;
    origin?: string | null;
    /** When this version first went public. Not the account creation time. */
    publication?: { publishedAt?: string | null; source?: string | null } | null;
    reviewState:
      | "DRAFT"
      | "SUBMITTED"
      | "WITHDRAWN"
      | "REJECTED"
      | "APPROVED"
      | "PUBLISHED"
      | "IMPORTED_UNVERIFIED";
    releaseId: string | null;
    contentHash: string | null;
    declaration: SavedDeclaration;
    catalogItems?: Array<{ id: string; code: string; name: string; unit: string; priced: boolean }>;
    attributeDisplay?: PublicAttributeDisplay;
    safeBox?: { code: string; displayName: string | null } | null;
    termOption?: {
      code: string;
      displayName: string | null;
      dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null;
    } | null;
    presentation?: {
      items: Array<{ id: string; code?: string; name: string; unit: string }>;
      skins: PublicListingSkin[];
      entitlements: Array<{ id: string; name: string }>;
    };
    quote: OwnerQuote | null;
  };
  agreement?: PublishingOptions["agreement"] | null;
  available?: boolean;
  blockers?: string[];
  /**
   * Version records (read-only). The detail page renders sequence, review state, time and title
   * only — internal ids, content hashes and rule release ids stay internal.
   */
  history?: Array<{
    sequence: string | null;
    review_state: string | null;
    title: string | null;
    created_at: string | null;
    origin?: string | null;
  }>;
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
