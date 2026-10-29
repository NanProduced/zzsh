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
  /** Published STANDARD buyer ratio in 万哈夫币/元, before renter benefits; older APIs may omit it. */
  baseRenterHaffRatioWanPerYuan?: string | null;
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
    items: Array<{ id: string; code?: string; name: string; unit: string; mediaId?: string | null }>;
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
export type Page<T> = { items: T[]; nextCursor: string | null; nextPageCursor?: string | null };
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
  /** Game-scoped quality name; evidence basis distinguishes platform and official sources. */
  rarityName?: string | null;
  rarityBasis?: "PLATFORM_REFERENCE" | "OFFICIAL" | null;
  isCollectible?: boolean | null;
  defaultState?: "UNKNOWN" | "DEFAULT" | "NON_DEFAULT";
  ownerKind?: SkinOwnerKind | null;
  mediaId: string | null;
  mediaKind?: SkinMediaKind | null;
};
/** Verified owner type of a skin: operator, firearm or melee-weapon type. */
export type SkinOwnerKind = "AGENT" | "FIREARM" | "MELEE_TYPE";
export type SkinMediaKind = "PORTRAIT_CARD" | "MODEL_IMAGE" | "PROMO_POSTER";
export type PublicListingSkin = {
  id: string;
  name: string;
  baseName?: string | null;
  ownerName?: string | null;
  /** Absent on snapshots frozen before type/quality were captured; null = unknown when frozen. */
  ownerKind?: SkinOwnerKind | null;
  rarityCode?: string | null;
  rarityName?: string | null;
  rarityBasis?: "PLATFORM_REFERENCE" | "OFFICIAL" | null;
  isCollectible?: boolean | null;
  defaultState?: "UNKNOWN" | "DEFAULT" | "NON_DEFAULT";
  mediaId?: string | null;
  mediaKind?: SkinMediaKind | null;
  categoryCode?: string;
  categoryName?: string;
};
export type PublicCatalog = {
  owners?: Array<{ id: string; kind: SkinOwnerKind; name: string }>;
  game: SupplyGame & { catalogRevision: string; currentReleaseId: string | null };
  items: Array<{
    id: string;
    code: string;
    name: string;
    unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
    quantityScale: number;
    required: boolean;
    sortOrder: number;
    mediaId?: string | null;
  }>;
  categories: Array<{
    id: string;
    code: string;
    name: string;
    parentId: string | null;
    ownerKind?: SkinOwnerKind | null;
  }>;
  rarities: Array<{ code: string; name: string }>;
  skins: PublicSkinSummary[];
  nextCursor: string | null;
  limit: number;
};
export type PublishingCatalog = {
  owners?: Array<{ id: string; kind: SkinOwnerKind; name: string }>;
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
    mediaId?: string | null;
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
    ownerKind?: SkinOwnerKind | null;
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
  declarationOptions?: {
    next_season_pass?: { enabled: boolean; required: boolean; requiredAt: "QUOTE_AND_PUBLICATION"; label: string; type: "BOOLEAN"; public: true };
    demulan_unlocked?: { enabled: boolean; required: boolean; requiredAt: "QUOTE_AND_PUBLICATION"; label: string; type: "BOOLEAN"; public: true };
    info_source?: { enabled: boolean; required: false; label: string; public: false; options: Array<{ name: string; value: string }>; optionsState: "CONFIGURED" | "NOT_CONFIGURED"; acceptsLegacyText: boolean; sourceSnapshot?: { observedAtUtc: string; sha256: string; revision: null } };
  };
  rentalTermOptions?: Partial<Record<RentalMode, { termOptionCodes: string[]; requiredDailyConsumption?: "10000000"; reasonCodes?: string[] }>>;
  termOptions: Array<{
    code: string;
    name: string;
    dailyConsumption: string;
    durationRounding: "CEIL_DAY";
    ownerRatioAdjustmentWanPerYuan?: string | null;
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
export type OwnerDepositDeclaration = {
  schema: "owner-deposit-declaration-v1";
  amountCents: string;
  declarationVersion: string;
};
export type OwnerIncomePreviewLine = {
  itemId: string;
  code: string;
  name: string;
  quantity: string | null;
  unit: string;
  unitQuantity: string | null;
  ownerUnitAmount: { currency: "CNY"; unit: "yuan"; amount: string; scale: number } | null;
  ownerAmount: Money | null;
};
export type OwnerIncomePreviewInput = {
  releaseId: string;
  catalogRevision: string;
  accountId?: string;
  attributes: {
    safe_box_code?: string | null;
    vit_level?: number | null;
    bear_level?: number | null;
    rentalPricing?: RentalPricingSelection | null;
    owner_deposit_declaration?: OwnerDepositDeclaration | null;
    full_payout_declaration?: { schema: "full-payout-declaration-v1"; selected: boolean } | null;
  };
  termOptionCode: string | null;
  pricingOptionCode?: string | null;
  inventory: Array<{ itemId: string; quantity: string | null }>;
  entitlements: Array<{
    entitlementId: string;
    value: boolean | number | string | null;
    expiresAt: string | null;
    expiryKnowledge: "KNOWN" | "UNKNOWN";
  }>;
};
export type OwnerIncomePreview = {
  schema: "owner-income-preview.v1";
  state: "READY" | "PARTIAL" | "INCOMPLETE" | "UNAVAILABLE";
  binding: {
    gameId: string;
    releaseId: string;
    releaseGeneration: string;
    priceVersionId: string;
    termVersionId: string;
    catalogRevision: string;
  } | null;
  evaluatedAt: string;
  refreshAfter: string;
  rentalMode: RentalMode | null;
  ownerHaffRatioWanPerYuan: string | null;
  termSeconds: string | null;
  lines: OwnerIncomePreviewLine[];
  ownerHaffIncome: Money | null;
  ownerResourceIncome: Money | null;
  knownResourceSubtotal: Money | null;
  totalExpectedIncome: Money | null;
  baseTenantDeposit: Money | null;
  depositState: "KNOWN" | "INCOMPLETE" | "UNAVAILABLE";
  missingFields: string[];
  reasonCodes: string[];
  unitAmountsInformational: boolean;
  estimateOnly: true;
  incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES";
  normalEndEstimate?: OwnerNormalEndEstimate;
};
export type OwnerNormalEndEstimate = {
  schema: "owner-normal-end-estimate.v1";
  state: "READY" | "INCOMPLETE" | "UNAVAILABLE";
  scenario: "ALL_DECLARED_INVENTORY_CONSUMED_NORMAL_END";
  selected: boolean | null;
  ownerGross: Money | null;
  serviceFee: { base: Money | null; rate: string | null; amount: Money | null; payer: "OWNER" | "NONE" | null };
  ownerNet: Money | null;
  policy: { fullPayoutPolicyRef: string; fullPayoutPolicyVersion: string; disclosureVersion: string } | null;
  roundingPolicy: string;
  reasonCodes: string[];
};
export type RentalMode = "ordinary" | "custom" | "fast";
export type DepositSkinFacts = {
  schema: "deposit-skin-facts-v1";
  gameId: string;
  listingVersionId: string;
  catalogRevision: string;
  skins: Array<{ skinId: string; ownerKind: SkinOwnerKind; rarityCode: string | null }>;
};
export type DepositRecommendation =
  | {
      available: true;
      amountCents: string;
      minCents: string;
      fullPayoutMinCents: string;
      capCents: string;
      policyVersion: string;
      recommendationSchema?: "deposit-recommendation-v1" | "deposit-recommendation-v2";
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
        skinFacts?: DepositSkinFacts;
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
/** Sealed full-payout terms accepted separately by the publishing owner and renter. */
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
export type RentalState = "RENTED" | "LISTED" | "PAUSED" | "REVIEWING" | "DRAFT" | "REJECTED" | "RESTRICTED" | "UNKNOWN";
export type AccountTitleFacts = {
  haffBase: string | null;
  safeBox: { code: string; displayName: string | null } | null;
  rank: { code: string; displayName: string | null } | null;
  level: number | null;
  vitLevel: number | null;
  bearLevel: number | null;
  rentalMode: string | null;
  ownerQuoteTotal: Money | null;
};
export type AccountDisplay = {
  displayNo: string | null;
  gameId: string;
  titleFacts: AccountTitleFacts | null;
  unknownReason: "VERSION_MISSING" | "DECLARATION_UNREADABLE" | "NOT_QUOTED" | null;
};
export type AccountActiveOrder = {
  id: string;
  displayNo: string;
  status: "PENDING_PAYMENT" | "PAID";
  renterName: string | null;
  termSeconds: string | null;
  startedAt: string | null;
  rentalDeadlineAt: string | null;
  ownerAmount: Money | null;
};
export type MyAccountRow = {
  id: string;
  display_no?: string | null;
  title: string | null;
  game_name: string;
  review_state: string | null;
  sequence: string | null;
  owner_paused: boolean;
  staff_restricted: boolean;
  historicalRead?: MySupply["historicalRead"];
  rentalState?: RentalState;
  accountDisplay?: AccountDisplay | null;
  activeOrder?: AccountActiveOrder | null;
  available?: boolean;
  blockers?: string[];
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
      items: Array<{ id: string; code?: string; name: string; unit: string; mediaId?: string | null }>;
      skins: PublicListingSkin[];
      entitlements: Array<{ id: string; name: string }>;
    };
    draftSkinSummary?: {
      source: "CURRENT_DRAFT_SELECTION";
      catalogRevision: string;
      items: PublicListingSkin[];
      withheld: number;
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
