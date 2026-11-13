import { effectiveRuleRelease } from "./effective-rule-release";
import { projectTenantMoney, projectTenantPriceQuote, publishedBaseRenterHaffRatioWanPerYuan, publishedListingFeeDisplay } from "./tenant-price-projection";
import { projectPublicListingImages, type PublicListingProjection } from "./legacy-path-projection";
import { readLegacyPublishedReference } from "./legacy-published-reference";
import { assertFullPayoutTermsAccepted, readFullPayoutTerms } from "./full-payout-terms";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import type { Pool, PoolClient } from "pg";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { assertActiveInTransaction, identityAllowsProtectedTrade } from "../auth/user-identity";
import { enqueueDelistedGuaranteeRefund } from "../credit/credit-guarantee";
import { hasUnpaidPaymentEvidence, requireFreshPaymentSnapshot, UNPAID_PAYMENT_FACT_COLUMNS, type UnpaidPaymentFacts } from "../order/unpaid-payment-facts";
import { readAccountOccupancyFacts } from "../order/legacy-order-occupancy";
import {
  canonicalize,
  computeContentHash,
  normalizeContentPayload,
  normalizeDeclaration,
  normalizeQuote,
  normalizeTime,
  humanText,
  type ContentDeclaration,
  type ContentPayloadInput,
} from "./content-hash";
import {
  computeDeltaQuote,
  computeFixedUnitAmounts,
  ROUNDING_POLICY,
  projectDeltaQuote,
  type InternalQuote,
  type QuoteInput,
  type QuoteViewer,
} from "./pricing";
import { decimalToBigInt, formatDecimalExact, parseNonNegativeDecimal, yuanAmountObject } from "./decimal";
import {
  projectOwnerMediaBinding,
  projectPublicAttributeDisplay,
  projectPublicListingGame,
  projectPublicOffer,
  isEffectivePublicationState,
  mediaReviewAllowsPublication,
  isAccountMediaBinding,
  type BoundTermOption,
  type PublicMediaRoute,
} from "./listing-query";
import {
  conflict,
  ensureOnlyFields,
  invalid,
  newSupplyId,
  notFound,
  sha256Hex,
} from "./supply-util";
import { GAME_SERVICE, readGameService, requireWritableGameService, type GameServiceState } from "./game-services";
import { assertDeltaResourceUnit, isDeltaGradingDivision, isRetiredDeltaInsurance, normalizeRentalPricing, validateDeltaPublicationAttributes, validateDeltaRentalTerm, type RentalMode } from "./delta-rental";
import { readFundingPolicyForRelease } from "./funding-authority";
import { computeDepositRecommendation, validateOwnerDepositAmount, validateOwnerDepositDeclaration } from "./funding-policy";
import type { DepositSkinFacts } from "./deposit-recommendation";
import { assignAccountNumber, publicAccountNumber } from "./account-number";
import { FIXED_FEE_ALGORITHM } from "./fixed-fee";
import { assertFixedFeeTestListingAdmission, type FixedFeeTestListingAdmission } from "../finance/controlled-fixed-fee-resource";
import { validateFixedFeeTimeline } from "../auth/fixed-fee-policy-timeline";
import { boundListingPricingPolicy, readEffectiveFixedFeePrice, readNewListingPrice, readEffectiveSpreadPrice, readListingPricingModel, readFixedFeeTimeline, SCHEDULED_SPREAD_ORDER_ENABLED } from "./pricing-policy-schedule";
import { readLegacyListing, readLegacySkinHolding } from "./legacy-listing-read";
import { publicSkinMediaIdSql, publicSkinMetadataSql, publicSkinOwnerNameSql, publicSkinRarityNameSql } from "./catalog";
export type SupplyGate = {
  publisherBail: "SATISFIED" | "NOT_REQUIRED" | "PENDING" | "UNKNOWN";
  occupancy: "FREE" | "OCCUPIED" | "UNKNOWN";
  occupancyKind?: "PENDING_PAYMENT" | "RENTED" | "OCCUPIED";
  rentalCompleted?: boolean;
  reference: string | null;
  creditGuarantee?: CreditGuaranteeGateSnapshot;
};
export type CreditGuaranteeGateSnapshot = {
  status: "NOT_REQUIRED" | "REQUIRED_UNCOVERED" | "SATISFIED" | "UNKNOWN";
  accountId: string;
  ownerUserId: string;
  gameId: string;
  listingVersionId: string | null;
  priceVersionId: string | null;
  releaseId: string | null;
  creditRevision: string | null;
  coverageRevision: string | null;
  requiredCents: string | null;
  reference: string | null;
};
export type SupplyGateReader = (
  client: PoolClient,
  account: PublishingAccount,
  purpose?: "READ" | "WRITE",
) => Promise<SupplyGate>;
export const unknownSupplyGate: SupplyGateReader = async () => ({
  publisherBail: "UNKNOWN",
  occupancy: "UNKNOWN",
  reference: null,
});
export type PublishingAccount = {
  id: string;
  owner_user_id: string;
  game_id: string;
  current_version_id: string | null;
  owner_paused: boolean;
  staff_restricted: boolean;
  restriction_reason: string | null;
  legacy_hold: string;
  lifecycle: string;
  revision: string;
  display_no: string | null;
};
export type ListingVersion = {
  schema_version: number;
  id: string;
  account_id: string;
  sequence: string;
  origin: string;
  review_state: string;
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  term_option_code: string;
  pricing_option_code: string;
  rule_release_id: string | null;
  content_hash: string | null;
  payload: ContentPayloadInput | null;
  presentation: Record<string, unknown>;
  revision: string;
  submitted_at: Date | null;
};

/** A ratio is useful only when its account, game, release and frozen payload agree. */
export function boundBaseRenterRatio(account: PublishingAccount, version: ListingVersion): string | null {
  const payload = version.payload;
  if (!payload || !version.content_hash || version.account_id !== account.id || payload.accountId !== account.id || payload.gameId !== account.game_id || payload.ruleRefs?.releaseId !== version.rule_release_id) return null;
  try { return computeContentHash(payload) === version.content_hash ? publishedBaseRenterHaffRatioWanPerYuan(payload.quoteValues) : null; }
  catch { return null; }
}
export type ListingPublication = {
  id: string;
  version_id: string;
  account_id: string;
  owner_user_id: string;
  game_id: string;
  rule_release_id: string;
  content_hash: string;
  source: "OWNER_DIRECT" | "LEGACY_APPROVED";
  published_by_realm: "user" | "admin";
  published_by_user_id: string | null;
  published_by_admin_id: string | null;
  published_at: Date;
  publishedAtExact?: string;
};
export async function lockPublishingAccount(
  client: PoolClient,
  id: string,
): Promise<PublishingAccount> {
  const found = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!found) throw notFound();
  // Same user lock as M2 verification/freeze/cancellation. Rule activation locks game.
  await client.query(
    `SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,
    [found.owner_user_id],
  );
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`, [
    found.game_id,
  ]);
  return (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0]!;
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

export async function readPublishingAccount(
  client: PoolClient,
  id: string,
): Promise<PublishingAccount> {
  const account = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!account) throw notFound();
  return account;
}

/** Set-based account read for one already authorized page of candidates.
 *  A missing account stays missing; the caller's 404 path is unchanged. */
export async function readPublishingAccounts(
  client: PoolClient,
  ids: readonly string[],
): Promise<Map<string, PublishingAccount>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id = ANY($1::text[])`,
      [unique],
    )
  ).rows;
  return new Map(rows.map((row) => [row.id, row]));
}

/** Batched form of readCurrentVersion, keyed by account so the account binding
 *  is still checked per row: a version owned by another account stays absent. */
export async function readCurrentVersions(
  client: PoolClient,
  accounts: readonly PublishingAccount[],
): Promise<Map<string, ListingVersion>> {
  const wanted = [
    ...new Set(
      accounts
        .map((account) => account.current_version_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (!wanted.length) return new Map();
  const rows = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id = ANY($1::text[])`,
      [wanted],
    )
  ).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byAccount = new Map<string, ListingVersion>();
  for (const account of accounts) {
    const version = account.current_version_id
      ? byId.get(account.current_version_id)
      : undefined;
    if (version && version.account_id === account.id)
      byAccount.set(account.id, version);
  }
  return byAccount;
}

export type ListingGameRow = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  current_release_id: string | null;
  catalog_revision: string;
};

/** Every candidate of one market page shares its game, that game's rental
 *  service and the release policy the publication is bound to. Memoizing those
 *  reads per request removes the repeated lookups without moving any rule. */
export type ListingPageShared = {
  game(gameId: string): Promise<ListingGameRow | undefined>;
  rentalService(gameId: string): Promise<GameServiceState>;
  retiredLegacy(account: PublishingAccount): Promise<boolean>;
  primeRetiredLegacy(accountIds: readonly string[]): Promise<void>;
  fundingPolicy(
    releaseId: string,
  ): Promise<Awaited<ReturnType<typeof readFundingPolicyForRelease>>>;
};

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

/** One version's media rows are read by both the readiness check and the public
 *  projection; a lazy memo keeps that to a single read without changing either. */
export type ListingMediaAssetRow = {
  id: string;
  account_id: string | null;
  game_id: string | null;
  owner_user_id: string | null;
  ownership_kind: string | null;
  purpose: string | null;
  content_hash: string | null;
  review_state: string | null;
  access_class: string | null;
  technical_state: string | null;
  public_storage_key: string | null;
  source_note: string | null;
};

export type ListingDetailPrefetch = {
  /** Restricted account readers never fetch administrator review records. */
  includeReviewRecords?: boolean;
  /** Current version already loaded for the account; absent means "not loaded". */
  version?: ListingVersion | null;
  /** Answer to the publication probe, already resolved for this page. */
  hasPublication?: boolean;
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
export function listingCandidatePage(client: PoolClient) {
  const shared = listingPageShared(client);
  const accounts = new Map<string, PublishingAccount | undefined>();
  const versions = new Map<string, ListingVersion | null>();
  const published = new Set<string>();
  return {
    shared,
    has: (id: string) => accounts.has(id),
    account: (id: string) => accounts.get(id),
    version: (id: string) => versions.get(id) ?? null,
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

export async function readCurrentVersion(
  client: PoolClient,
  account: PublishingAccount,
): Promise<ListingVersion> {
  const version = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,
      [account.current_version_id, account.id],
    )
  ).rows[0];
  if (!version) throw notFound();
  return version;
}
export function checkAccountRevision(
  account: PublishingAccount,
  revision: unknown,
): void {
  if (typeof revision !== "string" || revision !== account.revision)
    throw conflict("供给资料已变化，请刷新后重试");
}
export async function currentVersion(
  client: PoolClient,
  account: PublishingAccount,
): Promise<ListingVersion> {
  const v = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [account.current_version_id, account.id],
    )
  ).rows[0];
  if (!v) throw conflict("请先保存一份草稿");
  return v;
}
export async function readListingPublication(
  client: PoolClient,
  account: PublishingAccount,
  version: ListingVersion,
): Promise<ListingPublication | null> {
  if (!version.rule_release_id || !version.content_hash) return null;
  return (
    await client.query<ListingPublication>(
      `SELECT *, to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtExact" FROM zzsh_supply.listing_publication
        WHERE version_id=$1 AND account_id=$2 AND owner_user_id=$3
          AND game_id=$4 AND rule_release_id=$5 AND content_hash=$6`,
      [version.id, account.id, account.owner_user_id, account.game_id, version.rule_release_id, version.content_hash],
    )
  ).rows[0] ?? null;
}
async function bumpAccount(
  client: PoolClient,
  account: PublishingAccount,
): Promise<void> {
  const row = (
    await client.query<{
      revision: string;
    }>(
      `UPDATE zzsh_supply.rental_account SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING revision::text`,
      [account.id],
    )
  ).rows[0]!;
  account.revision = row.revision;
}
async function currentTradeResourcesMatch(client: PoolClient, a: PublishingAccount, v: ListingVersion, lockResources: boolean): Promise<boolean> {
  if (!v.payload) return false;
  const lines = normalizeQuote(v.payload.quoteValues).lines;
  const ids = [...new Set(lines.map(line => line.itemId))];
  const items = ids.length ? (await client.query<{ id: string; code: string; unit: string; enabled: boolean }>(
    `SELECT id,code,unit,enabled /* current-trade-resources */ FROM zzsh_supply.billable_item WHERE game_id=$1 AND id=ANY($2::text[]) ORDER BY id${lockResources ? " FOR SHARE" : ""}`,
    [a.game_id, ids],
  )).rows : [];
  const byId = new Map(items.map(item => [item.id, item]));
  let current = lines.length > 0 && byId.size === ids.length;
  for (const line of lines) {
    const item = byId.get(line.itemId);
    if (!item?.enabled || item.unit !== line.unit) { current = false; continue; }
    try { assertDeltaResourceUnit(item.code, item.unit); }
    catch (error) { if (!(error instanceof SecurityApiError)) throw error; current = false; }
  }
  return current;
}

function listingTitleNeedsReview(v: ListingVersion): boolean {
  return typeof v.title === "string" && (v.title.includes("历史资料待核实") || (!v.title.trim() && v.origin !== "NATIVE"));
}

export async function isRetiredMigratedAccount(client: PoolClient, a: PublishingAccount): Promise<boolean> {
  const row = (await client.query<{retired:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM zzsh_supply.game g JOIN zzsh_supply.legacy_supply_map m ON m.account_id=$1
    WHERE g.id=$2 AND g.code='delta' AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts') AS retired`, [a.id,a.game_id])).rows[0];
  if (!row || typeof row.retired !== "boolean") throw conflict("账号来源暂不能确认，请联系客服");
  return row.retired;
}

async function assertUnpublishedAccount(client: PoolClient, a: PublishingAccount): Promise<void> {
  if (await isRetiredMigratedAccount(client, a)) throw conflict("历史账号不能重新上架，请重新填写资料");
  if ((await client.query(`SELECT 1 FROM zzsh_supply.listing_publication WHERE account_id=$1 LIMIT 1`, [a.id])).rowCount)
    throw conflict("已上架账号不能修改，请下架后重新填写上架资料");
}

export async function publicationBlockers(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
  gate: SupplyGateReader,
  purpose: "READ" | "WRITE" = "WRITE",
  strictReadErrors = false,
  shared?: ListingPageShared,
  hasBoundPublication = false,
): Promise<string[]> {
  const reasons: string[] = [];
  const user = (
    await client.query(
      `SELECT u.suspended, COALESCE(s.account_status,'ACTIVE') AS account_status,s.identity_status,s.age_status,s.provider FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=$1`,
      [a.owner_user_id],
    )
  ).rows[0];
  if (!user || user.suspended || user.account_status !== "ACTIVE")
    reasons.push("OWNER_UNAVAILABLE");
  if (user?.identity_status !== "VERIFIED") reasons.push("IDENTITY_REQUIRED");
  if (user?.age_status !== "ADULT" && !identityAllowsProtectedTrade({ identityStatus: user?.identity_status, ageStatus: user?.age_status, provider: user?.provider })) reasons.push("ADULT_REQUIRED");
  const game = shared
    ? await shared.game(a.game_id)
    : (
        await client.query<ListingGameRow>(
          `SELECT id,code,name,enabled,${effectiveRuleRelease("g")} AS current_release_id,catalog_revision::text FROM zzsh_supply.game g WHERE id=$1`,
          [a.game_id],
        )
      ).rows[0];
  // Admin and market reads share this gate; page reads batch source checks, writes recheck directly.
  if (game?.code === "delta" && await (shared && purpose !== "WRITE" ? shared.retiredLegacy(a) : isRetiredMigratedAccount(client, a)))
    reasons.push("LEGACY_LISTING_RELIST_REQUIRED");
  if (!game?.enabled) reasons.push("GAME_UNAVAILABLE");
  if (v.review_state === "DRAFT" && v.payload && v.origin === "NATIVE" && v.payload.ruleRefs.catalogRevision !== game?.catalog_revision) reasons.push("RULE_CHANGED");
  const rentalService = shared
    ? await shared.rentalService(a.game_id)
    : await readGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  if (!rentalService.supported || !rentalService.gameEnabled || !rentalService.enabled) reasons.push("GAME_SERVICE_UNAVAILABLE");
  // A native draft that has never been bound to a release is not a rule change.
  const unboundNativeDraft = v.origin === "NATIVE" && v.review_state === "DRAFT" && !v.rule_release_id;
  if (!unboundNativeDraft && (!v.rule_release_id || (!hasBoundPublication && game?.current_release_id !== v.rule_release_id)))
    reasons.push("RULE_CHANGED");
  if (purpose === "WRITE" && v.payload && v.origin === "NATIVE" && !(await currentTradeResourcesMatch(client, a, v, true))) reasons.push("RULE_CHANGED");
  if (v.rule_release_id && (hasBoundPublication || game?.current_release_id === v.rule_release_id)) {
    try {
      const policy = shared
        ? await shared.fundingPolicy(v.rule_release_id)
        : await readFundingPolicyForRelease(client, v.rule_release_id);
      if (policy) {
        const declaration = validateOwnerDepositDeclaration(v.attributes.owner_deposit_declaration);
        const fullPayout = v.attributes.full_payout_declaration;
        if (!declaration || !fullPayout || typeof fullPayout !== "object" || Array.isArray(fullPayout)
          || Object.keys(fullPayout).sort().join(",") !== "schema,selected"
          || (fullPayout as Record<string, unknown>).schema !== "full-payout-declaration-v1"
          || typeof (fullPayout as Record<string, unknown>).selected !== "boolean") {
          reasons.push("FUNDING_UNKNOWN");
        } else {
          validateOwnerDepositAmount(policy, declaration.amountCents, (fullPayout as Record<string, unknown>).selected as boolean);
        }
      }
    } catch (error) {
      if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
      reasons.push("FUNDING_UNKNOWN");
    }
  }
  if (a.lifecycle === "DELISTED") reasons.push("ACCOUNT_DELISTED");
  else if (
    a.lifecycle !== "ACTIVE" ||
    a.legacy_hold !== "NONE" ||
    v.origin !== "NATIVE"
  )
    reasons.push("ACCOUNT_NOT_PUBLISHABLE");
  let external: SupplyGate;
  try {
    external = await gate(client, a, purpose);
  } catch (error) {
    if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
    external = await unknownSupplyGate(client, a);
  }
  if (external.rentalCompleted === true) reasons.push("RENTAL_COMPLETED");
  if (
    !external.reference ||
    !["SATISFIED", "NOT_REQUIRED"].includes(external.publisherBail)
  )
    reasons.push("PUBLISHER_BAIL_UNCONFIRMED");
  if (external.occupancy !== "FREE")
    reasons.push(
      external.occupancy === "OCCUPIED" ? "OCCUPIED" : "OCCUPANCY_UNKNOWN",
    );
  // Native titles may be empty. The migration placeholder still cannot publish on any origin.
  if (purpose === "WRITE" && listingTitleNeedsReview(v)) {
    reasons.push("TITLE_REVIEW_REQUIRED");
  }
  return reasons;
}
export async function assertEditable(
  client: PoolClient,
  a: PublishingAccount,
  gate: SupplyGateReader,
  allowLegacyResolution = false,
): Promise<void> {
  await assertActiveInTransaction(client, a.owner_user_id);
  await requireWritableGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  if (a.lifecycle !== "ACTIVE" || (!allowLegacyResolution && a.legacy_hold !== "NONE"))
    throw conflict("历史异常或归档账号不能发布");
  const external = await gate(client, a);
  if (external.rentalCompleted === true) throw conflict("RENTAL_COMPLETED");
  if (external.occupancy !== "FREE")
    throw conflict("暂不能确认账号空闲，请先处理占用状态");
  await assertUnpublishedAccount(client, a);
}
export async function readAccountMediaBindings(client: PoolClient, versionId: string): Promise<ContentDeclaration["mediaBindings"]> {
  const rows = (await client.query(
    `SELECT m.asset_id AS "assetId",a.content_hash AS "byteHash",a.purpose,m.position,
      a.ownership_kind,a.account_id,a.owner_user_id,a.game_id,
      owner.id AS binding_account_id,owner.owner_user_id AS binding_owner_user_id,owner.game_id AS binding_game_id
     FROM zzsh_supply.listing_media m LEFT JOIN zzsh_supply.media_asset a ON a.id=m.asset_id
     JOIN zzsh_supply.listing_version version ON version.id=m.version_id
     JOIN zzsh_supply.rental_account owner ON owner.id=version.account_id
     WHERE m.version_id=$1 ORDER BY m.position`, [versionId],
  )).rows;
  if (rows.some(row => !isAccountMediaBinding(row, { id: row.binding_account_id, owner_user_id: row.binding_owner_user_id, game_id: row.binding_game_id }))) throw notFound();
  return rows.map(({ assetId, byteHash, purpose, position }) => ({ assetId, byteHash, purpose, position }));
}

export async function readDeclaration(
  client: PoolClient,
  v: ListingVersion,
): Promise<
  ContentDeclaration & {
    inventory: Array<{
      itemId: string;
      quantity: string | null;
    }>;
  }
> {
  const inventory = (
    await client.query(
      `SELECT item_id AS "itemId",quantity::text FROM zzsh_supply.inventory_line WHERE version_id=$1 ORDER BY item_id`,
      [v.id],
    )
  ).rows;
  const skins = (
    await client.query(
      `SELECT skin_id FROM zzsh_supply.listing_skin WHERE version_id=$1 ORDER BY skin_id`,
      [v.id],
    )
  ).rows.map((r) => r.skin_id);
  const entitlements = (
    await client.query(
      `SELECT entitlement_id AS "entitlementId",value, CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt",expiry_knowledge AS "expiryKnowledge" FROM zzsh_supply.listing_entitlement WHERE version_id=$1 ORDER BY entitlement_id`,
      [v.id],
    )
  ).rows;
  const mediaBindings = await readAccountMediaBindings(client, v.id);
  return {
    title: v.title,
    description: v.description,
    attributes: v.attributes,
    inventory,
    skins,
    entitlements,
    termOptionCode: v.term_option_code,
    pricingOptionCode: v.pricing_option_code,
    mediaBindings,
  };
}
export async function createListingDraft(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, expected);
  await assertEditable(client, a, gate);
  const old = a.current_version_id ? await currentVersion(client, a) : null;
  if (old && old.origin !== "NATIVE") throw conflict("历史账号不能重新上架，请重新填写资料");
  if (old?.review_state === "SUBMITTED")
    throw conflict("请先撤回正在审核的资料");
  if (old?.review_state === "DRAFT") throw conflict("已有可编辑草稿");
  if (old) await readAccountMediaBindings(client, old.id);
  const id = newSupplyId("listing");
  await client.query(
    `INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,title,description,attributes,term_option_code,pricing_option_code,schema_version) SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4,$5,$6,$7,$8 FROM zzsh_supply.listing_version WHERE account_id=$2`,
    [
      id,
      a.id,
      old?.title ?? "",
      old?.description ?? null,
      old?.attributes ?? {},
      old?.term_option_code ?? "",
      old?.pricing_option_code ?? "",
      old?.schema_version === 3 ? 2 : old?.schema_version ?? 1,
    ],
  );
  if (old) {
    for (const [table, fields] of [
      ["inventory_line", "item_id,quantity"],
      ["listing_skin", "skin_id"],
      [
        "listing_entitlement",
        "entitlement_id,value,expires_at,expiry_knowledge",
      ],
      ["listing_media", "asset_id,position"],
    ])
      await client.query(
        `INSERT INTO zzsh_supply.${table}(version_id,${fields}) SELECT $1,${fields} FROM zzsh_supply.${table} WHERE version_id=$2`,
        [id, old.id],
      );
  }
  await client.query(
    `UPDATE zzsh_supply.rental_account SET current_version_id=$1 WHERE id=$2`,
    [id, a.id],
  );
  a.current_version_id = id;
  await bumpAccount(client, a);
}
const list = (
  v: unknown,
  label: string,
  path: string,
): Record<string, unknown>[] => {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    v.some((x) => !x || typeof x !== "object" || Array.isArray(x))
  )
    throw invalid(label, path);
  return v;
};
const idText = (v: unknown, path: string): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))
    throw invalid("Invalid identifier", path);
  return v;
};
export async function saveListingDraft(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
  verifiedLegacyReference?: string,
): Promise<void> {
  ensureOnlyFields(body, [
    "expectedRevision",
    "title",
    "description",
    "attributes",
    "termOptionCode",
    "pricingOptionCode",
    "inventory",
    "skins",
    "entitlements",
    "mediaBindings",
  ]);
  checkAccountRevision(a, body.expectedRevision);
  await assertEditable(client, a, gate);
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("这份资料不可修改，请创建新草稿");
  if (body.title !== undefined && typeof body.title !== "string")
    throw invalid("标题格式错误", "title");
  for (const field of ["termOptionCode", "pricingOptionCode"])
    if (
      body[field] !== undefined &&
      (typeof body[field] !== "string" ||
        !/^$|^[a-z][a-z0-9_:-]{1,63}$/.test(body[field] as string))
    )
      throw invalid("选项代码格式错误", field);
  const title = humanText(typeof body.title === "string" ? body.title : "");
  if (title.length > 120) throw invalid("标题过长", "title");
  if (body.description != null && typeof body.description !== "string")
    throw invalid("说明格式错误", "description");
  const description =
    body.description == null ? null : humanText(body.description as string);
  if (description && description.length > 4000)
    throw invalid("说明过长", "description");
  if (isDeltaGradingDivision(v.attributes.grading_code, v.attributes.grading_division)
    && (!body.attributes || typeof body.attributes !== "object" || !Object.hasOwn(body.attributes, "grading_division")))
    throw conflict("客户端未保留已申报的小段位，请更新客户端后重试");
  for (const field of ["next_season_pass", "demulan_unlocked"] as const) {
    if (typeof v.attributes[field] === "boolean" && (!body.attributes || typeof body.attributes !== "object" || !Object.hasOwn(body.attributes, field)))
      throw conflict("客户端未保留已申报的通行证计划或德穆兰状态，请更新客户端后重试");
  }
  let normalized: ContentDeclaration;
  const attributes = (body.attributes ?? {}) as Record<string, unknown>;
  const legacyReference = verifiedLegacyReference ?? v.attributes.legacy_published_reference;
  if (Object.hasOwn(attributes, "legacy_published_reference") && attributes.legacy_published_reference !== legacyReference)
    throw invalid("旧刊登图片来源不可修改", "attributes.legacy_published_reference");
  try {
    normalized = normalizeDeclaration({
      title,
      description,
      attributes: legacyReference === undefined ? attributes : { ...attributes, legacy_published_reference: legacyReference },
      inventory: [],
      skins: [],
      entitlements: [],
      mediaBindings: [],
      termOptionCode: String(body.termOptionCode ?? ""),
      pricingOptionCode: String(body.pricingOptionCode ?? ""),
    }, (body.attributes as Record<string, unknown> | undefined)?.rentalPricing === undefined ? 1 : 2);
  } catch {
    throw invalid("属性格式或范围错误", "attributes");
  }
  const inventory = list(body.inventory ?? [], "库存格式错误", "inventory");
  const characterLevel=normalized.attributes.character_level;
  if(typeof characterLevel==="number"&&characterLevel>60){
    const previous=(await readDeclaration(client,v)).attributes.character_level;
    if(previous!==characterLevel)throw invalid("账号等级须为0–60的整数","attributes.character_level");
  }
  const seen = new Set<string>();
  for (const item of inventory) {
    ensureOnlyFields(item, ["itemId", "quantity"]);
    idText(item.itemId, "inventory");
    if (seen.has(item.itemId as string)) throw invalid("库存重复", "inventory");
    seen.add(item.itemId as string);
    if (
      item.quantity !== null &&
      (typeof item.quantity !== "string" ||
        !/^(0|[1-9]\d{0,23})$/.test(item.quantity))
    )
      throw invalid("数量须为整数文本或未知null", "inventory");
  }
  if (
    !Array.isArray(body.skins ?? []) ||
    ((body.skins as unknown[]) ?? []).some((id) => typeof id !== "string")
  )
    throw invalid("皮肤格式错误", "skins");
  const skins = (body.skins ?? []) as string[];
  if (new Set(skins).size !== skins.length) throw invalid("皮肤重复", "skins");
  const entitlements = list(
      body.entitlements ?? [],
      "权益格式错误",
      "entitlements",
    ),
    media = list(body.mediaBindings ?? [], "图片格式错误", "mediaBindings");
  const mediaCategories: Record<string, "SHOWCASE" | "PENALTY"> = {};
  for (const binding of media) {
    ensureOnlyFields(binding, ["assetId", "position", "category"]);
    idText(binding.assetId, "mediaBindings");
    if (!Number.isInteger(binding.position) || Number(binding.position) < 0 || Number(binding.position) > 99) throw invalid("图片顺序错误", "mediaBindings");
    if (binding.category !== undefined && binding.category !== "SHOWCASE" && binding.category !== "PENALTY") throw invalid("图片分类错误", "mediaBindings");
    if (binding.category !== undefined) mediaCategories[binding.assetId as string] = binding.category;
  }
  if (media.length) {
    const assets = (await client.query<ListingMediaAssetRow>(
      `SELECT * FROM zzsh_supply.media_asset WHERE id=ANY($1::text[]) AND account_id=$2 AND owner_user_id=$3 AND game_id=$4 ORDER BY id FOR UPDATE`,
      [media.map(binding => binding.assetId), a.id, a.owner_user_id, a.game_id],
    )).rows;
    if (assets.length !== media.length || assets.some(asset => !isAccountMediaBinding(asset, a))) throw invalid("图片绑定无效", "mediaBindings");
  }
  if (inventory.length) {
    const items = (await client.query<{ id: string; code: string; unit: string; quantityScale: number }>(
      `SELECT id,code,unit,quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item WHERE game_id=$1 AND id=ANY($2::text[])`,
      [a.game_id, inventory.map(item => item.itemId)],
    )).rows;
    if (items.length !== inventory.length) throw invalid("库存物品不属于当前游戏", "inventory");
    for (const item of items) assertDeltaResourceUnit(item.code, item.unit, item.quantityScale);
  }
  for (const t of [
    "inventory_line",
    "listing_skin",
    "listing_entitlement",
    "listing_media",
  ])
    await client.query(`DELETE FROM zzsh_supply.${t} WHERE version_id=$1`, [
      v.id,
    ]);
  for (const item of inventory)
    await client.query(
      `INSERT INTO zzsh_supply.inventory_line(version_id,item_id,quantity) VALUES($1,$2,$3)`,
      [v.id, item.itemId, item.quantity],
    );
  for (const id of skins)
    await client.query(
      `INSERT INTO zzsh_supply.listing_skin(version_id,skin_id) VALUES($1,$2)`,
      [v.id, idText(id, "skins")],
    );
  for (const ent of entitlements) {
    ensureOnlyFields(ent, [
      "entitlementId",
      "value",
      "expiresAt",
      "expiryKnowledge",
    ]);
    const expiry = normalizeTime(
      ent.expiresAt == null ? null : (ent.expiresAt as string),
    );
    if (!["KNOWN", "UNKNOWN"].includes(String(ent.expiryKnowledge)))
      throw invalid("权益有效期状态错误", "entitlements");
    await client.query(
      `INSERT INTO zzsh_supply.listing_entitlement(version_id,entitlement_id,value,expires_at,expiry_knowledge) VALUES($1,$2,$3,$4,$5)`,
      [
        v.id,
        idText(ent.entitlementId, "entitlements"),
        JSON.stringify(ent.value ?? null),
        expiry,
        ent.expiryKnowledge,
      ],
    );
  }
  delete normalized.attributes.media_categories;
  for (const binding of media) {
    await client.query(
      `INSERT INTO zzsh_supply.listing_media(version_id,asset_id,position) VALUES($1,$2,$3)`,
      [v.id, idText(binding.assetId, "mediaBindings"), binding.position],
    );
  }
  // Version-owned classification participates in the existing declaration hash.
  // Never overwrite the asset's provenance or reclassify another published version.
  if (Object.keys(mediaCategories).length) normalized.attributes.media_categories = mediaCategories;
  await client.query(
    `UPDATE zzsh_supply.listing_version SET title=$2,description=$3,attributes=$4,term_option_code=$5,pricing_option_code=$6,schema_version=$7,payload=NULL,content_hash=NULL,rule_release_id=NULL,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      title,
      description,
      normalized.attributes,
      normalized.termOptionCode,
      normalized.pricingOptionCode,
      normalized.attributes.rentalPricing === undefined ? 1 : 2,
    ],
  );
  await bumpAccount(client, a);
}
export async function readDepositRecommendation(
  client: PoolClient,
  a: PublishingAccount,
): Promise<Record<string, unknown>> {
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可为新申报草稿查看推荐押金");
  const release = (
    await client.query<{ id: string; priceVersionId: string }>(
      `SELECT r.id,r.price_version_id AS "priceVersionId" FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} WHERE g.id=$1 AND g.enabled`,
      [a.game_id],
    )
  ).rows[0];
  if (!release) throw conflict("暂无可用规则");
  const policy = await readFundingPolicyForRelease(client, release.id);
  if (!policy)
    return {
      available: false,
      reason: "FUNDING_POLICY_UNCONFIGURED",
      releaseId: release.id,
    };
  const d = await readDeclaration(client, v);
  const factRow = policy.recommendation.schema === "deposit-recommendation-v2" ? (await client.query<{ catalogRevision: string; skins: DepositSkinFacts["skins"] }>(`
    SELECT g.catalog_revision::text AS "catalogRevision",
      COALESCE(jsonb_agg(jsonb_build_object('skinId',s.id,'ownerKind',s.owner_kind,'rarityCode',s.rarity_code) ORDER BY s.id) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS skins
    FROM zzsh_supply.game g LEFT JOIN zzsh_supply.skin s ON s.game_id=g.id AND s.id=ANY($2::text[]) AND s.naming_state='VERIFIED'
    WHERE g.id=$1 GROUP BY g.id,g.catalog_revision`, [a.game_id, d.skins])).rows[0] : undefined;
  const skinFacts: DepositSkinFacts | undefined = factRow ? { schema: "deposit-skin-facts-v1", gameId: a.game_id, listingVersionId: v.id, catalogRevision: factRow.catalogRevision, skins: factRow.skins } : undefined;
  const attrs = d.attributes as Record<string, unknown>;
  const vitality = attrs.vit_level ?? attrs.vitLevel;
  const bear = attrs.bear_level ?? attrs.bearLevel;
  const inputs = {
    safeBoxCode:
      typeof attrs.safe_box_code === "string" ? attrs.safe_box_code : null,
    vitality: typeof vitality === "number" ? vitality : null,
    bear: typeof bear === "number" ? bear : null,
    dive: typeof attrs.dive_level === "number" ? attrs.dive_level : null,
    skinIds: [...d.skins],
    ...(skinFacts ? { skinFacts } : {}),
  };
  const binding = {
    accountId: a.id,
    accountRevision: a.revision,
    versionId: v.id,
    versionRevision: v.revision,
    ruleReleaseId: release.id,
    priceVersionId: release.priceVersionId,
    inputs,
  };
  try {
    const amountCents = computeDepositRecommendation(policy, {
      accountId: a.id,
      gameId: a.game_id,
      listingVersionId: v.id,
      priceVersionId: release.priceVersionId,
      ruleReleaseId: release.id,
      safeBoxCode: inputs.safeBoxCode,
      vitality: inputs.vitality,
      bear: inputs.bear,
      dive: inputs.dive,
      skinIds: inputs.skinIds,
      skinFacts,
    });
    return {
      available: true,
      amountCents,
      minCents: policy.ownerDepositRules.normal.minCents,
      fullPayoutMinCents: policy.ownerDepositRules.fullPayoutSelected.minCents,
      capCents: policy.ownerDepositRules.capCents,
      policyVersion: policy.policyVersion,
      recommendationSchema: policy.recommendation.schema,
      ...binding,
    };
  } catch {
    return {
      available: false,
      reason: "INPUTS_UNAVAILABLE",
      releaseId: release.id,
    };
  }
}
export function parseIncomePreviewInventory(inventory: unknown): Map<string, string | null> {
  if (!Array.isArray(inventory) || inventory.length > 100) throw invalid("库存格式错误", "inventory");
  const quantities = new Map<string, string | null>();
  for (const row of inventory) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("库存格式错误", "inventory");
    ensureOnlyFields(row, ["itemId", "quantity"]);
    if (typeof row.itemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.itemId) || quantities.has(row.itemId)
      || (row.quantity !== null && (typeof row.quantity !== "string" || !/^(0|[1-9]\d{0,23})$/.test(row.quantity)))) throw invalid("库存须为不重复的物品身份和整数数量", "inventory");
    quantities.set(row.itemId, row.quantity);
  }
  return quantities;
}

export type IncomePreviewRelease = {
  releaseId: string; generation: string; priceVersionId: string; termVersionId: string; catalogRevision: string;
  mode: "SPREAD" | "PERCENT"; commissionRate: string | null; roundingPolicy: string; priceStatus: string; haffRule: QuoteInput["haffRule"];
  pricingPolicy?: ContentPayloadInput["pricingPolicy"];
};
export type IncomePreviewItem = {
  itemId: string; code: string; name: string; unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY"; enabled: boolean; required: boolean;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO" | null; unitQuantity: string | null; buyerUnitAmount: string | null; ownerUnitAmount: string | null;
};
export type PreviewPricingContext = { asOf: string; accountId?: string; ownerUserId?: string; rentalMode?: RentalMode };

/** Use the same mode and effective price as the later owner quote, without changing the listing. */
export async function resolveIncomePreviewRelease(client:PoolClient,gameId:string,base:IncomePreviewRelease,context?:PreviewPricingContext) {
  const tables=(await client.query<{modes:boolean;prices:boolean}>(`SELECT to_regclass('zzsh_supply.pricing_mode_schedule') IS NOT NULL AS modes,
    to_regclass('zzsh_supply.pricing_policy_schedule') IS NOT NULL AS prices`)).rows[0];
  if(!tables||typeof tables.modes!=="boolean"||typeof tables.prices!=="boolean")return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if(!tables.modes&&!tables.prices) return base.haffRule?.schema === "haff-ratio-v3"
    ? {available:false as const,reason:"RULE_UNCONFIGURED"} : {available:true as const,release:base};
  if(!tables.modes||!tables.prices||!context)return {available:false as const,reason:"PRICING_CONTEXT_REQUIRED"};
  const selected=context.accountId
    ? await readListingPricingModel(client,{accountId:context.accountId,ownerUserId:context.ownerUserId!,gameId,asOf:context.asOf,legacyPriceVersionId:base.priceVersionId})
    : await readNewListingPrice(client,gameId,base.priceVersionId,context.asOf).then(value=>({model:value.pricingModel}));
  if(!selected)return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if(selected.model==="FIXED_FEE"){
    // The ordinary rate is used only to read the common version when the form has no mode yet.
    const effective=await readEffectiveFixedFeePrice(client,gameId,context.rentalMode??"ordinary",context.asOf);
    if(!effective)return {available:false as const,reason:"RULE_UNCONFIGURED"};
    return {available:true as const,release:{...base,priceVersionId:effective.priceVersionId,mode:"PERCENT" as const,
      commissionRate:context.rentalMode?effective.commissionRate:null,roundingPolicy:effective.roundingPolicy,priceStatus:"SEALED",
      haffRule:effective.haffRule as IncomePreviewRelease["haffRule"],pricingPolicy:{schema:"pricing-policy-v1" as const,
        pricingModel:"FIXED_FEE" as const,scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId}}};
  }
  if(selected.model==="SPREAD"){
    const effective=await readEffectiveSpreadPrice(client,gameId,context.asOf);
    if(effective)return {available:true as const,release:{...base,priceVersionId:effective.priceVersionId,mode:"SPREAD" as const,
      commissionRate:null,roundingPolicy:effective.roundingPolicy,priceStatus:"SEALED",haffRule:effective.haffRule,
      pricingPolicy:{schema:"pricing-policy-v1" as const,pricingModel:"SPREAD" as const,scheduleId:effective.scheduleId,
        generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId}}};
    return {available:false as const,reason:"PRICING_POLICY_MISMATCH"};
  }
  if((selected.model==="LEGACY_SPREAD"&&base.mode!=="SPREAD")||(selected.model==="LEGACY_PERCENT"&&base.mode!=="PERCENT"))
    return {available:false as const,reason:"PRICING_POLICY_MISMATCH"};
  return {available:true as const,release:base};
}

export async function readIncomePreviewContext(client: PoolClient, gameId: string, expected: {catalogRevision: string; releaseId: string}, includeHaff = false, pricing?:PreviewPricingContext) {
  const base = (await client.query<IncomePreviewRelease>(`SELECT r.id AS "releaseId",r.generation::text AS generation,r.price_version_id AS "priceVersionId",r.term_version_id AS "termVersionId",g.catalog_revision::text AS "catalogRevision",p.mode,p.commission_rate::text AS "commissionRate",p.rounding_policy AS "roundingPolicy",p.status AS "priceStatus",p.haff_rule AS "haffRule" FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE g.id=$1 AND g.enabled`, [gameId])).rows[0];
  if (!base) return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if (base.releaseId !== expected.releaseId || base.catalogRevision !== expected.catalogRevision) throw conflict("资源规则已更新，请重新读取目录");
  const resolved=await resolveIncomePreviewRelease(client,gameId,base,pricing);
  if(!resolved.available)return resolved;
  const release=resolved.release;
  if (release.roundingPolicy !== ROUNDING_POLICY || !["SPREAD", "PERCENT"].includes(release.mode)) return {available:false as const,reason:"RULE_UNSUPPORTED"};
  const commission = release.mode === "PERCENT" && release.commissionRate !== null ? parseNonNegativeDecimal(release.commissionRate,8,"commission") : null;
  if (release.mode === "PERCENT" && ((!commission && release.pricingPolicy?.pricingModel!=="FIXED_FEE") || (commission && commission.value >= 10n ** BigInt(commission.scale)))) return {available:false as const,reason:"RULE_UNCONFIGURED"};
  const items=(await client.query<IncomePreviewItem>(`SELECT i.id AS "itemId",i.code,i.name,i.unit,i.enabled,i.required,p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.billable_item i LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD' WHERE i.game_id=$1${includeHaff ? "" : " AND i.unit<>'HAFF_BASE'"} ORDER BY i.sort_order,i.code,i.id`,[gameId,release.priceVersionId])).rows;
  return {available:true as const,release,items,commission};
}

export function projectResourceIncomePreview(items: readonly IncomePreviewItem[], quantities: ReadonlyMap<string, string | null>, release: IncomePreviewRelease, commission: ReturnType<typeof parseNonNegativeDecimal> | null) {
  if([...quantities.keys()].some(id=>!items.some(row=>row.itemId===id)))throw invalid("库存物品不属于当前游戏资源", "inventory");
  const lines=[],unpricedItemIds:string[]=[];let total=0n,declared=0;
  for(const item of items){
    const quantity=quantities.get(item.itemId)??null;
    if(isRetiredDeltaInsurance(item.code)){if(quantity!==null)assertDeltaResourceUnit(item.code,item.unit);continue;}
    if(!item.enabled||item.pricingKind!=="FIXED_UNIT") {if(quantity!==null)unpricedItemIds.push(item.itemId);continue;}
    assertDeltaResourceUnit(item.code,item.unit);
    try {
      const fixedFee=release.pricingPolicy?.pricingModel==="FIXED_FEE";
      const amounts=computeFixedUnitAmounts({...item,pricingKind:"FIXED_UNIT",quantity:quantity??"0",unitQuantity:item.unitQuantity??undefined,buyerUnitAmount:item.buyerUnitAmount??undefined,
        ownerUnitAmount:(fixedFee?item.buyerUnitAmount:item.ownerUnitAmount)??undefined},fixedFee?"SPREAD":release.mode,fixedFee?null:commission);
      const ownerAmount=quantity===null?null:yuanAmountObject(amounts.ownerAmount.value);
      if(ownerAmount){total+=amounts.ownerAmount.value;declared++;}
      lines.push({itemId:item.itemId,code:item.code,name:item.name,unit:item.unit,unitQuantity:amounts.unitQuantity.value.toString(),ownerUnitAmount:{currency:"CNY" as const,unit:"yuan" as const,amount:formatDecimalExact(amounts.ownerUnit),scale:amounts.ownerUnit.scale},quantity,ownerAmount});
    }catch {if(quantity!==null)unpricedItemIds.push(item.itemId);}
  }
  return {lines,ownerTotal:declared&&unpricedItemIds.length===0?yuanAmountObject(total):null,unreportedItemIds:lines.filter(row=>row.quantity===null).map(row=>row.itemId),unpricedItemIds};
}

export async function readResourceIncomePreview(client: PoolClient, gameId: string, inventory: unknown, expected: {catalogRevision: string; releaseId: string},
  account?: {accountId:string;ownerUserId:string}): Promise<Partial<ReturnType<typeof projectResourceIncomePreview>> & {
  available: boolean; reason?: string; informationalOnly?: boolean;
  incomeBasis?: "OWNER_RESOURCE_INCOME_BEFORE_FEES"; pricingPolicy?: NonNullable<ContentPayloadInput["pricingPolicy"]>;
  binding?: { gameId: string; releaseId: string; releaseGeneration: string; priceVersionId: string; catalogRevision: string };
}> {
  const quantities = parseIncomePreviewInventory(inventory);
  const asOf=(await client.query<{evaluatedAt:string}>(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt"`)).rows[0]?.evaluatedAt;
  if(!asOf)return {available:false,reason:"RULE_UNCONFIGURED"};
  const context = await readIncomePreviewContext(client, gameId, expected,false,{asOf,...account});
  if (!context.available) return {available:false,reason:context.reason};
  const {release, items, commission} = context;
  return {available:true,binding:{gameId,releaseId:release.releaseId,releaseGeneration:release.generation,priceVersionId:release.priceVersionId,catalogRevision:release.catalogRevision},
    ...projectResourceIncomePreview(items,quantities,release,commission),informationalOnly:true,
    ...(release.pricingPolicy?{incomeBasis:"OWNER_RESOURCE_INCOME_BEFORE_FEES" as const,pricingPolicy:release.pricingPolicy}:{})};
}

// Only the formal takeover writer supplies this after checking the immutable source map/observation.
export type LegacyTakeoverGradingContext = {
  kind: "VERIFIED_LEGACY_TAKEOVER";
  accountId: string;
  sourceDigest: string;
  observationVersionId: string;
  gradingCode: string | null;
  gradingDivision: number | null;
};
async function validatePublicationAttributes(client: PoolClient, a: PublishingAccount, attributes: Record<string, unknown>, legacy?: LegacyTakeoverGradingContext): Promise<void> {
  if (legacy && (legacy.kind !== "VERIFIED_LEGACY_TAKEOVER" || legacy.accountId !== a.id
    || !/^[a-f0-9]{64}$/.test(legacy.sourceDigest) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(legacy.observationVersionId)
    || legacy.gradingCode !== (attributes.grading_code ?? null) || legacy.gradingDivision !== (attributes.grading_division ?? null)))
    throw conflict("旧账号段位来源与当前申报不一致");
  const marker = attributes.legacy_published_reference;
  const reference = typeof marker === "string" ? await readLegacyPublishedReference(client, a.id, marker) : null;
  if (marker !== undefined && !reference) throw conflict("旧刊登图片来源已变化");
  if (reference && legacy && (reference.sourceDigest !== legacy.sourceDigest || reference.observationVersionId !== legacy.observationVersionId))
    throw conflict("旧刊登图片来源与当前申报不一致");
  validateDeltaPublicationAttributes(attributes, {
    requireGradingDivision: legacy === undefined && (!reference || reference.gradingCode !== attributes.grading_code),
    requireSupplementalDeclarations: legacy === undefined && !reference,
    requireServiceWindow: !reference,
    requireNewAccountFacts: legacy === undefined && !reference,
  });
}
export async function quoteListing(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
  legacyGrading?: LegacyTakeoverGradingContext,
  legacyQuote?: { actorId: string; sourceCanonical: string; policyCanonical: string;
    source: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["source"];
    policyBinding: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["policyBinding"];
    display: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["display"] },
): Promise<void> {
  checkAccountRevision(a, expected);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已归档，不能重新核价或上架");
  if ((await client.query(`SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status='COMPLETED' LIMIT 1`, [a.id])).rowCount) throw conflict("RENTAL_COMPLETED");
  await assertUnpublishedAccount(client, a);
  await requireWritableGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可为新申报草稿报价");
  const d = await readDeclaration(client, v);
  await validatePublicationAttributes(client, a, d.attributes, legacyGrading);
  if (d.inventory.some((i) => i.quantity === null))
    throw invalid("请补齐库存，未知数量不能当作零", "inventory");
  const missing = await client.query(
    `SELECT 1 FROM zzsh_supply.billable_item i WHERE game_id=$1 AND enabled AND required AND NOT EXISTS(SELECT 1 FROM zzsh_supply.inventory_line l WHERE l.version_id=$2 AND l.item_id=i.id AND l.quantity IS NOT NULL)`,
    [a.game_id, v.id],
  );
  if (missing.rowCount)
    throw invalid("必填物品须明确填写数量或零", "inventory");
  const release = (
    await client.query(
      `SELECT r.*,to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt",g.catalog_revision::text AS "catalogRevision",p.mode,p.commission_rate::text,p.haff_rule,p.rounding_policy,ag.digest FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} JOIN zzsh_supply.price_version p ON p.id=r.price_version_id JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE g.id=$1 AND g.enabled FOR SHARE OF g`,
      [a.game_id],
    )
  ).rows[0];
  if (!release) throw conflict("暂无可用规则");
  let priceVersionId:string=release.price_version_id;
  let priceMode:"SPREAD"|"PERCENT"=release.mode;
  let priceRule=release.haff_rule,priceRounding:string=release.rounding_policy,commissionRate:string|null=release.commission_rate;
  let pricingPolicy:ContentPayloadInput["pricingPolicy"];
  if(!legacyQuote){
    const selected=await readListingPricingModel(client,{accountId:a.id,ownerUserId:a.owner_user_id,gameId:a.game_id,asOf:release.evaluatedAt,legacyPriceVersionId:release.price_version_id});
    if (!selected && release.haff_rule?.schema === "haff-ratio-v3")
      throw conflict("当前尚未配置固定手续费价格政策");
    if(selected?.model==="FIXED_FEE"){
      const rentalMode=normalizeRentalPricing(d.attributes.rentalPricing).rentalMode;
      const effective=await readEffectiveFixedFeePrice(client,a.game_id,rentalMode,selected.asOf);
      if(!effective)throw conflict("当前尚未配置固定手续费价格政策");
      priceVersionId=effective.priceVersionId;priceMode="PERCENT";priceRule=effective.haffRule;priceRounding=effective.roundingPolicy;commissionRate=effective.commissionRate;
      pricingPolicy={schema:"pricing-policy-v1",pricingModel:"FIXED_FEE",scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId};
    }else if(selected?.model==="SPREAD"){
      const effective=await readEffectiveSpreadPrice(client,a.game_id,selected.asOf);
      if(!effective)throw conflict("当前价差政策无法核实");
      priceVersionId=effective.priceVersionId;priceMode="SPREAD";priceRule=effective.haffRule;priceRounding=effective.roundingPolicy;commissionRate=null;
      pricingPolicy={schema:"pricing-policy-v1",pricingModel:"SPREAD",scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId};
    }else if(selected?.model==="LEGACY_SPREAD"||selected?.model==="LEGACY_PERCENT"){
      const expected=selected.model==="LEGACY_SPREAD"?"SPREAD":"PERCENT";
      if(release.mode!==expected)throw conflict("原账号的抽成模式与当前规则不一致，请联系客服");
    }
  }
  const term = (
    await client.query(
      `SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`,
      [release.term_version_id, d.termOptionCode],
    )
  ).rows[0];
  if (!term) throw invalid("请选择当前租期选项", "termOptionCode");
  validateDeltaRentalTerm(d.attributes.rentalPricing == null ? undefined : normalizeRentalPricing(d.attributes.rentalPricing), term, d.termOptionCode);
  const rows = (
    await client.query(
      `SELECT l.item_id AS "itemId", i.code, l.quantity::text,i.unit,i.name,i.enabled,i.quantity_scale AS "quantityScale",p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD' WHERE l.version_id=$1 ORDER BY l.item_id`,
      [v.id, priceVersionId],
    )
  ).rows;
  if (!rows.length || rows.some((r) => !r.enabled || !r.pricingKind))
    throw invalid("申报物品不在当前可用价目中", "inventory");
  for (const row of rows) assertDeltaResourceUnit(row.code, row.unit);
  const ents = (
    await client.query(
      `SELECT e.id AS "entitlementId",e.expiry_kind AS "expiryKind",e.value_kind,e.name,e.enabled,l.value,l.expiry_knowledge,CASE WHEN l.expires_at IS NULL THEN NULL ELSE to_char(l.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt" FROM zzsh_supply.listing_entitlement l JOIN zzsh_supply.entitlement e ON e.id=l.entitlement_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (
    ents.some(
      (e) =>
        !e.enabled ||
        (e.value_kind === "FLAG"
          ? typeof e.value !== "boolean"
          : !Number.isSafeInteger(e.value) || e.value < 0),
    )
  )
    throw invalid("权益值与目录类型不符", "entitlements");
  const skins = (
    await client.query(
      `SELECT s.id,s.name,s.base_name,NULL::text AS category_id,NULL::text AS category_code,NULL::text AS category_name,s.enabled,s.form_visible,true AS category_visible,true AS category_retired,
        ${publicSkinOwnerNameSql("s")} AS owner_name,
        s.owner_kind,s.rarity_code,${publicSkinRarityNameSql("s")} AS rarity_name,${publicSkinMetadataSql("s")},
        ${publicSkinMediaIdSql("s")} AS media_id
        FROM zzsh_supply.listing_skin l JOIN zzsh_supply.skin s ON s.id=l.skin_id JOIN zzsh_supply.game g ON g.id=s.game_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (skins.some((s) => !s.enabled || !s.form_visible || !s.category_visible))
    throw invalid("皮肤已停止申报", "skins");
  if (
    ents.some((e) => e.expiryKind === "TIMED" && e.expiry_knowledge !== "KNOWN")
  )
    throw invalid("请先确认限时权益的到期时间", "entitlements");
  const attrs = d.attributes;
  const vitality = attrs.vit_level ?? attrs.vitLevel;
  const bear = attrs.bear_level ?? attrs.bearLevel;
  const depositDeclaration = validateOwnerDepositDeclaration(attrs.owner_deposit_declaration);
  const fundingPolicy = depositDeclaration ? await readFundingPolicyForRelease(client, release.id) : null;
  // Pricing keeps deposits null unless both sides are configured; the owner's
  // sealed declaration is what the renter sees as the base deposit.
  const deposits = fundingPolicy && depositDeclaration
    ? {
        tenantDepositCents: depositDeclaration.amountCents,
        publisherBailRequirementCents: fundingPolicy.guaranteeRequirement.mode === "NOT_REQUIRED" ? "0" : fundingPolicy.guaranteeRequirement.requiredCents,
      }
    : undefined;
  const normalInput = {
    customerTier: "STANDARD",
    priceVersionId,
    mode: priceMode,
    roundingPolicy: priceRounding,
    ...(commissionRate === null
      ? {}
      : { commissionRate }),
    ...(pricingPolicy?.pricingModel==="FIXED_FEE"?{fixedFeeAlgorithm:FIXED_FEE_ALGORITHM}:{}),
    haffRule: priceRule,
    lines: rows.map((r) => ({
      customerTier: "STANDARD",
      itemId: r.itemId,
      quantity: r.quantity,
      unit: r.unit,
      pricingKind: r.pricingKind,
      ...(r.unitQuantity === null ? {} : { unitQuantity: r.unitQuantity }),
      ...(r.buyerUnitAmount === null
        ? {}
        : { buyerUnitAmount: r.buyerUnitAmount }),
      ...(r.ownerUnitAmount === null
        ? {}
        : { ownerUnitAmount: r.ownerUnitAmount }),
    })),
    conditions: {
      safeBoxCode: String(attrs.safe_box_code ?? ""),
      vitLevel: typeof vitality === "number" ? vitality : undefined,
      bearLevel: typeof bear === "number" ? bear : undefined,
      termOptionCode: d.termOptionCode,
      pricingOptionCode: d.pricingOptionCode,
      ...(attrs.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(attrs.rentalPricing) }),
    },
    termOption: term,
    entitlements: ents.map((e) => ({
      entitlementId: e.entitlementId,
      expiryKind: e.expiryKind,
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
    })),
    ...(deposits ? { deposits } : {}),
  } as QuoteInput;
  let policyCanonical: string | undefined;
  let result: ReturnType<typeof computeDeltaQuote>;
  if (legacyQuote) {
    const marker = attrs.legacy_published_reference;
    const reference = typeof marker === "string" ? await readLegacyPublishedReference(client, a.id, marker) : null;
    if (!deposits || legacyGrading?.kind !== "VERIFIED_LEGACY_TAKEOVER" || legacyGrading.accountId !== a.id
      || legacyGrading.sourceDigest !== legacyQuote.source.sourceDigest || legacyGrading.observationVersionId !== legacyQuote.source.observationVersionId
      || !reference || reference.legacyId !== legacyQuote.source.legacyId || reference.sourceDigest !== legacyQuote.source.sourceDigest
      || reference.observationVersionId !== legacyQuote.source.observationVersionId) throw conflict("LEGACY_QUOTE_SOURCE_BINDING_MISMATCH");
    const { buildLegacyListedSourceQuote } = await import("./legacy-listed-source-quote");
    const frozen = buildLegacyListedSourceQuote({ ...legacyQuote, catalog: rows.map(r => ({ id:r.itemId, code:r.code, unit:r.unit, quantityScale:r.quantityScale })),
      declaredInventory:d.inventory.map(item => ({ itemId:item.itemId, quantity:item.quantity! })), termOption:term,
      priceVersionId:release.price_version_id, ruleReleaseId:release.id, publisherBailRequirementCents:deposits.publisherBailRequirementCents,
      expiryDisclosures:ents.map(e => ({ entitlementId:e.entitlementId, expiresAt:e.expiryKind === "TIMED" ? e.expiresAt : null, fullTermGuaranteed:false })) });
    policyCanonical = frozen.policyCanonical; result = { quotable:true, quote:frozen.quote };
  } else result = computeDeltaQuote(normalInput);
  if (!result.quotable)
    throw invalid(
      `当前条件无法报价：${result.reasonCodes.join(",")}`,
      "attributes",
    );
  result.quote.ruleReleaseId = release.id;
  const payload = normalizeContentPayload({
    schemaVersion: result.quote.schemaVersion,
    accountId: a.id,
    gameId: a.game_id,
    declaration: d,
    ruleRefs: {
      releaseId: release.id,
      catalogRevision: release.catalogRevision,
      priceVersionId: release.price_version_id,
      termVersionId: release.term_version_id,
      agreementVersionId: release.agreement_version_id,
      agreementDigest: release.digest,
    },
    quoteValues: result.quote as unknown as Record<string, unknown>,
    ...(pricingPolicy && (result.quote.schemaVersion===2||result.quote.schemaVersion===4)?{pricingPolicy}:{}),
    ...(result.quote.schemaVersion === 3 ? { quoteSource:"LEGACY_QUOTED" as const, legacyQuote:result.quote.legacyQuote } : {}),
  });
  if (legacyQuote && policyCanonical && result.quote.schemaVersion === 3) {
    const policyDigest = result.quote.legacyQuote!.sourcePolicyDigest, quoteCanonical = canonicalize(result.quote);
    await client.query(`INSERT INTO zzsh_supply.legacy_listed_policy_evidence(policy_digest,policy_canonical,policy,created_by_admin_id) VALUES($1,$2::text,$2::text::jsonb,$3) ON CONFLICT(policy_digest) DO NOTHING`, [policyDigest,policyCanonical,legacyQuote.actorId]);
    const policy = (await client.query(`SELECT 1 FROM zzsh_supply.legacy_listed_policy_evidence WHERE policy_digest=$1 AND policy_canonical=$2`,[policyDigest,policyCanonical])).rowCount;
    if (!policy) throw conflict("LEGACY_POLICY_EVIDENCE_MISMATCH");
    await client.query(`INSERT INTO zzsh_supply.legacy_listed_quote_evidence(listing_version_id,account_id,policy_digest,quote_digest,quote_canonical,quote,created_by_admin_id) VALUES($1,$2,$3,$4,$5::text,$5::text::jsonb,$6) ON CONFLICT(listing_version_id) DO NOTHING`,
      [v.id,a.id,policyDigest,sha256Hex(quoteCanonical),quoteCanonical,legacyQuote.actorId]);
    const quoteEvidence = (await client.query(`SELECT 1 FROM zzsh_supply.legacy_listed_quote_evidence WHERE listing_version_id=$1 AND account_id=$2 AND policy_digest=$3 AND quote_canonical=$4`,[v.id,a.id,policyDigest,quoteCanonical])).rowCount;
    if (!quoteEvidence) throw conflict("LEGACY_QUOTE_EVIDENCE_MISMATCH");
  }
  await client.query(
    `UPDATE zzsh_supply.listing_version SET payload=$2,content_hash=$3,rule_release_id=$4,presentation=$5,schema_version=$6,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      payload,
      computeContentHash(payload),
      release.id,
      {
        items: rows.map((r) => ({ id: r.itemId, code: r.code, name: r.name, unit: r.unit })),
        skins: skins.map(freezePresentationSkin),
        entitlements: ents.map((e) => ({ id: e.entitlementId, name: e.name })),
      },
      result.quote.schemaVersion,
    ],
  );
  await bumpAccount(client, a);
}
/**
 * Skin entry of a new quote/presentation snapshot. Owner type and official
 * quality are frozen when the snapshot is generated (null = not known then).
 * Readers never re-derive them from today's catalog, so snapshots written
 * before these fields existed keep the keys absent.
 */
export function freezePresentationSkin(s: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(s.category_retired === true ? { categoryModel: "RETIRED" } : {}),
    id: s.id,
    name: s.name,
    baseName: s.base_name,
    ownerName: s.owner_name,
    ownerKind: s.owner_kind ?? null,
    rarityCode: s.rarity_code ?? null,
    rarityName: s.rarity_name ?? null,
    rarityBasis: s.rarityBasis ?? null,
    isCollectible: s.isCollectible ?? null,
    defaultState: s.defaultState ?? "UNKNOWN",
    mediaKind: s.mediaKind ?? null,
    mediaId: s.media_id,
    categoryCode: s.category_code,
    categoryName: s.category_name,
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
function requireVersionToken(
  v: ListingVersion,
  body: Record<string, unknown>,
): void {
  if (
    v.id !== body.versionId ||
    !v.payload ||
    !v.content_hash ||
    v.content_hash !== body.contentHash ||
    v.rule_release_id !== body.releaseId
  )
    throw conflict("资料或规则已变化，请重新预览确认");
}
export async function assertCurrentRelease(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
  asOf?: string,
): Promise<void> {
  const game = (await client.query(
    `SELECT ${effectiveRuleRelease("g", "COALESCE($2::timestamptz, transaction_timestamp())")} AS current_release_id,catalog_revision::text,
      (SELECT r.price_version_id FROM zzsh_supply.rule_release r WHERE r.id=v.release_id) AS "basePriceVersionId",
      to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt"
      FROM zzsh_supply.game g CROSS JOIN LATERAL (SELECT ${effectiveRuleRelease("g", "COALESCE($2::timestamptz, transaction_timestamp())")} AS release_id) v
      WHERE g.id=$1 FOR SHARE OF g`,
    [a.game_id, asOf ?? null],
  )).rows[0];
  if (game?.current_release_id !== v.rule_release_id ||
    (v.review_state === "DRAFT" && v.origin === "NATIVE" && (!v.payload?.ruleRefs.catalogRevision || v.payload.ruleRefs.catalogRevision !== game.catalog_revision)))
    throw conflict("规则已更新，请在原草稿重新核价并确认");
  if(v.review_state==="DRAFT"&&v.origin==="NATIVE"&&v.payload&&v.payload.schemaVersion!==3){
    const selected=await readListingPricingModel(client,{accountId:a.id,ownerUserId:a.owner_user_id,gameId:a.game_id,
      asOf: asOf ?? game.evaluatedAt,legacyPriceVersionId:game.basePriceVersionId});
    if(selected&&selected.model!=="LEGACY_PERCENT"&&selected.model!=="LEGACY_SPREAD"){
      const policy=v.payload.pricingPolicy;
      if(!policy||policy.pricingModel!==selected.model)throw conflict("抽成模式已更新，请重新核价并确认");
      const effective=selected.model==="FIXED_FEE"
        ?await readEffectiveFixedFeePrice(client,a.game_id,normalizeRentalPricing(v.payload.declaration.attributes.rentalPricing).rentalMode,selected.asOf)
        :await readEffectiveSpreadPrice(client,a.game_id,selected.asOf);
      if(!effective||effective.scheduleId!==policy.scheduleId||effective.generation!==policy.generation||effective.priceVersionId!==policy.priceVersionId||normalizeTime(effective.effectiveAt)!==normalizeTime(policy.effectiveAt))
        throw conflict("价格政策已更新，请重新核价并确认");
      if (asOf && selected.model === "FIXED_FEE") {
        const timeline = await readFixedFeeTimeline(client, a.game_id, { from: asOf });
        const fee = timeline?.fees.find(row => row.generation === policy.generation);
        const rentalMode = normalizeRentalPricing(v.payload.declaration.attributes.rentalPricing).rentalMode;
        if (!timeline || !fee || !validateFixedFeeTimeline({ ...timeline, frozenFees: [
          ...(timeline.frozenFees ?? []), { rates: fee.rates, protectedModes: [rentalMode] },
        ] }).valid) throw conflict("会员或礼遇与固定手续费政策不兼容");
      }
    }
  }
}
export async function acceptListingRules(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已结束出租，不能修改上架资料");
  await assertUnpublishedAccount(client, a);
  await requireWritableGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可确认新申报草稿");
  if (!v.payload || !v.content_hash || !v.rule_release_id || !v.payload.ruleRefs)
    throw conflict("请先核对并生成本次资料的报价");
  await validatePublicationAttributes(client, a, v.payload!.declaration.attributes);
  await assertPublicationRentalTerm(client, v);
  const selected=v.payload?.declaration.attributes.full_payout_declaration as {selected?:boolean}|undefined;
  const policy=selected?.selected?await readFundingPolicyForRelease(client,v.rule_release_id!):null;
  if(selected?.selected && !policy)throw conflict("包赔资金政策未提供");
  const terms=selected?.selected?await readFullPayoutTerms(client,a.game_id,policy!,v.payload!.ruleRefs.priceVersionId):undefined;
  const accepted=terms?assertFullPayoutTermsAccepted(terms,body.fullPayoutTermsAcceptance):undefined;
  if(!terms && body.fullPayoutTermsAcceptance!==undefined)throw invalid("这份资料未选择包赔","fullPayoutTermsAcceptance");
  await client.query(
    `INSERT INTO zzsh_supply.rule_acceptance(id,owner_user_id,account_id,listing_version_id,rule_release_id,accepted_content_hash,full_payout_terms_version_id,full_payout_terms_digest,full_payout_disclosure_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_user_id,listing_version_id,rule_release_id,accepted_content_hash) DO NOTHING`,
    [
      newSupplyId("accept"),
      a.owner_user_id,
      a.id,
      v.id,
      v.rule_release_id,
      v.content_hash,
      accepted?.termsVersionId??null,accepted?.termsDigest??null,accepted?.disclosureVersion??null,
    ],
  );
  await bumpAccount(client, a);
}
async function assertAccepted(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
): Promise<void> {
  const selected=(v.payload?.declaration.attributes.full_payout_declaration as {selected?:boolean}|undefined)?.selected===true;
  const policy=selected?await readFundingPolicyForRelease(client,v.rule_release_id!):null;
  if(selected && !policy)throw conflict("包赔资金政策未提供");
  const terms=selected?await readFullPayoutTerms(client,a.game_id,policy!,v.payload!.ruleRefs.priceVersionId):undefined;
  if (selected && v.payload?.schemaVersion === 3 && v.payload.quoteSource === "LEGACY_QUOTED") {
    const authorized = (await client.query(`SELECT 1 FROM zzsh_supply.rule_acceptance r
      WHERE r.account_id=$1 AND r.listing_version_id=$2 AND r.rule_release_id=$3 AND r.accepted_content_hash=$4 AND r.owner_user_id=$5
        AND r.acceptance_kind='LEGACY_TAKEOVER_AUTHORIZED'
        AND r.authorization_evidence->>'basis'='ADMIN_AUTHORIZED_LEGACY_ELECTION'
        AND zzsh_supply.legacy_listed_quote_source_valid($1,$5,$2,$6::jsonb)`,
      [a.id,v.id,v.rule_release_id,v.content_hash,a.owner_user_id,JSON.stringify(v.payload)])).rowCount;
    if (!authorized) throw conflict("旧在架包赔来源授权未核实");
    return;
  }
  if (
    !(
      await client.query(
        `SELECT 1 FROM zzsh_supply.rule_acceptance WHERE account_id=$1 AND listing_version_id=$2 AND rule_release_id=$3 AND accepted_content_hash=$4 AND owner_user_id=$5${terms?" AND full_payout_terms_version_id=$6 AND full_payout_terms_digest=$7 AND full_payout_disclosure_version=$8":""}`,
        [a.id, v.id, v.rule_release_id, v.content_hash, a.owner_user_id,...(terms?[terms.termsVersionId,terms.termsDigest,terms.disclosureVersion]:[])],
      )
    ).rowCount
  )
    throw conflict("请先确认这份资料对应的规则和报价");
}
export function publicMediaCategory(attributes: Record<string, unknown>, assetId: string, legacyCategory?: string | null): "SHOWCASE" | "PENALTY" {
  const categories = attributes.media_categories as Record<string, unknown> | undefined;
  const category = categories ? categories[assetId] : legacyCategory;
  return category === "PENALTY" ? "PENALTY" : "SHOWCASE";
}

async function assertMediaReady(
  client: PoolClient,
  account: PublishingAccount,
  v: ListingVersion,
  mode: "direct" | "review" = "direct",
  lockMedia = false,
  preloadedMedia?: ListingMediaAssetRow[],
): Promise<void> {
  if (lockMedia) await client.query(
    `SELECT id FROM zzsh_supply.media_asset WHERE id IN (SELECT asset_id FROM zzsh_supply.listing_media WHERE version_id=$1)
      AND account_id=$2 AND owner_user_id=$3 AND game_id=$4 ORDER BY id FOR UPDATE`,
    [v.id, account.id, account.owner_user_id, account.game_id],
  );
  const media = preloadedMedia ??
    ((
      await client.query<ListingMediaAssetRow>(
        `SELECT a.* FROM zzsh_supply.listing_media m LEFT JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1 ORDER BY m.asset_id`,
        [v.id],
      )
    ).rows);
  const frozen = v.payload?.declaration.mediaBindings;
  if (!frozen || media.length !== frozen.length || new Set(media.map(m => m.id)).size !== media.length || media.some(m =>
    !isAccountMediaBinding(m, account) || !frozen.some(binding => binding.assetId === m.id && binding.byteHash === m.content_hash && binding.purpose === m.purpose)))
    throw notFound();
  const legacyReference = v.payload?.declaration.attributes.legacy_published_reference;
  if (media.length === 0 && typeof legacyReference === "string" && v.attributes.legacy_published_reference === legacyReference
    && await readLegacyPublishedReference(client, account.id, legacyReference))
    return;
  if (!media.some((m) => m.purpose === "ACCOUNT_DISPLAY" && publicMediaCategory(v.attributes, m.id, m.source_note) === "SHOWCASE"))
    throw invalid("至少需要一张展示图", "mediaBindings");
  if (mode === "review") {
    if (media.some((m) => m.review_state !== "APPROVED" ||
      (m.purpose === "ACCOUNT_DISPLAY" && (!m.public_storage_key || m.access_class !== "PUBLIC_DISPLAY"))))
      throw conflict("请先完成图片审核，私有凭证不能当展示图");
    return;
  }
  if (media.some((m) => {
    if (m.ownership_kind === "USER_SUPPLY" && m.purpose === "ACCOUNT_DISPLAY") {
      return !mediaReviewAllowsPublication(m.review_state) ||
        m.technical_state !== "READY" ||
        !m.public_storage_key ||
        m.access_class !== "PUBLIC_DISPLAY";
    }
    if (m.ownership_kind === "USER_SUPPLY" && m.purpose === "ACCOUNT_EVIDENCE") {
      return m.access_class !== "PRIVATE_REVIEW";
    }
    return m.review_state !== "APPROVED";
  })) throw conflict("图片技术校验尚未完成，私有凭证不能公开");
}
/** Only an explicit, account-bound credit waiver may be frozen on publication. */
export function publicationWaiverRevision(a: PublishingAccount, v: ListingVersion, gate: SupplyGate): string | null {
  if (gate.occupancy !== "FREE" || !gate.reference || !["SATISFIED", "NOT_REQUIRED"].includes(gate.publisherBail))
    throw conflict("上架资格已变化，请刷新后重试");
  const credit = gate.creditGuarantee;
  if (!credit) throw conflict("信用与保证金资格暂不能确认，请联系客服");
  if (credit.accountId !== a.id || credit.ownerUserId !== a.owner_user_id || credit.gameId !== a.game_id
    || credit.listingVersionId !== v.id || credit.releaseId !== v.rule_release_id || !v.payload?.ruleRefs || credit.priceVersionId !== v.payload.ruleRefs.priceVersionId
    || credit.reference !== gate.reference || credit.status !== gate.publisherBail)
    throw conflict("上架保证金依据已变化，请刷新后重试");
  const revision = credit.status === "NOT_REQUIRED" ? credit.creditRevision : null;
  if (credit.status === "NOT_REQUIRED" && (credit.requiredCents !== "0" || !revision || !/^[1-9]\d*$/.test(revision)))
    throw conflict("上架免缴依据暂不能确认，请联系客服");
  return revision;
}

async function publicationTime(client: PoolClient): Promise<string> {
  const at = (await client.query<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
  if (!at) throw conflict("上架时间无法核实");
  return at;
}

export async function submitListing(
  client: PoolClient,
  a: PublishingAccount,
  actorId: string,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
  fixedFeeTestAdmission?: FixedFeeTestListingAdmission,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已结束出租，不能再次上架");
  await assertUnpublishedAccount(client, a);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  if (v.review_state !== "DRAFT") throw conflict("当前资料不能重复提交");
  // shortcut: fixed-fee publication remains closed until the accounting and refund guards are complete.
  if (v.payload?.schemaVersion === 4) {
    if (!fixedFeeTestAdmission) throw conflict("固定手续费订单结算暂未就绪");
    await assertFixedFeeTestListingAdmission(client, fixedFeeTestAdmission, { role: "OWNER", actorId, ownerUserId: a.owner_user_id,
      accountId: a.id, listingVersionId: v.id, listingHash: v.content_hash });
  }
  if(v.payload?.pricingPolicy?.pricingModel==="SPREAD"&&!SCHEDULED_SPREAD_ORDER_ENABLED)throw conflict("价差订单结算暂未就绪");
  await assertCurrentRelease(client, a, v);
  if (!v.payload || !v.content_hash || !v.rule_release_id || !v.payload.ruleRefs)
    throw conflict("请先核对并生成本次资料的报价");
  await validatePublicationAttributes(client, a, v.payload!.declaration.attributes);
  await assertPublicationRentalTerm(client, v);
  const blockers = await publicationBlockers(client, a, v, gate);
  if (blockers.length) throw conflict(blockers.join(","));
  await assertAccepted(client, a, v);
  await assertMediaReady(client, a, v, "direct", true);
  // The gate has locked current credit/coverage; freeze only its explicit waiver.
  const waivedRevision = publicationWaiverRevision(a, v, await gate(client, a, "WRITE"));
  a.display_no = await assignAccountNumber(client, a.id);
  const publishedAt = await publicationTime(client);
  await assertCurrentRelease(client, a, v, publishedAt);
  await client.query(
    `INSERT INTO zzsh_supply.listing_publication
      (id,version_id,account_id,owner_user_id,game_id,rule_release_id,content_hash,source,published_by_realm,published_by_user_id,published_at,
       credit_guarantee_waived,credit_guarantee_waived_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,'OWNER_DIRECT','user',$8,$9::timestamptz,$10,$11)`,
    [newSupplyId("publication"),v.id,a.id,a.owner_user_id,a.game_id,v.rule_release_id,v.content_hash,actorId,publishedAt,waivedRevision ? true : null,waivedRevision],
  );
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='PUBLISHED',revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}
export async function withdrawListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  if (v.id !== body.versionId || v.review_state !== "SUBMITTED")
    throw conflict("该版本已被处理");
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='WITHDRAWN',revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}
export async function reviewListing(
  client: PoolClient,
  a: PublishingAccount,
  actorId: string,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
  legacyGrading?: LegacyTakeoverGradingContext,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "SUBMITTED") throw conflict("该版本已被处理");
  if (!["APPROVE", "REJECT"].includes(String(body.decision)))
    throw invalid("审核决定错误");
  const reason = humanText(String(body.reason ?? "")).trim();
  if (reason.length < 2 || reason.length > 500)
    throw invalid("请填写具体审核理由");
  let waivedRevision: string | null = null;
  if (body.decision === "APPROVE") {
    await assertUnpublishedAccount(client, a);
    // shortcut: fixed-fee publication remains closed until the accounting and refund guards are complete.
    if(v.payload?.schemaVersion===4)throw conflict("固定手续费订单结算暂未就绪");
    if(v.payload?.pricingPolicy?.pricingModel==="SPREAD"&&!SCHEDULED_SPREAD_ORDER_ENABLED)throw conflict("价差订单结算暂未就绪");
    await validatePublicationAttributes(client, a, v.payload!.declaration.attributes, legacyGrading);
    await assertPublicationRentalTerm(client, v);
    const blockers = await publicationBlockers(client, a, v, gate);
    if (blockers.length) throw conflict(blockers.join(","));
    await assertAccepted(client, a, v);
    await assertMediaReady(client, a, v, "review", true);
    waivedRevision = publicationWaiverRevision(a, v, await gate(client, a, "WRITE"));
    a.display_no = await assignAccountNumber(client, a.id);
  }
  if (body.decision === "APPROVE") await assertCurrentRelease(client, a, v, await publicationTime(client));
  await client.query(
    `INSERT INTO zzsh_supply.review_decision(id,version_id,release_id,content_hash,decision,reason,reviewer_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      newSupplyId("review"),
      v.id,
      v.rule_release_id,
      v.content_hash,
      body.decision,
      reason,
      actorId,
    ],
  );
  if (body.decision === "APPROVE") {
    await client.query(
      `UPDATE zzsh_supply.listing_version SET review_state='APPROVED',revision=revision+1 WHERE id=$1`,
      [v.id],
    );
    const publication = await client.query(
      `INSERT INTO zzsh_supply.listing_publication
        (id,version_id,account_id,owner_user_id,game_id,rule_release_id,content_hash,source,published_by_realm,published_by_admin_id,published_at,
         credit_guarantee_waived,credit_guarantee_waived_revision)
       SELECT $1,d.version_id,v.account_id,a.owner_user_id,a.game_id,d.release_id,d.content_hash,
              'LEGACY_APPROVED','admin',d.reviewer_admin_id,d.decided_at,$4,$5
         FROM zzsh_supply.review_decision d
         JOIN zzsh_supply.listing_version v ON v.id=d.version_id
         JOIN zzsh_supply.rental_account a ON a.id=v.account_id
        WHERE d.version_id=$2 AND d.release_id=v.rule_release_id AND d.content_hash=v.content_hash
          AND d.decision='APPROVE' AND d.reviewer_admin_id=$3
       RETURNING id`,
      [newSupplyId("publication"), v.id, actorId, waivedRevision ? true : null, waivedRevision],
    );
    if (publication.rowCount !== 1) throw conflict("审核决定未能形成发布事实");
  } else {
    await client.query(
      `UPDATE zzsh_supply.listing_version SET review_state='REJECTED',revision=revision+1 WHERE id=$1`,
      [v.id],
    );
  }
  await bumpAccount(client, a);
}
/** Existing order/channel facts must be resolved before a listing can be permanently removed. */
async function assertDelistPaymentSafe(client: PoolClient, accountId: string, pendingOrderId: string | null): Promise<void> {
  const functions = (await client.query<{ posting: boolean; prestart: boolean; support: boolean; controlled: boolean; supportZero: boolean }>(`SELECT
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.native_refund_terminal_complete(text)'),'EXECUTE'),false) AS posting,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.native_prestart_refund_terminal_complete(text)'),'EXECUTE'),false) AS prestart,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.support_cancellation_refund_terminal_complete(text)'),'EXECUTE'),false) AS support,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.local_controlled_refund_terminal_complete(text)'),'EXECUTE'),false) AS controlled,
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS "supportZero"`)).rows[0];
  if (!functions) throw conflict("订单收款状态暂不能确认，请联系客服");
  const checks: string[] = [];
  if (functions.posting) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='POSTING' AND zzsh_order.native_refund_terminal_complete(i.id))");
  if (functions.prestart) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='PRESTART_TERMINATION' AND zzsh_order.native_prestart_refund_terminal_complete(i.id))");
  if (functions.support) checks.push("(i.payment_source='JOINPAY' AND i.basis_kind='SUPPORT_CANCELLATION' AND zzsh_order.support_cancellation_refund_terminal_complete(i.id))");
  if (functions.controlled) checks.push("(i.payment_source='CONTROLLED' AND zzsh_order.local_controlled_refund_terminal_complete(i.id))");
  const refunded = checks.length ? `EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
    WHERE i.order_id=o.id AND i.payment_confirmation_id=pc.id AND i.state='SUCCEEDED' AND i.budget_disposition='CONSUMED'
      AND i.basis_kind IN ('PRESTART_TERMINATION','SUPPORT_CANCELLATION') AND NOT i.requires_review AND (${checks.join(" OR ")}))` : "false";
  const zeroRefund = functions.supportZero ? `EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation x
    WHERE x.order_id=o.id AND x.payment_confirmation_id=pc.id AND x.refund_cents=0
      AND zzsh_order.support_poststart_cancellation_complete(x.id)
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id))` : "false";
  const unresolved = await client.query(`SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=$1 AND o.id IS DISTINCT FROM $2
    AND (o.status IN ('PAID','COMPLETED') OR o.paid_confirmation_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_request q WHERE q.order_id=o.id)
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation q WHERE q.order_id=o.id)
      OR EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction q WHERE q.native_order_id=o.id))
    AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation pc
      JOIN zzsh_order.payment_request p ON p.order_id=o.id AND p.state='ACCEPTED'
      JOIN zzsh_order.payment_channel_transaction t ON t.native_order_id=o.id AND t.request_id=p.id
        AND t.channel=p.channel AND t.merchant_identity_id=p.merchant_identity_id AND t.channel_trx_no=pc.provider_transaction_id
      WHERE pc.id=o.paid_confirmation_id AND pc.order_id=o.id AND pc.disposition='APPLIED'
        AND pc.merchant_scope_id=p.merchant_identity_id AND pc.merchant_order_no=p.channel_order_no
        AND pc.amount_cents=p.amount_cents AND pc.currency=p.currency
        AND ((p.channel='JOINPAY' AND pc.source='JOINPAY' AND pc.joinpay_request_id=p.id AND pc.joinpay_anchor_id=t.id AND t.evidence_level='JOINPAY_VERIFIED'
            AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.id=pc.joinpay_evidence_id AND e.request_id=p.id
              AND e.event='E4' AND e.schema_outcome='VALID' AND e.signature_outcome='MATCH' AND e.binding_outcome='MATCH'
              AND e.channel_trx_no=pc.provider_transaction_id AND e.provider_paid_at=pc.provider_paid_at))
          OR (p.channel='CONTROLLED' AND pc.source='CONTROLLED' AND t.confirmation_id=pc.id AND t.evidence_level='CONTROLLED_TEST'))
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation other WHERE other.order_id=o.id AND other.id<>pc.id)
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction other WHERE other.native_order_id=o.id AND other.id<>t.id)
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id
          AND (i.requires_review OR i.state IN ('UNKNOWN','REVIEW_REQUIRED')
            OR (i.state IN ('SUCCEEDED','FAILED') AND (${checks.length ? checks.join(" OR ") : "false"}) IS NOT TRUE)))
        AND ((o.status='COMPLETED' AND EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s
          WHERE s.order_id=o.id AND s.payment_confirmation_id=pc.id AND s.captured_cents=pc.amount_cents))
          OR (o.status='CANCELLED' AND (${refunded} OR ${zeroRefund})
            AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=pc.id
              AND i.state IN ('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED'))))) LIMIT 1`, [accountId, pendingOrderId]);
  if (unresolved.rowCount) throw conflict("账号存在待核对的付款或退款，请先联系客服处理");
}

/** Caller holds the owner, game and account locks through the full transaction. */
export async function delistListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  actor: { userId: string; sessionId: string; requestId: string },
) {
  checkAccountRevision(a, body.expectedRevision);
  if (a.owner_user_id !== actor.userId) throw notFound();
  if (a.lifecycle !== "ACTIVE") throw conflict("该账号已结束出租，不能再次下架");
  await requireFreshPaymentSnapshot(client);
  if (await isRetiredMigratedAccount(client, a)) throw conflict("历史账号仅保留记录，请重新填写资料上架");
  const version = await currentVersion(client, a);
  const publication = await readListingPublication(client, a, version);
  if (version.origin !== "NATIVE" || !isEffectivePublicationState(version.review_state, publication?.source))
    throw conflict("当前账号未上架或仅保留历史资料");
  const occupancy = await readAccountOccupancyFacts(client, a.id);
  if (occupancy.state === "UNKNOWN") throw conflict("账号订单状态暂不能确认，请联系客服");
  if (occupancy.state === "OCCUPIED" && occupancy.kind !== "PENDING_PAYMENT")
    throw conflict("账号已有已付款或进行中的订单，请先处理订单");
  let cancelledOrderId: string | null = null;
  if (occupancy.kind === "PENDING_PAYMENT") {
    const pending = (await client.query<{ id: string }>(`SELECT id FROM zzsh_order.rental_order
      WHERE account_id=$1 AND owner_user_id=$2 AND status='PENDING_PAYMENT' FOR UPDATE`, [a.id,a.owner_user_id])).rows;
    if (pending.length !== 1) throw conflict("待付款订单状态已变化，请刷新后重试");
    const paymentFacts = (await client.query<UnpaidPaymentFacts>(`SELECT ${UNPAID_PAYMENT_FACT_COLUMNS}
      FROM zzsh_order.rental_order o WHERE o.id=$1`, [pending[0]!.id])).rows[0];
    if (!paymentFacts || hasUnpaidPaymentEvidence(paymentFacts)) throw conflict("待付款订单的支付状态需核对，请先联系客服处理");
    await assertDelistPaymentSafe(client, a.id, pending[0]!.id);
    const updated = await client.query(`UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='OWNER_DELISTED',
      cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
      WHERE id=$1 AND account_id=$2 AND status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL`, [pending[0]!.id,a.id]);
    if (updated.rowCount !== 1) throw conflict("待付款订单状态已变化，请刷新后重试");
    cancelledOrderId = pending[0]!.id;
    await recordAudit(client, { actorType:"user",actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
      action:"order.reservation.cancelled",objectType:"rental_order",objectId:cancelledOrderId,outcome:"SUCCESS",reason:"OWNER_DELISTED",
      details:{before:{status:"PENDING_PAYMENT"},after:{status:"CANCELLED",cancelReason:"OWNER_DELISTED"},accountId:a.id,channelClosed:false} });
  }
  else await assertDelistPaymentSafe(client, a.id, null);
  const remaining = await readAccountOccupancyFacts(client, a.id);
  if (remaining.state !== "FREE") throw conflict("账号还有未处理的订单，请联系客服");
  await client.query(`UPDATE zzsh_supply.rental_account SET lifecycle='DELISTED',owner_paused=false WHERE id=$1`, [a.id]);
  a.lifecycle = "DELISTED";
  a.owner_paused = false;
  await bumpAccount(client, a);
  let guaranteeRefund: Awaited<ReturnType<typeof enqueueDelistedGuaranteeRefund>>;
  try {
    guaranteeRefund = await enqueueDelistedGuaranteeRefund(client, {accountId:a.id,ownerUserId:a.owner_user_id,requestId:actor.requestId});
  } catch {
    throw conflict("保证金退款暂不能确认，请联系客服处理后再下架");
  }
  if (guaranteeRefund.state === "REVIEW_REQUIRED") throw conflict("保证金退款需要核对，请联系客服处理后再下架");
  return {cancelledOrderId,guaranteeRefund};
}
export async function restrictListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (
    typeof body.restricted !== "boolean" ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 2 ||
    body.reason.length > 500
  )
    throw invalid("请填写限制或解除原因");
  await client.query(
    `UPDATE zzsh_supply.rental_account SET staff_restricted=$2,restriction_reason=$3 WHERE id=$1`,
    [a.id, body.restricted, humanText(body.reason)],
  );
  a.staff_restricted = body.restricted;
  a.restriction_reason = body.reason;
  await bumpAccount(client, a);
}
export async function evaluatePublication(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
  gate: SupplyGateReader,
  purpose: "READ" | "WRITE" = "WRITE",
  strictReadErrors = false,
  shared?: ListingPageShared,
  media?: () => Promise<ListingMediaAssetRow[]>,
  observed?: { publication?: ListingPublication | null },
): Promise<string[]> {
  const publication = await readListingPublication(client, a, v);
  const blockers = await publicationBlockers(client, a, v, gate, purpose, strictReadErrors, shared, isEffectivePublicationState(v.review_state, publication?.source));
  if (observed) observed.publication = publication;
  if (!isEffectivePublicationState(v.review_state, publication?.source)) blockers.push("PUBLICATION_REQUIRED");
  if (a.owner_paused) blockers.push("OWNER_PAUSED");
  if (a.staff_restricted) blockers.push("STAFF_RESTRICTED");
  try {
    await assertAccepted(client, a, v);
  } catch (error) {
    if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
    // Acceptance failed before media was read, so this is not a confirmed missing image.
    blockers.push(v.payload && v.content_hash && v.rule_release_id ? "ACCEPTANCE_REQUIRED" : "QUOTE_REQUIRED");
    return blockers;
  }
  try {
    await assertMediaReady(client, a, v, "direct", false, media ? await media() : undefined);
  } catch (error) {
    if (strictReadErrors && !(error instanceof SecurityApiError)) throw error;
    blockers.push("MEDIA_REQUIRED");
  }
  return blockers;
}

/** Transaction preview keeps WRITE qualification predicates, but uses ordinary SELECT facts and READ gates. */
export async function evaluatePricePreviewPublication(client: PoolClient, a: PublishingAccount, v: ListingVersion, gate: SupplyGateReader): Promise<string[]> {
  const blockers = await evaluatePublication(client, a, v, gate, "READ", true);
  if (v.payload && v.origin === "NATIVE" && !(await currentTradeResourcesMatch(client, a, v, false))) blockers.push("RULE_CHANGED");
  if (listingTitleNeedsReview(v)) blockers.push("TITLE_REVIEW_REQUIRED");
  return [...new Set(blockers)];
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

async function readBoundTermOption(
  client: PoolClient,
  v: ListingVersion,
): Promise<BoundTermOption | null> {
  if (!v.rule_release_id || !v.term_option_code) return null;
  const row = (
    await client.query<BoundTermOption>(
      `SELECT o.code,o.name,o.daily_consumption::text AS "dailyConsumption" FROM zzsh_supply.rule_release r JOIN zzsh_supply.term_option o ON o.version_id=r.term_version_id WHERE r.id=$1 AND o.code=$2`,
      [v.rule_release_id, v.term_option_code],
    )
  ).rows[0];
  return row ?? null;
}

async function assertPublicationRentalTerm(client: PoolClient, v: ListingVersion): Promise<void> {
  const pricing = v.payload?.declaration.attributes.rentalPricing;
  if (pricing == null || normalizeRentalPricing(pricing).rentalMode !== "custom") return;
  validateDeltaRentalTerm(normalizeRentalPricing(pricing), await readBoundTermOption(client, v), v.term_option_code ?? "");
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
      if (availability === "RENTABLE" && (!quote || payload.schemaVersion === 4 || !SCHEDULED_SPREAD_ORDER_ENABLED)) {
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
  const agreement = v.rule_release_id
    ? (
        await client.query(
          `SELECT ag.id,ag.title,ag.body,ag.digest FROM zzsh_supply.rule_release r JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE r.id=$1`,
          [v.rule_release_id],
        )
      ).rows[0]
    : null;
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
