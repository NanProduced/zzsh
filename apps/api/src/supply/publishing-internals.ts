/**
 * 上架共享底座：账号/版本读取、乐观锁与修订校验、发布阻塞事实、声明读取与各项写入前置守卫。
 * 草稿、报价、审核、公开读四个域都依赖这里；本模块不反向依赖任何域，也不依赖 publishing.ts 门面。
 * 写函数一律接收调用方传入的 PoolClient，事务边界仍由调用方持有。
 */
import { effectiveRuleRelease } from "./effective-rule-release";
import { readLegacyPublishedReference } from "./legacy-published-reference";
import { readFullPayoutTerms } from "./full-payout-terms";
import { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { assertActiveInTransaction, identityAllowsProtectedTrade } from "../auth/user-identity";
import { normalizeQuote, normalizeTime, type ContentDeclaration, type ContentPayloadInput } from "./content-hash";
import { mediaReviewAllowsPublication, isAccountMediaBinding, type BoundTermOption } from "./listing-query";
import { conflict, invalid, notFound } from "./supply-util";
import { GAME_SERVICE, readGameService, requireWritableGameService, type GameServiceState } from "./game-services";
import { assertDeltaResourceUnit, normalizeRentalPricing, validateDeltaPublicationAttributes, validateDeltaRentalTerm } from "./delta-rental";
import { readFundingPolicyForRelease } from "./funding-authority";
import { validateOwnerDepositAmount, validateOwnerDepositDeclaration } from "./funding-policy";
import { validateFixedFeeTimeline } from "../auth/fixed-fee-policy-timeline";
import { readEffectiveFixedFeePrice, readEffectiveSpreadPrice, readListingPricingModel, readFixedFeeTimeline } from "./pricing-policy-schedule";

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

export async function bumpAccount(
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

export async function currentTradeResourcesMatch(client: PoolClient, a: PublishingAccount, v: ListingVersion, lockResources: boolean): Promise<boolean> {
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

export function listingTitleNeedsReview(v: ListingVersion): boolean {
  return typeof v.title === "string" && (v.title.includes("历史资料待核实") || (!v.title.trim() && v.origin !== "NATIVE"));
}

export async function isRetiredMigratedAccount(client: PoolClient, a: PublishingAccount): Promise<boolean> {
  const row = (await client.query<{retired:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM zzsh_supply.game g JOIN zzsh_supply.legacy_supply_map m ON m.account_id=$1
    WHERE g.id=$2 AND g.code='delta' AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts') AS retired`, [a.id,a.game_id])).rows[0];
  if (!row || typeof row.retired !== "boolean") throw conflict("账号来源暂不能确认，请联系客服");
  return row.retired;
}

export async function assertUnpublishedAccount(client: PoolClient, a: PublishingAccount): Promise<void> {
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

// Only the formal takeover writer supplies this after checking the immutable source map/observation.
export type LegacyTakeoverGradingContext = {
  kind: "VERIFIED_LEGACY_TAKEOVER";
  accountId: string;
  sourceDigest: string;
  observationVersionId: string;
  gradingCode: string | null;
  gradingDivision: number | null;
};

export async function validatePublicationAttributes(client: PoolClient, a: PublishingAccount, attributes: Record<string, unknown>, legacy?: LegacyTakeoverGradingContext): Promise<void> {
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

export function requireVersionToken(
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

export async function assertAccepted(
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

export async function assertMediaReady(
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

export async function readBoundTermOption(
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

export async function assertPublicationRentalTerm(client: PoolClient, v: ListingVersion): Promise<void> {
  const pricing = v.payload?.declaration.attributes.rentalPricing;
  if (pricing == null || normalizeRentalPricing(pricing).rentalMode !== "custom") return;
  validateDeltaRentalTerm(normalizeRentalPricing(pricing), await readBoundTermOption(client, v), v.term_option_code ?? "");
}
