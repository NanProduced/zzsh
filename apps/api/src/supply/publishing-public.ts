/**
 * 上架公开读域：公开列表投影、详情、可用性与公开字段脱敏。只读，不承接写入意图。
 */
import { effectiveRuleRelease } from "./effective-rule-release";
import { projectTenantMoney, projectTenantPriceQuote, publishedBaseRenterHaffRatioWanPerYuan, publishedListingFeeDisplay } from "./tenant-price-projection";
import { projectPublicListingImages, type PublicListingProjection } from "./legacy-path-projection";
import { readReleaseAgreement } from "./full-payout-terms";
import { parsePublicListingSearch } from "./listing-query";
import type { AccountImageCdn } from "./account-image-cdn";
import { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import { Pool, PoolClient } from "pg";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { computeContentHash } from "./content-hash";
import { projectDeltaQuote, type InternalQuote, type QuoteViewer } from "./pricing";
import { decimalToBigInt, formatDecimalExact, parseNonNegativeDecimal, parseSignedDecimal, yuanAmountObject } from "./decimal";
import { projectOwnerMediaBinding, projectPublicAttributeDisplay, projectPublicListingGame, projectPublicOffer, isEffectivePublicationState, mediaReviewAllowsPublication, type PublicMediaRoute } from "./listing-query";
import { conflict, invalid, notFound, sha256Hex } from "./supply-util";
import { GAME_SERVICE, readGameService, requirePublicGameService, type GameServiceState } from "./game-services";
import { readFundingPolicyForRelease } from "./funding-authority";
import { validateOwnerDepositDeclaration } from "./funding-policy";
import { publicAccountNumber } from "./account-number";
import { readScheduledDemoAccounts } from "../finance/controlled-fixed-fee-resource";
import { DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { boundListingPricingPolicy } from "./pricing-policy-schedule";
import { readLegacyListing, readLegacySkinHolding } from "./legacy-listing-read";
import { publicSkinMediaIdSql, publicSkinMetadataSql, publicSkinOwnerNameSql, publicSkinRarityNameSql } from "./catalog";
import { type ListingGameRow, type ListingMediaAssetRow, type ListingPageShared, type ListingPublication, type ListingVersion, type PublishingAccount, type SupplyGate, type SupplyGateReader, isRetiredMigratedAccount, publicMediaCategory, readBoundTermOption, readCurrentVersion, readCurrentVersions, readDeclaration, readListingPublication, readPublishingAccount, readPublishingAccounts } from "./publishing-internals";
import { freezePresentationSkin, type readPublishingOptions } from "./publishing-quote";
import { candidatePredicates, PUBLIC_CANDIDATE_FROM, PUBLIC_CANDIDATE_WHERE } from "./listing-candidates";
import { loadMediaAsset } from "./media";
import { isAccountDisplayPubliclyEligible, publicGradingOptions, publicLoginMethodOptions, publicSafeBoxCodes, publicSafeBoxOptions } from "./listing-query";
import { DELTA_CUSTOM_DAILY_CONSUMPTION, DELTA_INFO_SOURCE_DICTIONARY, DELTA_PUBLISH_LEVELS, deltaPublicationLevels } from "./delta-rental";
import { evaluatePublication } from "./publishing-review";

/** 公开列表 v1 的筛选事实；由路由解析查询参数后传入，投影不自己读 HTTP。 */
export type PublicListingPageFilter = { gameId: string | null; itemId: string | null; minQuantity: string | null; skins: string[]; skinMatch: string; q: ReturnType<typeof parsePublicListingSearch> };

/** A ratio is useful only when its account, game, release and frozen payload agree. */
export function boundBaseRenterRatio(account: PublishingAccount, version: ListingVersion): string | null {
  const payload = version.payload;
  if (!payload || !version.content_hash || version.account_id !== account.id || payload.accountId !== account.id || payload.gameId !== account.game_id || payload.ruleRefs?.releaseId !== version.rule_release_id) return null;
  try { return computeContentHash(payload) === version.content_hash ? publishedBaseRenterHaffRatioWanPerYuan(payload.quoteValues) : null; }
  catch { return null; }
}

export async function withPublicListingSnapshot<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    // One MVCC snapshot for visibility, quote and media; no exclusive row locks.
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    return read(client);
  });
}

export function listingPageShared(client: PoolClient): ListingPageShared {
  const games = new Map<string, Promise<ListingGameRow | undefined>>();
  const services = new Map<string, Promise<GameServiceState>>();
  const retired = new Map<string, Promise<boolean>>();
  const policies = new Map<
    string,
    Promise<Awaited<ReturnType<typeof readFundingPolicyForRelease>>>
  >();
  return {
    retiredLegacy: (account) => {
      let pending = retired.get(account.id);
      if (!pending) { pending = isRetiredMigratedAccount(client, account); retired.set(account.id, pending); }
      return pending;
    },
    primeRetiredLegacy: async (accountIds) => {
      const ids = [...new Set(accountIds)].filter(id => !retired.has(id));
      if (!ids.length) return;
      const rows = (await client.query<{ account_id: string }>(`SELECT DISTINCT m.account_id
        FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id
        JOIN zzsh_supply.game g ON g.id=a.game_id WHERE m.account_id=ANY($1::text[]) AND g.code='delta'
          AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'`, [ids])).rows;
      const found = new Set(rows.map(row => row.account_id));
      for (const id of ids) retired.set(id, Promise.resolve(found.has(id)));
    },
    game: (gameId) => {
      let pending = games.get(gameId);
      if (!pending) {
        pending = client
          .query<ListingGameRow>(
            `SELECT id,code,name,enabled,${effectiveRuleRelease("g")} AS current_release_id,catalog_revision::text FROM zzsh_supply.game g WHERE id=$1`,
            [gameId],
          )
          .then((result) => result.rows[0]);
        games.set(gameId, pending);
      }
      return pending;
    },
    rentalService: (gameId) => {
      let pending = services.get(gameId);
      if (!pending) {
        pending = readGameService(client, gameId, GAME_SERVICE.ACCOUNT_RENTAL);
        services.set(gameId, pending);
      }
      return pending;
    },
    fundingPolicy: (releaseId) => {
      let pending = policies.get(releaseId);
      if (!pending) {
        pending = readFundingPolicyForRelease(client, releaseId);
        policies.set(releaseId, pending);
      }
      return pending;
    },
  };
}

export type ListingDetailPrefetch = {
  /** Restricted account readers never fetch administrator review records. */
  includeReviewRecords?: boolean;
  /** Current version already loaded for the account; absent means "not loaded". */
  version?: ListingVersion | null;
  /** Answer to the publication probe, already resolved for this page. */
  hasPublication?: boolean;
  fixedFeeDemo?: DemoFinanceResource;
  fixedFeeDemoAccount?: boolean;
  shared?: ListingPageShared;
  /** This request's public projection of one account. The admin detail path and
   *  the supervision facts path need the same account's public listing, and the
   *  projection is one expensive read; the memo serves both. A null result
   *  means "no public listing" (the read answered 404). */
  publicListing?: (
    account: PublishingAccount,
  ) => Promise<PublicListingProjection | null>;
};

/** One page of candidates: accounts, current versions and the native-publication
 *  probe are read a window at a time instead of one round trip per candidate.
 *  The window is the caller's own page size, so a small limit never loads rows it
 *  will not project, and a rejected candidate just moves the window forward. */
export function listingCandidatePage(client: PoolClient, fixedFeeDemo?: { resource: DemoFinanceResource; accountIds: readonly string[] }) {
  const shared = listingPageShared(client);
  const accounts = new Map<string, PublishingAccount | undefined>();
  const versions = new Map<string, ListingVersion | null>();
  const published = new Set<string>();
  let demoAccounts: Promise<Set<string>> | undefined;
  return {
    shared,
    has: (id: string) => accounts.has(id),
    account: (id: string) => accounts.get(id),
    version: (id: string) => versions.get(id) ?? null,
    fixedFeeDemoAccount: async (id: string) => {
      if (!fixedFeeDemo || !versions.get(id)?.payload?.pricingPolicy) return false;
      demoAccounts ??= readScheduledDemoAccounts(client, fixedFeeDemo.resource, fixedFeeDemo.accountIds, "READ");
      return (await demoAccounts).has(id);
    },
    /** Only meaningful for ids covered by a load() that asked for publications. */
    hasPublication: (id: string) => published.has(id),
    async load(ids: readonly string[], withPublications = false): Promise<void> {
      const pending = [...new Set(ids)].filter((id) => !accounts.has(id));
      if (!pending.length) return;
      const found = await readPublishingAccounts(client, pending);
      const byAccount = await readCurrentVersions(client, [...found.values()]);
      for (const id of pending) {
        const account = found.get(id);
        accounts.set(id, account);
        versions.set(id, account ? byAccount.get(id) ?? null : null);
      }
      await shared.primeRetiredLegacy(pending);
      if (!withPublications) return;
      const rows = (
        await client.query<{ account_id: string }>(
          `SELECT DISTINCT account_id FROM zzsh_supply.listing_publication WHERE account_id = ANY($1::text[])`,
          [pending],
        )
      ).rows;
      for (const row of rows) published.add(row.account_id);
    },
  };
}

/** One request's public listing projection per account. The admin detail path
 *  and the supervision facts path ask for the same account's public listing;
 *  reading it once per request keeps one projection per account instead of one
 *  per caller. A null result means "no public listing" (the read answered 404);
 *  any other failure still throws. */
export type PublicListingMemo = {
  read(
    account: PublishingAccount,
    prefetch?: ListingDetailPrefetch,
  ): Promise<PublicListingProjection | null>;
};

export function publicListingMemo(
  client: PoolClient,
  gate: SupplyGateReader,
): PublicListingMemo {
  const pending = new Map<string, Promise<PublicListingProjection | null>>();
  return {
    read: (account, prefetch) => {
      let open = pending.get(account.id);
      if (!open) {
        open = listingDetail(
          client,
          account,
          "public",
          gate,
          "public",
          account,
          false,
          "DETAIL",
          prefetch,
        ).catch((error) => {
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        });
        pending.set(account.id, open);
      }
      return open;
    },
  };
}

export async function readPresentation(
  client: PoolClient,
  v: ListingVersion,
): Promise<Record<string, unknown>> {
  const rawItems = Array.isArray(v.presentation.items)
    ? v.presentation.items
    : [];
  const itemRefs = rawItems.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string",
  );
  const rawSkins = Array.isArray(v.presentation.skins)
    ? v.presentation.skins
    : [];
  if (!itemRefs.length)
    return v.presentation;
  const itemRows = itemRefs.length
    ? (
      await client.query<{ id: string; code: string; name: string; unit: string; mediaId: string | null }>(
        `SELECT i.id,i.code,i.name,i.unit,m.id AS "mediaId" FROM zzsh_supply.billable_item i
          JOIN zzsh_supply.rental_account a ON a.id=$2 AND a.game_id=i.game_id
          LEFT JOIN zzsh_supply.media_asset m ON m.id=i.media_id AND m.game_id=i.game_id
            AND i.enabled AND m.ownership_kind='PLATFORM_CATALOG' AND m.purpose='ITEM_MEDIA'
            AND m.review_state='APPROVED' AND m.access_class='PUBLIC_DISPLAY' AND m.public_storage_key IS NOT NULL
          WHERE i.id=ANY($1::text[])`,
        [itemRefs.map((item) => item.id as string), v.account_id],
      )
    ).rows
    : [];
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  return {
    ...v.presentation,
    items: rawItems.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { id?: unknown }).id !== "string"
      )
        return item;
      const current = item as Record<string, unknown>;
      const catalog = itemById.get((current as { id: string }).id);
      return catalog
        ? {
            ...current,
            mediaId: catalog.mediaId ?? null,
            ...(typeof current.code === "string" ? {} : { code: catalog.code }),
            ...(typeof current.name === "string" ? {} : { name: catalog.name }),
            ...(typeof current.unit === "string" ? {} : { unit: catalog.unit }),
          }
        : { ...current, mediaId: null };
    }),
    skins: rawSkins,
  };
}

export function publicationHasUnknownFacts(blockers:readonly string[]):boolean {
  return blockers.some(reason=>["FUNDING_UNKNOWN","OCCUPANCY_UNKNOWN","PUBLISHER_BAIL_UNCONFIRMED"].includes(reason));
}

async function resolvePublicMediaRoute(
  client: PoolClient,
  publicAccount: PublishingAccount,
  gate: SupplyGateReader,
  prefetch?: ListingDetailPrefetch,
): Promise<PublicMediaRoute> {
  let listing: Record<string, unknown> | null = null;
  try {
    listing = prefetch?.publicListing
      ? await prefetch.publicListing(publicAccount)
      : await listingDetail(client, publicAccount, "public", gate, "public", publicAccount, false, "DETAIL", prefetch);
  }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  return {
    listingPublic: Boolean(listing),
    displayAssetIds: new Set(Array.isArray(listing?.media) ? listing.media.map((media: { assetId: string }) => media.assetId) : []),
    ownerUserId: publicAccount.owner_user_id,
  };
}

async function readInventoryCatalogLabels(
  client: PoolClient,
  itemIds: string[],
): Promise<Array<{ id: string; code: string; name: string; unit: string; priced: boolean }>> {
  if (!itemIds.length) return [];
  return (
    await client.query<{ id: string; code: string; name: string; unit: string; priced: boolean }>(
      `SELECT i.id, i.code, i.name, i.unit,
              EXISTS (
                SELECT 1 FROM zzsh_supply.game g
                JOIN zzsh_supply.rule_release r ON r.id = ${effectiveRuleRelease("g")}
                JOIN zzsh_supply.price_line p ON p.price_version_id = r.price_version_id
                 AND p.item_id = i.id AND p.customer_tier = 'STANDARD'
                WHERE g.id = i.game_id
              ) AS priced
         FROM zzsh_supply.billable_item i
        WHERE i.id = ANY($1::text[])
        ORDER BY i.sort_order, i.code, i.id`,
      [itemIds],
    )
  ).rows;
}

async function readOwnerDeclaration(
  client: PoolClient,
  v: ListingVersion,
  publicRoute: PublicMediaRoute,
): Promise<Record<string, unknown>> {
  const declaration = await readDeclaration(client, v);
  const media = (
    await client.query<{
      assetId: string;
      position: number;
      purpose: string | null;
      byteHash: string | null;
      reviewState: string | null;
      accessClass: string | null;
      publicStorageKey: string | null;
      technicalState: string | null;
      ownerUserId: string | null;
      category: string | null;
    }>(
      `SELECT m.asset_id AS "assetId",m.position,a.purpose,a.content_hash AS "byteHash",a.review_state AS "reviewState",a.access_class AS "accessClass",a.public_storage_key AS "publicStorageKey",a.technical_state AS "technicalState",a.owner_user_id AS "ownerUserId",a.source_note AS "category" FROM zzsh_supply.listing_media m LEFT JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1 ORDER BY m.position,m.asset_id`,
      [v.id],
    )
  ).rows;
  return {
    ...declaration,
    mediaBindings: media.map((row) => ({
      ...projectOwnerMediaBinding(row, publicRoute),
      category: publicMediaCategory(v.attributes, row.assetId, row.category),
    })),
  };
}

export async function readDraftSkinSummary(client: PoolClient, gameId: string, skinIds: string[]): Promise<Record<string, unknown>> {
  const found = (await client.query<{ revision: string; items: Record<string, unknown>[] }>(
    `SELECT g.catalog_revision::text AS revision, COALESCE((
       SELECT jsonb_agg(entry) FROM (
         SELECT s.id,s.name,s.base_name,true AS category_retired,${publicSkinOwnerNameSql("s")} AS owner_name,s.owner_kind,
                s.rarity_code,${publicSkinRarityNameSql("s")} AS rarity_name,${publicSkinMetadataSql("s")},
                ${publicSkinMediaIdSql("s")} AS media_id,NULL::text AS category_code,NULL::text AS category_name
           FROM zzsh_supply.skin s
          WHERE s.game_id=$1 AND s.id=ANY($2::text[]) AND s.naming_state='VERIFIED'
            AND s.enabled=true AND s.form_visible=true
          ORDER BY s.sort_order,s.name COLLATE "C",s.id
       ) entry
     ),'[]'::jsonb) AS items FROM zzsh_supply.game g WHERE g.id=$1`,
    [gameId, skinIds],
  )).rows[0];
  if (!found) throw notFound();
  return { source: "CURRENT_DRAFT_SELECTION", catalogRevision: found.revision, items: found.items.map(freezePresentationSkin), withheld: skinIds.length - found.items.length };
}

const PUBLIC_LISTING_ATTRIBUTE_KEYS = ["vit_level", "bear_level", "dive_level", "character_level", "grading_code", "login_method_code", "region_province", "region_city", "safe_box_code", "secret_kd", "service_window_start_minute", "service_window_end_minute", "service_window_timezone", "service_window_cross_midnight"] as const;

/** Public read of the stored declaration. Absent booleans stay null; this does not write the payload or its hash. */
export function publicListingAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const declared = (key: string) => attrs[key] === true ? true : attrs[key] === false ? false : null;
  return {
    ...Object.fromEntries([...PUBLIC_LISTING_ATTRIBUTE_KEYS, ...(Object.hasOwn(attrs, "grading_division") ? ["grading_division"] as const : [])].map((key) => [key, attrs[key] ?? null])),
    face_is_self: declared("face_is_self"),
    ban_record: declared("ban_record"),
    next_season_pass: declared("next_season_pass"),
    demulan_unlocked: declared("demulan_unlocked"),
  };
}

const MIGRATION_TITLE = "历史资料待核实";

/**
 * The legacy importer stores this placeholder instead of a title when the source has no readable
 * declaration. It is a marker for "no title", not an account name: a read model that returns it makes
 * every imported account look like it is called "历史资料待核实". Readers therefore expose null and let
 * the caller fall back to the account number, while the unknown reason stays in titleFacts/unknownReason
 * (DECLARATION_UNREADABLE / VERSION_MISSING / NOT_QUOTED) instead of a fabricated name.
 */
export function declaredTitleOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return !title || title.includes(MIGRATION_TITLE) ? null : title;
}

/** Order snapshot title and the account's current title are different facts. A placeholder is not either title. */
/** Fields the renter already received. Admin keeps its own current version beside this. */
export function publicListingBasis(listing: Record<string, unknown>) {
  const id = typeof listing.versionId === "string" ? listing.versionId : null;
  if (!id) return null;
  return {
    id,
    releaseId: typeof listing.releaseId === "string" ? listing.releaseId : null,
    contentHash: typeof listing.contentHash === "string" ? listing.contentHash : null,
    accountId: typeof listing.id === "string" ? listing.id : null,
    title: typeof listing.title === "string" ? listing.title : null,
    description: typeof listing.description === "string" ? listing.description : null,
    attributes: listing.attributes && typeof listing.attributes === "object" ? listing.attributes : null,
    attributeDisplay: listing.attributeDisplay && typeof listing.attributeDisplay === "object" ? listing.attributeDisplay : null,
    presentation: listing.presentation && typeof listing.presentation === "object" ? listing.presentation : null,
    media: Array.isArray(listing.media) ? listing.media : [],
    ...(Array.isArray(listing.legacyImages) ? { legacyImages: listing.legacyImages } : {}),
    quote: listing.quote && typeof listing.quote === "object" ? listing.quote : null,
    feeDisplay: listing.feeDisplay && typeof listing.feeDisplay === "object" ? listing.feeDisplay : null,
    baseDeposit: listing.baseDeposit && typeof listing.baseDeposit === "object" ? listing.baseDeposit : null,
    termOption: listing.termOption && typeof listing.termOption === "object" ? listing.termOption : null,
    fullPayoutSelected: listing.fullPayoutSelected === true ? true : listing.fullPayoutSelected === false ? false : null,
    publishedAt: typeof listing.publishedAt === "string" ? listing.publishedAt : null,
  };
}

export function orderAccountTitleFact(input: { snapshotTitle?: unknown; currentTitle?: unknown; resourceSummary?: unknown }) {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const missing = (value: string) => !value || value.includes(MIGRATION_TITLE);
  const snapshot = text(input.snapshotTitle), current = text(input.currentTitle), summary = text(input.resourceSummary);
  return {
    orderTitle: missing(snapshot) ? null : snapshot,
    orderTitleSource: missing(snapshot) ? "UNKNOWN" as const : "SNAPSHOT" as const,
    currentAccountTitle: missing(current) ? null : current,
    currentAccountSource: missing(current) ? "UNKNOWN" as const : "CURRENT_ACCOUNT" as const,
    neutralSummary: summary || null,
  };
}

export type PublicAvailabilityState = "RENTABLE" | "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | "OFFLINE" | "UNKNOWN" | "UNAVAILABLE" | "LEGACY_READ_ONLY";

export type PublicListingReadMode = "RENTABLE" | "DETAIL";

const READABLE_NON_RENTAL_BLOCKERS = new Set(["OWNER_PAUSED", "OCCUPIED", "OCCUPANCY_UNKNOWN", "PUBLISHER_BAIL_UNCONFIRMED", "FUNDING_UNKNOWN", "RULE_CHANGED", "CONFIRMATION_OR_MEDIA_REQUIRED", "QUOTE_REQUIRED", "ACCEPTANCE_REQUIRED", "MEDIA_REQUIRED", "LEGACY_LISTING_RELIST_REQUIRED"]);

export function publicAvailability(blockers: readonly string[], current: boolean, gate: SupplyGate | null): PublicAvailabilityState {
  if (!current || blockers.includes("OWNER_PAUSED")) return "OFFLINE";
  if (blockers.includes("OCCUPIED")) return gate?.occupancyKind === "PENDING_PAYMENT" || gate?.occupancyKind === "RENTED" ? gate.occupancyKind : "OCCUPIED";
  if (publicationHasUnknownFacts(blockers)) return "UNKNOWN";
  return blockers.length ? "UNAVAILABLE" : "RENTABLE";
}

function publicAvailabilityReason(state: PublicAvailabilityState, blockers: readonly string[]) {
  if (state === "RENTABLE") return null;
  if (state === "OFFLINE") return blockers.includes("OWNER_PAUSED") ? "OWNER_PAUSED" : "VERSION_INACTIVE";
  if (state === "PENDING_PAYMENT" || state === "RENTED" || state === "OCCUPIED") return "OCCUPIED";
  return blockers.find(reason => READABLE_NON_RENTAL_BLOCKERS.has(reason) && (state !== "UNKNOWN" || publicationHasUnknownFacts([reason]))) ?? null;
}

// Native publication owns the stable account even when it cannot take a new
// order. Detail/favorites may show that approved version, never an old legacy
// fallback or an unreviewed current draft.
export async function readPublicListingSnapshot(
  client: PoolClient,
  a: PublishingAccount,
  gate: SupplyGateReader,
  admission?: LegacyPublicAdmission,
  strictReadErrors = false,
  mode: PublicListingReadMode = "DETAIL",
  detailIndex?: LegacyPublicAdmissionDetailIndex,
  prefetch?: ListingDetailPrefetch,
): Promise<PublicListingProjection> {
  const hasPublication = prefetch?.hasPublication ??
    Boolean(
      (
        await client.query(
          `SELECT 1 FROM zzsh_supply.listing_publication WHERE account_id=$1 LIMIT 1`,
          [a.id],
        )
      ).rowCount,
    );
  if (hasPublication) {
    // The request's public projection is the same read this path would make.
    if (prefetch?.publicListing && !strictReadErrors && mode === "DETAIL") {
      const listing = await prefetch.publicListing(a);
      if (!listing) throw notFound();
      return listing;
    }
    return listingDetail(client, a, "public", gate, "public", a, strictReadErrors, mode, prefetch);
  }
  if (mode === "RENTABLE") throw notFound();
  return readLegacyListing(client, a.id, admission, detailIndex);
}

export async function readPublicListing(...args: Parameters<typeof readPublicListingSnapshot>): Promise<PublicListingProjection> {
  const [listing] = await projectPublicListingImages(args[0], [await readPublicListingSnapshot(...args)]);
  return listing!;
}

/** Display-only fallback from the same sealed declaration; never changes the stored quote or its hash. */
export function publicDepositProjection(quote: unknown, declaration: unknown): { tenantDeposit: ReturnType<typeof yuanAmountObject>; tenantPayableTotal: ReturnType<typeof yuanAmountObject> | null } | null {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return null;
  const projected = quote as Record<string, unknown>;
  if (projected.currency !== "CNY" || projected.tenantDeposit !== null) return null;
  let declared;
  try { declared = validateOwnerDepositDeclaration(declaration); } catch { return null; }
  if (!declared) return null;
  const tenantDeposit = yuanAmountObject(BigInt(declared.amountCents));
  let tenantPayableTotal: ReturnType<typeof yuanAmountObject> | null = null;
  try {
    const resource = projectTenantMoney(projected.resourceTotal);
    const resourceCents = decimalToBigInt(parseNonNegativeDecimal(resource.amount, 2, "resource total"), 2);
    const lines = Array.isArray(projected.lines) ? projected.lines : [];
    let lineCents = 0n, complete = lines.length > 0;
    for (const line of lines) {
      if (!line || typeof line !== "object" || Array.isArray(line)) throw invalid("Public quote line is invalid");
      if (line.buyerAmount == null) { complete = false; continue; }
      const amount = projectTenantMoney(line.buyerAmount);
      lineCents += decimalToBigInt(parseNonNegativeDecimal(amount.amount, 2, "resource line"), 2);
    }
    if (lineCents <= resourceCents && (!complete || lineCents === resourceCents)) tenantPayableTotal = yuanAmountObject(resourceCents + BigInt(declared.amountCents));
  } catch { /* A known deposit does not turn unavailable or conflicting resource money into a total. */ }
  return { tenantDeposit, tenantPayableTotal };
}

export function listingDetail(
  client: PoolClient, a: PublishingAccount, viewer: "public", gate: SupplyGateReader,
  quoteViewer?: QuoteViewer, publicAccount?: PublishingAccount, strictReadErrors?: boolean,
  mode?: PublicListingReadMode, prefetch?: ListingDetailPrefetch,
): Promise<PublicListingProjection>;

export function listingDetail(
  client: PoolClient, a: PublishingAccount, viewer: QuoteViewer, gate: SupplyGateReader,
  quoteViewer?: QuoteViewer, publicAccount?: PublishingAccount, strictReadErrors?: boolean,
  mode?: PublicListingReadMode, prefetch?: ListingDetailPrefetch,
): Promise<Record<string, unknown>>;

export async function listingDetail(
  client: PoolClient,
  a: PublishingAccount,
  viewer: QuoteViewer,
  gate: SupplyGateReader,
  quoteViewer: QuoteViewer = viewer,
  publicAccount: PublishingAccount = a,
  strictReadErrors = false,
  mode: PublicListingReadMode = "RENTABLE",
  prefetch?: ListingDetailPrefetch,
): Promise<Record<string, unknown>> {
  let v = prefetch?.version !== undefined
    ? prefetch.version
    : a.current_version_id
      ? await readCurrentVersion(client, a)
      : null;
  if (viewer === "public" && mode === "DETAIL") {
    const currentPublication = v ? await readListingPublication(client, a, v) : null;
    if (!v || !isEffectivePublicationState(v.review_state, currentPublication?.source)) {
      v = (await client.query<ListingVersion>(
        `SELECT v.* FROM zzsh_supply.listing_version v JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=v.account_id
         WHERE v.account_id=$1 AND p.owner_user_id=$2 AND p.game_id=$3 AND p.rule_release_id=v.rule_release_id AND p.content_hash=v.content_hash
          AND ((v.review_state='PUBLISHED' AND p.source='OWNER_DIRECT') OR (v.review_state='APPROVED' AND p.source='LEGACY_APPROVED'))
         ORDER BY p.published_at DESC,v.sequence DESC,v.id LIMIT 1`, [a.id, a.owner_user_id, a.game_id],
      )).rows[0] ?? null;
    }
  }
  if (!v) {
    if (viewer === "public") throw notFound();
    const retiredLegacy = await isRetiredMigratedAccount(client, a);
    return { account: viewer === "owner" ? { ...a, display_no: publicAccountNumber(a.display_no) } : a, version: null,
      ...(retiredLegacy ? { available: false, blockers: ["LEGACY_LISTING_RELIST_REQUIRED"] } : {}) };
  }
  const observed = { gate: null as SupplyGate | null, publication: undefined as ListingPublication | null | undefined };
  // The readiness check and the public projection read the same version's media;
  // one lazy read serves both, and the request-level memo serves the game row.
  let mediaRows: ListingMediaAssetRow[] | undefined;
  const loadMedia = async (): Promise<ListingMediaAssetRow[]> =>
    (mediaRows ??= (
      await client.query<ListingMediaAssetRow>(
        `SELECT a.* FROM zzsh_supply.listing_media m LEFT JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1`,
        [v.id],
      )
    ).rows);
  const blockers = await evaluatePublication(client, a, v, async (client, account, purpose) => {
    observed.gate = await gate(client, account, purpose);
    return observed.gate;
  }, "READ", strictReadErrors, prefetch?.shared, loadMedia, observed);
  // evaluatePublication already read this publication for the same account and
  // version; only a divergent publicAccount needs its own read.
  const publication = observed.publication !== undefined && publicAccount === a
    ? observed.publication
    : await readListingPublication(client, publicAccount, v);
  const quote = v.payload && viewer !== "public"
    ? { ...projectDeltaQuote(
        { ...v.payload.quoteValues, contentHash: v.content_hash } as unknown as InternalQuote, quoteViewer,
      ), baseRenterHaffRatioWanPerYuan: boundBaseRenterRatio(a, v), ...(v.payload.ruleRefs.catalogRevision === undefined ? {} : { catalogRevision: v.payload.ruleRefs.catalogRevision }) }
    : null;
  if (viewer === "public") {
    if (!v.payload || v.payload.accountId !== a.id || v.payload.gameId !== a.game_id || computeContentHash(v.payload) !== v.content_hash) throw notFound();
    if (mode === "DETAIL" && !(await client.query(
      `SELECT 1 FROM zzsh_supply.rule_acceptance WHERE account_id=$1 AND listing_version_id=$2 AND rule_release_id=$3 AND accepted_content_hash=$4 AND owner_user_id=$5`,
      [a.id, v.id, v.rule_release_id, v.content_hash, a.owner_user_id],
    )).rowCount) throw notFound();
    if (strictReadErrors && publicationHasUnknownFacts(blockers)) throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Public listing facts are incomplete");
    if ((mode === "RENTABLE" ? blockers : blockers.filter(reason => !READABLE_NON_RENTAL_BLOCKERS.has(reason))).length) throw notFound();
    let availability = publicAvailability(blockers, publicAccount.current_version_id === v.id, observed.gate);
    if (mode === "RENTABLE" && availability !== "RENTABLE") throw notFound();
    const payload = v.payload;
    const attrs = payload.declaration.attributes;
    let quote = projectTenantPriceQuote(payload.quoteValues as unknown as InternalQuote, payload.quoteValues) as
      (ReturnType<typeof projectTenantPriceQuote> & { catalogRevision?: string }) | null;
    let priceReason: string | null = null;
    if (payload.schemaVersion === 4 || payload.pricingPolicy) {
      if (publication?.source !== "OWNER_DIRECT" || !boundListingPricingPolicy(payload, publication.publishedAtExact ?? publication.published_at)) quote = null;
      const tradeEnabled = prefetch?.fixedFeeDemoAccount ?? Boolean(prefetch?.fixedFeeDemo
        && (await readScheduledDemoAccounts(client, prefetch.fixedFeeDemo, [a.id], "READ")).has(a.id));
      if (availability === "RENTABLE" && (!quote || !tradeEnabled)) {
        availability = quote ? "UNAVAILABLE" : "UNKNOWN";
        priceReason = quote ? "TRADE_NOT_ENABLED" : "PRICING_UNAVAILABLE";
      }
    }
    if (quote && payload.ruleRefs.catalogRevision !== undefined) quote.catalogRevision = payload.ruleRefs.catalogRevision;
    const depositProjection = publicDepositProjection(quote, attrs.owner_deposit_declaration);
    if (depositProjection && quote) Object.assign(quote, depositProjection);
    const offer = projectPublicOffer({
      attributes: attrs,
      termOptionCode: v.term_option_code,
      boundTerm: await readBoundTermOption(client, v),
    });
    const attributeDisplay = projectPublicAttributeDisplay(attrs);
    const presentation = await readPresentation(client, v);
    // The renter must accept the sealed full-payout terms before confirming; the client needs
    // the owner's declaration before it can read those terms. A missing declaration is unknown,
    // never "普通赔付".
    const fullPayoutDeclaration = attrs.full_payout_declaration as { schema?: unknown; selected?: unknown } | undefined;
    const fullPayoutSelected = fullPayoutDeclaration?.schema === "full-payout-declaration-v1" && typeof fullPayoutDeclaration.selected === "boolean"
      ? fullPayoutDeclaration.selected : null;
    const publicAttrs = publicListingAttributes(attrs);
    const game = prefetch?.shared
      ? ((await prefetch.shared.game(a.game_id)) as ListingGameRow | undefined)
      : (
          await client.query<ListingGameRow>(
            `SELECT id,code,name,enabled,${effectiveRuleRelease("g")} AS current_release_id,catalog_revision::text FROM zzsh_supply.game g WHERE id=$1`,
            [a.game_id],
          )
        ).rows[0];
    const currentMedia = await loadMedia();
    const publicMedia = v.payload!.declaration.mediaBindings.filter(binding => binding.purpose === "ACCOUNT_DISPLAY" && currentMedia.some(asset =>
      asset.id === binding.assetId && asset.content_hash === binding.byteHash && asset.purpose === "ACCOUNT_DISPLAY" && asset.ownership_kind === "USER_SUPPLY" &&
      asset.owner_user_id === a.owner_user_id && asset.account_id === a.id && asset.game_id === a.game_id && asset.technical_state === "READY" &&
      mediaReviewAllowsPublication(asset.review_state) && asset.access_class === "PUBLIC_DISPLAY" && Boolean(asset.public_storage_key)));
    const legacyCategories = Object.hasOwn(attrs, "media_categories") ? [] : (await client.query<{assetId:string; category:string|null}>(
      `SELECT id AS "assetId",source_note AS category FROM zzsh_supply.media_asset WHERE id=ANY($1::text[])`,
      [publicMedia.map(m => m.assetId)],
    )).rows;
    const depositDeclaration = attrs.owner_deposit_declaration as { schema?: unknown; amountCents?: unknown } | undefined;
    const baseDeposit = depositDeclaration?.schema === "owner-deposit-declaration-v1" && typeof depositDeclaration.amountCents === "string"
      ? { amountCents: depositDeclaration.amountCents } : null;
    return {
      baseDeposit,
      id: a.id,
      displayNo: publicAccountNumber(a.display_no),
      versionId: v.id,
      releaseId: v.rule_release_id,
      title: v.title,
      description: v.description,
      game: projectPublicListingGame(game),
      attributes: publicAttrs,
      safeBox: offer.safeBox,
      termOption: offer.termOption,
      attributeDisplay,
      fullPayoutSelected,
      presentation,
      quote,
      feeDisplay: publishedListingFeeDisplay(quote),
      availability: { state: availability, reason: priceReason ?? publicAvailabilityReason(availability, blockers) },
      canCreateOrder: availability === "RENTABLE",
      publishedAt: publication?.published_at?.toISOString() ?? null,
      media: publicMedia.map((m) => ({
        assetId: m.assetId,
        position: m.position,
        category: publicMediaCategory(attrs, m.assetId, legacyCategories.find(row => row.assetId === m.assetId)?.category),
        url: `/api/v1/supply/listings/${a.id}/media/${m.assetId}`,
      })),
    } satisfies PublicListingProjection;
  }
  const publicRoute = await resolvePublicMediaRoute(
    client,
    publicAccount,
    gate,
    prefetch,
  );
  const decisions = prefetch?.includeReviewRecords === false ? [] : (
    await client.query(
      `SELECT d.id,d.version_id,d.decision,d.reason,d.decided_at,u.name AS reviewer_name FROM zzsh_supply.review_decision d JOIN zzsh_auth_admin."user" u ON u.id=d.reviewer_admin_id JOIN zzsh_supply.listing_version v ON v.id=d.version_id WHERE v.account_id=$1 ORDER BY d.decided_at`,
      [a.id],
    )
  ).rows;
  const ownerName =
    (
      await client.query(`SELECT name FROM zzsh_auth_user."user" WHERE id=$1`, [
        a.owner_user_id,
      ])
    ).rows[0]?.name ?? "号主";
  const agreement = v.rule_release_id ? await readReleaseAgreement(client, a.game_id, v.rule_release_id) : null;
  const ownerOffer = projectPublicOffer({
    attributes: v.attributes,
    termOptionCode: v.term_option_code,
    boundTerm: await readBoundTermOption(client, v),
  });
  const presentation = await readPresentation(client, v);
  const declaration = await readOwnerDeclaration(client, v, publicRoute);
  // An edited draft can retain an old presentation; only a hash-bound quote is frozen display authority.
  const draftSkinSummary = v.origin === "NATIVE" && v.review_state === "DRAFT" && v.content_hash === null
    ? await readDraftSkinSummary(client, a.game_id, declaration.skins as string[])
    : undefined;
  const catalogItems = await readInventoryCatalogLabels(
    client,
    (declaration.inventory as Array<{ itemId: string }>).map((item) => item.itemId),
  );
  return {
    ownerName,
    agreement,
    account: viewer === "owner" ? { ...a, display_no: publicAccountNumber(a.display_no) } : a,
    version: {
      schemaVersion: v.schema_version,
      id: v.id,
      sequence: v.sequence,
      origin: v.origin,
      reviewState: v.review_state,
      revision: v.revision,
      releaseId: v.rule_release_id,
      contentHash: v.content_hash,
      publication: publication ? {
        source: publication.source,
        publishedAt: publication.published_at.toISOString(),
        ...(viewer === "admin" && typeof v.payload?.quoteValues.priceVersionId === "string"
          ? { priceVersionId: v.payload.quoteValues.priceVersionId } : {}),
      } : null,
      safeBox: ownerOffer.safeBox,
      termOption: ownerOffer.termOption,
      attributeDisplay: projectPublicAttributeDisplay(v.attributes),
      declaration,
      catalogItems,
      ...(draftSkinSummary ? { draftSkinSummary } : {}),
      ...(v.origin === "LEGACY_OBSERVATION" ? { legacySkinHolding: await readLegacySkinHolding(client, a.id, v.id, a.game_id, v.origin) } : {}),
      presentation,
      quote,
      feeDisplay: publication ? publishedListingFeeDisplay(quote) : null,
    },
    available: !blockers.length,
    blockers,
    occupancyKind: observed.gate?.occupancy === "OCCUPIED" ? (observed.gate.occupancyKind === "PENDING_PAYMENT" || observed.gate.occupancyKind === "RENTED" ? observed.gate.occupancyKind : "OCCUPIED") : null,
    decisions,
  };
}

/** 上架选项的公开投影：只呈现规则允许公开的档位与租期，未证明的调整保持 unknown。 */
export function projectPublishingOptions(result: Awaited<ReturnType<typeof readPublishingOptions>>, accountMediaTransport?: "OSS_POST") {
    const {release,terms,bodyDocument}=result;
    const rule = result.rule as {
      schema?: string;
      compatibility?: import("./delta-rental").DeltaCompatPricing;
      fixedModes?: import("./delta-rental").DeltaHaffRule["fixedModes"];
      baseBySafeBox?: Record<string, string>;
      options?: Record<string, { enabled: boolean }>;
      vitalityDeltaByLevel?: Record<string,string>;
      bearDeltaByLevel?: Record<string,string>;
      dailyDeltaByTermOption?: Record<string,string>;
    } | null;
    const mappedTerms = terms.filter(term => Object.hasOwn(rule?.dailyDeltaByTermOption ?? {}, term.code));
    const customTerms = mappedTerms.filter(term => term.dailyConsumption === DELTA_CUSTOM_DAILY_CONSUMPTION);
    const modes=rule?.schema==="haff-ratio-v3"?rule.fixedModes:rule?.compatibility?.modes;
    const customEnabled = modes?.custom?.enabled === true && customTerms.length > 0;
    const termOptions = terms.map(term => {
      let adjustment: string | null = null;
      const value = rule?.dailyDeltaByTermOption?.[term.code];
      if (typeof value === "string") try { adjustment = formatDecimalExact(parseSignedDecimal(value, 8, "daily ratio adjustment")); } catch { /* An unproved adjustment stays unknown. */ }
      return { ...term, ownerRatioAdjustmentWanPerYuan: adjustment };
    });
    return       {
        releaseId: release.releaseId,
        generation: release.generation,
        ...(accountMediaTransport ? { accountMediaTransport } : {}),
        termOptions,
        declarationOptions: {
          next_season_pass: { enabled: true, required: true, requiredAt: "QUOTE_AND_PUBLICATION", label: "下赛季通行证计划", type: "BOOLEAN", public: true },
          demulan_unlocked: { enabled: true, required: true, requiredAt: "QUOTE_AND_PUBLICATION", label: "是否已解锁德穆兰", type: "BOOLEAN", public: true },
          info_source: { enabled: true, required: false, label: "通过哪个渠道了解洲洲商行", public: false, options: DELTA_INFO_SOURCE_DICTIONARY.options, optionsState: "CONFIGURED", sourceSnapshot: DELTA_INFO_SOURCE_DICTIONARY.sourceSnapshot, acceptsLegacyText: true },
        },
        vitalityLevels:[...DELTA_PUBLISH_LEVELS],
        bearLevels:[...DELTA_PUBLISH_LEVELS],
        diveLevels:[0,1,2,3],
        safeBoxCodes: publicSafeBoxCodes(),
        safeBoxOptions: publicSafeBoxOptions(publicSafeBoxCodes()),
        pricingInputOptions: {
          safeBoxCodes: publicSafeBoxCodes().filter(code=>Object.hasOwn(rule?.baseBySafeBox??{},code)),
          vitalityLevels: deltaPublicationLevels(rule?.vitalityDeltaByLevel),
          bearLevels: deltaPublicationLevels(rule?.bearDeltaByLevel),
        },
        gradingOptions: publicGradingOptions(),
        loginMethodOptions: publicLoginMethodOptions(),
        pricingOptionCodes: Object.entries(rule?.options ?? {})
          .filter(([, v]) => v.enabled)
          .map(([key]) => key)
          .sort(),
        ...(["haff-ratio-v2","haff-ratio-v3"].includes(rule?.schema??"") ? {
          pricingSchema: rule!.schema,
          rentalModes: modes ? { ...modes, custom: { ...modes.custom, enabled: customEnabled } } : undefined,
          rentalTermOptions: {
            ordinary: { termOptionCodes: mappedTerms.map(term => term.code) },
            custom: { termOptionCodes: customTerms.map(term => term.code), requiredDailyConsumption: DELTA_CUSTOM_DAILY_CONSUMPTION, reasonCodes: !customTerms.length ? ["CUSTOM_10M_TERM_UNAVAILABLE"] : [] },
            fast: { termOptionCodes: mappedTerms.map(term => term.code) },
          },
        } : {}),
        ...(result.pricingPolicy?{pricingPolicy:result.pricingPolicy,fixedFeeRates:result.fixedFeeRates}:{}),
        agreement: {
          id: release.agreement_id,
          title: release.title,
          body: release.body,
          digest: release.digest,
          ...(bodyDocument ? { bodyDocument } : {}),
        },
      };
}

/** 公开详情或单张公开展示图；图片归属、用途与版本绑定都在此判定，路由只负责字节流。 */
export async function readPublicListingDetailOrAsset(
  client: PoolClient,
  accountId: string,
  assetId: string | undefined,
  opts: { gate: SupplyGateReader; legacyPublicAdmission?: LegacyPublicAdmission; legacyPublicAdmissionDetail?: LegacyPublicAdmissionDetailIndex; fixedFeeDemo?: DemoFinanceResource; accountImageCdn?: AccountImageCdn },
) {
          const a = await readPublishingAccount(client, accountId);
          const detail = await readPublicListingSnapshot(client, a, opts.gate, opts.legacyPublicAdmission, false, "DETAIL", opts.legacyPublicAdmissionDetail, { fixedFeeDemo: opts.fixedFeeDemo });
          if (!assetId) return { detail: (await projectPublicListingImages(client, [detail], opts.accountImageCdn))[0]! };
          if (!Array.isArray(detail.media) || !detail.media.some((media: { assetId?: string }) => media.assetId === assetId)) throw notFound();
          const asset = await loadMediaAsset(client, assetId);
          const v = await readCurrentVersion(client, { ...a, current_version_id: String(detail.versionId) });
          if (
            !asset ||
            asset.ownerUserId !== a.owner_user_id ||
            asset.accountId !== a.id ||
            asset.gameId !== a.game_id ||
            asset.purpose !== "ACCOUNT_DISPLAY" ||
            !isAccountDisplayPubliclyEligible(asset) ||
            !(await client.query(
              `SELECT 1 FROM zzsh_supply.listing_media WHERE version_id=$1 AND asset_id=$2`,
              [v.id, asset.id],
            )).rowCount
          )
            throw notFound();
          return { asset };
}

/** 公开列表 v1 的候选扫描与分页投影；游标绑定与 404 吞掉规则保持原样。 */
export async function readPublicListingPage(
  client: PoolClient,
  args: { query: URLSearchParams; filter: PublicListingPageFilter; cursor: string; cursorMarket: string | null; limit: number; gate: SupplyGateReader; fixedFeeDemo?: DemoFinanceResource; accountImageCdn?: AccountImageCdn },
) {
  const { query, filter, cursor, cursorMarket, limit, gate, fixedFeeDemo, accountImageCdn } = args;
        if (filter.gameId) {
          await requirePublicGameService(client, filter.gameId, GAME_SERVICE.ACCOUNT_RENTAL);
        }
        if (query.has("cursor") && cursorMarket !== "publication-snapshot" && cursorMarket !== null) throw conflict("Listing prices changed; refresh from the first page");
        const values:unknown[]=[cursor,filter.gameId];
        const param=(value:unknown)=>{values.push(value);return '$'+values.length;};
        const predicates=candidatePredicates({resources:filter.itemId?[{itemId:filter.itemId,minQuantity:filter.minQuantity??"0"}]:[],skinGroups:[{ids:filter.skins,match:filter.skinMatch}]},filter.q,param);
        const rows = (
          await client.query<{
            id: string;
            version_id: string;
          }>(
            `SELECT a.id,v.id AS version_id ${PUBLIC_CANDIDATE_FROM} WHERE a.id>$1 AND ${PUBLIC_CANDIDATE_WHERE} AND ($2::text IS NULL OR a.game_id=$2)${predicates.length?' AND '+predicates.join(' AND '):''} ORDER BY a.id LIMIT 200`,
            values,
          )
        ).rows;
        const items: PublicListingProjection[] = [];
        let last = cursor;
        let hasMore = false;
        const page = listingCandidatePage(client, fixedFeeDemo && { resource: fixedFeeDemo, accountIds: rows.map(row => row.id) });
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          // The page is full and candidates remain unscanned: the caller still
          // has rows to fetch, so the cursor advances to the last scanned one.
          if (items.length === limit) {
            hasMore = true;
            break;
          }
          if (!page.has(row.id))
            await page.load(rows.slice(i, i + limit).map((candidate) => candidate.id));
          last = row.id;
          const account = page.account(row.id);
          if (!account) continue;
          try {
            items.push(
              await listingDetail(
                client,
                account,
                "public",
                gate,
                undefined,
                undefined,
                false,
                "RENTABLE",
                { version: page.version(row.id), shared: page.shared, fixedFeeDemoAccount: await page.fixedFeeDemoAccount(row.id) },
              ),
            );
          } catch (error) {
            if (
              (
                error as {
                  status?: number;
                }
              ).status !== 404
            )
              throw error;
          }
        }
        if (rows.length === 200) hasMore = true;
        return {
          items: await projectPublicListingImages(client, items, accountImageCdn),
          nextCursor: hasMore
            ? Buffer.from(
                JSON.stringify({
                  v: 2,
                  id: last,
                  filter: sha256Hex(JSON.stringify(filter)),
                  marketRevision: "publication-snapshot",
                }),
              ).toString("base64url")
            : null,
        };
}
