import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize, normalizeDeclaration, computeContentHash, type ContentDeclaration } from "./content-hash";
import { CUSTOMER_TIERS, validateDeltaPublicationAttributes } from "./delta-rental";
import { readFundingPolicyForRelease } from "./funding-authority";
import { validateOwnerDepositAmount } from "./funding-policy";
import { DELTA_LEGACY_RESOURCES, lockLegacySource, normalizeResolutionInput, readLegacyMap, resolveLegacyObservationToDraft, type LegacyDraftResolutionInput } from "./legacy-observation";
import { legacyDisplayDigest, parseLegacyDisplaySnapshot, type LegacyDisplaySnapshot } from "./legacy-display-snapshot";
import { lockPublishingAccount, currentVersion, readDeclaration, saveListingDraft, quoteListing, reviewListing, assertCurrentRelease, type PublishingAccount, type SupplyGateReader } from "./publishing";
import { assertGameScope, conflict, fingerprintRequest, invalid, newSupplyId, sha256Hex, withIdempotency } from "./supply-util";
import { legacyPlanYuanToCents } from "../order/legacy-continuation-model";

type TradeActor = { id: string; sessionId: string; requestId: string };
export type TradeCatalogItem = { id: string; code: string; unit: string; quantityScale: number };
export type LegacyTradeIntake = {
  accountId: string; source: LegacyDraftResolutionInput;
  display: LegacyDisplaySnapshot; title: string; description: string | null;
  depositYuan: string | null; isFullPayout: "0" | "1" | null; ownerRatioB: string | null;
  termOptionCode: string; pricingOptionCode: string;
  skins: string[]; entitlements: ContentDeclaration["entitlements"];
  media: Array<{ assetId: string; byteHash: string; position: number; technicalState: string; accessClass: string }>;
  /** Reviewed extract row, kept in the batch file and the normal takeover audit, not a new runtime table. */
  sourceFieldEvidence: { canonical: string; digest: string; extractSha256: string; evidenceRef: string };
  /** Old insurance is DAY. A separately audited card-count fact is never inferred from it. */
  insuranceCountEvidence?: { quantity: string; canonical: string; digest: string; evidenceRef: string };
};
export function assertLegacyTradeSourceFields(input: LegacyTradeIntake) {
  const proof = input.sourceFieldEvidence;
  if (!proof || !/^[a-f0-9]{64}$/.test(proof.digest) || !/^[a-f0-9]{64}$/.test(proof.extractSha256) || !proof.evidenceRef || proof.evidenceRef.length > 512 || proof.canonical.length > 32768 || sha256Hex(proof.canonical) !== proof.digest) throw conflict("SOURCE_FIELD_EVIDENCE_MISSING");
  let row: Record<string, unknown>;
  try { row = JSON.parse(proof.canonical); } catch { throw conflict("SOURCE_FIELD_EVIDENCE_INVALID"); }
  if (!row || typeof row !== "object" || Array.isArray(row) || canonicalize(row) !== proof.canonical || row.sourceSystem !== input.source.sourceSystem || row.sourceEntity !== input.source.sourceEntity || row.legacyId !== input.source.legacyId || row.baseSourceDigest !== input.source.sourceDigest
    || row.deposit_amount !== input.depositYuan || row.is_full_payout !== input.isFullPayout || row.ownerRatioB !== input.ownerRatioB) throw conflict("SOURCE_FIELD_EVIDENCE_MISMATCH");
}
export type LegacyTradePlan = { admission: "TRADE_CANDIDATE" | "BLOCKED" | "ISOLATED"; reasons: string[]; draft: Record<string, unknown> | null; expectedMedia: ContentDeclaration["mediaBindings"]; inputDigest: string };
export function prepareLegacyTradeIntake(input: LegacyTradeIntake, catalog: readonly TradeCatalogItem[]): LegacyTradePlan {
  const reasons: string[] = [], snapshot = parseLegacyDisplaySnapshot(input.display);
  try { normalizeResolutionInput(input.source); if (input.source.sourceSystem!=="legacy_mysql_restore" || input.source.sourceEntity!=="la_rental_accounts" || !/^[1-9]\d{0,23}$/.test(input.source.legacyId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.accountId)) throw invalid(); } catch { reasons.push("SOURCE_BINDING_MISMATCH"); }
  try { assertLegacyTradeSourceFields(input); } catch { reasons.push("SOURCE_FIELD_EVIDENCE_MISMATCH"); }
  if (!input.title.trim() || input.title.includes("历史资料待核实")) reasons.push("TITLE_REVIEW_REQUIRED");
  const inventory: Array<{ itemId: string; quantity: string }> = [];
  for (const resource of snapshot.resources) {
    const entry = DELTA_LEGACY_RESOURCES.find(([field]) => field === resource.field)!;
    const codes: readonly string[] = resource.field === "top_insure_card_num" ? ["top_insure_card_piece"] : entry[1];
    const items = catalog.filter(item => codes.includes(item.code));
    if (items.length !== 1) { reasons.push(items.length ? "AMBIGUOUS_ITEM_ID" : "CATALOG_ITEM_MISSING"); continue; }
    const item = items[0]!;
    let quantity = resource.quantity, unit = resource.unit;
    if (resource.field === "top_insure_card_num") {
      const proof = input.insuranceCountEvidence;
      const expected = proof && canonicalize({ sourceSystem: input.source.sourceSystem, sourceEntity: input.source.sourceEntity, legacyId: input.source.legacyId, baseSourceDigest: input.source.sourceDigest, quantity: proof.quantity, unit: "PIECE" });
      if (!proof || !/^(0|[1-9]\d{0,23})$/.test(proof.quantity) || proof.canonical !== expected || sha256Hex(proof.canonical) !== proof.digest || !proof.evidenceRef || proof.evidenceRef.length > 512) { reasons.push("INSURANCE_UNIT_PENDING"); continue; }
      quantity = proof.quantity; unit = "PIECE";
    }
    if (quantity === null) { reasons.push("SOURCE_FIELD_MISSING"); continue; }
    if (item.unit !== unit || item.quantityScale !== 0) { reasons.push("CATALOG_UNIT_MISMATCH"); continue; }
    inventory.push({ itemId: item.id, quantity });
  }
  if (new Set(inventory.map(item => item.itemId)).size !== inventory.length) reasons.push("AMBIGUOUS_ITEM_ID");
  const rentalMode = snapshot.rentalMode;
  if (rentalMode === null || rentalMode !== "ordinary" && (input.ownerRatioB === null || !/^[1-9]\d{0,9}(?:\.\d{1,8})?$/.test(input.ownerRatioB))) reasons.push("MODE_RATIO_UNPROVEN");
  let depositCents: string | null = null;
  if (input.depositYuan === null) reasons.push("DEPOSIT_POLICY_VIOLATION");
  else { try { depositCents = legacyPlanYuanToCents(input.depositYuan); } catch { reasons.push("DEPOSIT_POLICY_VIOLATION"); } }
  if (input.isFullPayout !== "0" && input.isFullPayout !== "1") reasons.push("FUNDING_POLICY_UNKNOWN");
  // Each media dimension blocks separately so a review sees the real gap instead of one merged code.
  if (!input.media.length) reasons.push("MEDIA_UNAVAILABLE");
  else {
    if (input.media.length > 20) reasons.push("MEDIA_ASSET_COUNT_INVALID");
    if (new Set(input.media.map(m => m.assetId)).size !== input.media.length) reasons.push("MEDIA_ASSET_CONFLICT");
    if (new Set(input.media.map(m => m.position)).size !== input.media.length || input.media.some(m => !Number.isSafeInteger(m.position) || m.position < 0 || m.position > 19)) reasons.push("MEDIA_POSITION_INVALID");
    if (input.media.some(m => m.technicalState !== "READY")) reasons.push("MEDIA_NOT_READY");
    if (input.media.some(m => m.accessClass !== "PUBLIC_DISPLAY")) reasons.push("MEDIA_VISIBILITY_NOT_PUBLIC");
    if (input.media.some(m => !/^[a-f0-9]{64}$/.test(m.byteHash))) reasons.push("MEDIA_BYTE_HASH_INVALID");
  }
  if (!input.termOptionCode) reasons.push("TERM_OPTION_UNPROVEN");
  const attributes = { ...snapshot.attributes,
    rentalPricing: { rentalMode, ...(rentalMode === "ordinary" ? {} : { ownerRatioB: input.ownerRatioB }) },
    owner_deposit_declaration: { schema: "owner-deposit-declaration-v1", amountCents: depositCents, declarationVersion: "legacy-trade-intake-v1" },
    full_payout_declaration: { schema: "full-payout-declaration-v1", selected: input.isFullPayout === "1" } };
  try { validateDeltaPublicationAttributes(attributes); } catch { reasons.push("LEVEL_OR_WINDOW_MISSING"); }
  let body: Record<string, unknown> = { title: input.title, description: input.description, attributes, inventory: inventory.sort((a, b) => a.itemId.localeCompare(b.itemId)), skins: input.skins, entitlements: input.entitlements,
    mediaBindings: input.media.map(m => ({ assetId: m.assetId, position: m.position })), termOptionCode: input.termOptionCode, pricingOptionCode: input.pricingOptionCode };
  let expectedMedia: ContentDeclaration["mediaBindings"] = [];
  if (!reasons.length) {
    try {
      const normalized = normalizeDeclaration({ title: input.title, description: input.description, attributes, inventory, skins: input.skins, entitlements: input.entitlements,
        termOptionCode: input.termOptionCode, pricingOptionCode: input.pricingOptionCode, mediaBindings: input.media.map(m => ({ assetId: m.assetId, byteHash: m.byteHash, position: m.position, purpose: "ACCOUNT_DISPLAY" })) }, 2);
      expectedMedia = normalized.mediaBindings;
      body = { ...normalized, mediaBindings: normalized.mediaBindings.map(m => ({ assetId: m.assetId, position: m.position })) };
    }
    catch { reasons.push("FORMAL_DECLARATION_INVALID"); }
  }
  return { admission: reasons.length ? "BLOCKED" : "TRADE_CANDIDATE", reasons: [...new Set(reasons)], draft: reasons.length ? null : body, expectedMedia, inputDigest: sha256Hex(canonicalize(input)) };
}
async function authorize(client: PoolClient, actor: TradeActor, a: PublishingAccount) {
  await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage"); requirePermission(access, "supply.review.decide");
  await assertGameScope(client, actor.id, access?.isBoss === true, a.game_id);
}
async function assertTierCoverage(client: PoolClient, a: PublishingAccount) {
  // Publish readiness follows the formal confirmation tiers: a listing whose member tier has no
  // price line would 503 at confirmation, so the takeover never publishes it.
  const missing = (await client.query(`SELECT 1 FROM zzsh_supply.listing_version v JOIN zzsh_supply.rule_release r ON r.id=v.rule_release_id
    CROSS JOIN unnest($2::text[]) AS tier(name) JOIN zzsh_supply.inventory_line i ON i.version_id=v.id
    WHERE v.id=$1 AND NOT EXISTS(SELECT 1 FROM zzsh_supply.price_line p WHERE p.price_version_id=r.price_version_id AND p.item_id=i.item_id AND p.customer_tier=tier.name) LIMIT 1`, [a.current_version_id, [...CUSTOMER_TIERS]])).rowCount;
  if (missing) throw conflict("MEMBER_PRICE_LINE_MISSING");
}
async function assertMediaBindingSubject(client: PoolClient, a: PublishingAccount, versionId: string) {
  // The batch file declares asset IDs; the database decides whether they really are this
  // account's display images. A foreign or platform asset is never a legal account binding.
  const media = (await client.query(`SELECT a.id,a.account_id,a.owner_user_id,a.purpose FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1`, [versionId])).rows;
  if (!media.length
    || media.some(m => m.account_id !== a.id || m.owner_user_id !== a.owner_user_id || m.purpose !== "ACCOUNT_DISPLAY")) throw conflict("MEDIA_BINDING_SUBJECT_MISMATCH");
}
async function assertMaterialized(client: PoolClient, a: PublishingAccount, plan: LegacyTradePlan) {
  const v = await currentVersion(client, a);
  if (!v.payload || !v.content_hash || computeContentHash(v.payload) !== v.content_hash || canonicalize(v.attributes) !== canonicalize(v.payload.declaration.attributes)) throw conflict("MATERIALIZATION_MISMATCH");
  const declaration = await readDeclaration(client, v);
  const draft = plan.draft!;
  for (const key of ["title", "description", "attributes", "inventory", "skins", "entitlements", "termOptionCode", "pricingOptionCode"] as const) {
    if (canonicalize(declaration[key]) !== canonicalize(draft[key])) throw conflict("MATERIALIZATION_MISMATCH");
  }
  if (canonicalize(declaration.mediaBindings) !== canonicalize(plan.expectedMedia)) throw conflict("MATERIALIZATION_MEDIA_MISMATCH");
  await assertMediaBindingSubject(client, a, v.id);
  await assertTierCoverage(client, a);
  const policy = await readFundingPolicyForRelease(client, v.rule_release_id!);
  if (!policy) throw conflict("FUNDING_POLICY_UNKNOWN");
  validateOwnerDepositAmount(policy, (v.attributes.owner_deposit_declaration as { amountCents: string }).amountCents, (v.attributes.full_payout_declaration as { selected: boolean }).selected);
  return v;
}
async function publishTakenOverDraft(client: PoolClient, a: PublishingAccount, actor: TradeActor, source: LegacyDraftResolutionInput, batchId: string, gate: SupplyGateReader) {
  const v = await currentVersion(client, a);
  await assertCurrentRelease(client, a, v);
  if (v.origin !== "NATIVE" || v.review_state !== "DRAFT" || !v.payload || !v.content_hash) throw conflict("TAKEOVER_DRAFT_REQUIRED");
  // Re-checked at publish time: the owner-acceptance gap must not become a window to re-point media.
  await assertMediaBindingSubject(client, a, v.id);
  const selected = (v.attributes.full_payout_declaration as { selected?: boolean })?.selected;
  if (typeof selected !== "boolean") throw conflict("FUNDING_POLICY_UNKNOWN");
  if (!selected) {
    await client.query(`INSERT INTO zzsh_supply.rule_acceptance(id,owner_user_id,account_id,listing_version_id,rule_release_id,accepted_content_hash,acceptance_kind,authorization_evidence)
      VALUES($1,$2,$3,$4,$5,$6,'LEGACY_TAKEOVER_AUTHORIZED',$7::jsonb) ON CONFLICT(owner_user_id,listing_version_id,rule_release_id,accepted_content_hash) DO NOTHING`,
      [newSupplyId("accept"), a.owner_user_id, a.id, v.id, v.rule_release_id, v.content_hash, JSON.stringify({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: source.legacyId, sourceDigest: source.sourceDigest, observationVersionId: source.expectedObservationVersionId, authorizingAdminId: actor.id, batchId })]);
  } else {
    const accepted = (await client.query(`SELECT 1 FROM zzsh_supply.rule_acceptance WHERE owner_user_id=$1 AND listing_version_id=$2 AND rule_release_id=$3 AND accepted_content_hash=$4 AND acceptance_kind='OWNER_ACCEPTED' AND full_payout_terms_version_id IS NOT NULL`, [a.owner_user_id, v.id, v.rule_release_id, v.content_hash])).rowCount;
    if (!accepted) throw conflict("TERMS_ACCEPTANCE_REQUIRED");
  }
  // 0052 requires a matching acceptance before SUBMITTED, then an exact review decision.
  await client.query(`UPDATE zzsh_supply.listing_version SET review_state='SUBMITTED',revision=revision+1 WHERE id=$1 AND review_state='DRAFT'`, [v.id]);
  await reviewListing(client, a, actor.id, { expectedRevision: a.revision, versionId: v.id, contentHash: v.content_hash, releaseId: v.rule_release_id, decision: "APPROVE", reason: "LEGACY_APPROVED_TAKEOVER:" + batchId }, gate);
  return { accountId: a.id, versionId: v.id, releaseId: v.rule_release_id, contentHash: v.content_hash, state: "PUBLISHED" as const };
}
export type LegacyTradeTakeoverInput = { batchId: string; intake: LegacyTradeIntake };
/** Reviewed per-account maintenance transaction. Never exposed as arbitrary customer JSON. */
export async function takeoverLegacyTrade(client: PoolClient, actor: TradeActor, input: LegacyTradeTakeoverInput, gate: SupplyGateReader) {
  input = structuredClone(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(input.batchId)) throw invalid("Invalid takeover batch");
  const { intake } = input, operation = "supply.legacy.trade_takeover";
  let account: PublishingAccount;
  return withIdempotency(client, { realm: "admin", principalId: actor.id, operation, resourceId: intake.accountId }, sha256Hex(JSON.stringify([intake.accountId, intake.source.expectedObservationVersionId, sha256Hex(canonicalize(intake))])), fingerprintRequest(operation, intake.accountId, input),
    async () => {
      // The reused resolver acquires this same standard idempotency lock. Take it before account locks to avoid reversing its order.
      const resolveOperation="supply.legacy.resolve-draft", resolveKey=sha256Hex(JSON.stringify([resolveOperation,intake.source.sourceSystem,intake.source.sourceEntity,intake.source.legacyId]));
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[JSON.stringify(["supply-idempotency",JSON.stringify(["admin",actor.id,resolveOperation,intake.accountId]),resolveKey])]);
      account = await lockPublishingAccount(client, intake.accountId); await authorize(client, actor, account);
      if (account.owner_user_id !== intake.source.expectedOwnerUserId || account.game_id !== intake.source.expectedGameId) throw conflict("SOURCE_BINDING_MISMATCH");
      await lockLegacySource(client, intake.source);
      const mapping = await readLegacyMap(client, intake.source);
      if (!mapping || mapping.account_id !== account.id || mapping.source_digest !== intake.source.sourceDigest || mapping.version_id !== intake.source.expectedObservationVersionId) throw conflict("SOURCE_BINDING_MISMATCH");
      const display = (await client.query(`SELECT observation_version_id,base_source_digest,extract_sha256,source_updated_at,evidence_ref,snapshot,display_digest
        FROM zzsh_supply.legacy_listing_display_snapshot WHERE account_id=$1 AND schema_version=1`, [account.id])).rows[0];
      if (!display || display.observation_version_id !== mapping.version_id || display.base_source_digest !== mapping.source_digest || !(display.source_updated_at instanceof Date)
        || display.display_digest !== legacyDisplayDigest(account.id, { observationVersionId: display.observation_version_id, baseSourceDigest: display.base_source_digest,
          extractSha256: display.extract_sha256, sourceUpdatedAt: display.source_updated_at.toISOString(), evidenceRef: display.evidence_ref, snapshot: display.snapshot })
        || canonicalize(display.snapshot) !== canonicalize(intake.display)) throw conflict("DISPLAY_SOURCE_BINDING_MISMATCH");
      assertLegacyTradeSourceFields(intake);
      const observation = (await client.query(`SELECT title,description FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2 AND origin='LEGACY_OBSERVATION'`, [mapping.version_id, account.id])).rows[0];
      if (!observation || observation.title !== intake.title || observation.description !== intake.description) throw conflict("OBSERVATION_DECLARATION_MISMATCH");
    }, async () => {
      const a = account!;
      const catalog = (await client.query<TradeCatalogItem>(`SELECT id,code,unit,quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled ORDER BY id`, [a.game_id])).rows;
      const plan = prepareLegacyTradeIntake(intake, catalog);
      if (plan.admission !== "TRADE_CANDIDATE") throw conflict(plan.reasons.join(","));
      const v = a.current_version_id ? await currentVersion(client, a) : null;
      if (v?.origin === "LEGACY_OBSERVATION") await resolveLegacyObservationToDraft(client, a.id, intake.source, actor, gate);
      else if (!v || v.origin !== "NATIVE" || v.review_state !== "DRAFT") throw conflict("TAKEOVER_DRAFT_REQUIRED");
      const current = await lockPublishingAccount(client, a.id);
      await saveListingDraft(client, current, { ...plan.draft, expectedRevision: current.revision }, gate);
      await quoteListing(client, current, current.revision);
      const materialized = await assertMaterialized(client, current, plan);
      const selected = intake.isFullPayout === "1";
      const result = selected ? { accountId: current.id, versionId: materialized.id, releaseId: materialized.rule_release_id, contentHash: materialized.content_hash, state: "OWNER_ACCEPTANCE_REQUIRED" as const }
        : await publishTakenOverDraft(client, current, actor, intake.source, input.batchId, gate);
      await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId: actor.requestId, action: operation, objectType: "rental_account", objectId: current.id, outcome: "SUCCESS", details: { batchId: input.batchId, source: intake.source, inputDigest: plan.inputDigest, ...result } });
      return { status: 200, body: result };
    });
}
/** After the owner genuinely accepts the sealed terms, publish the same exact draft. */
export async function finalizeLegacyTradeTakeover(client: PoolClient, actor: TradeActor, input: { accountId: string; source: LegacyDraftResolutionInput; batchId: string; expectedRevision: string; versionId: string; contentHash: string; releaseId: string }, gate: SupplyGateReader) {
  input = structuredClone(input);
  normalizeResolutionInput(input.source);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(input.batchId))throw invalid("Invalid takeover batch");
  const operation = "supply.legacy.trade_takeover.finalize";
  let a: PublishingAccount;
  return withIdempotency(client, { realm: "admin", principalId: actor.id, operation, resourceId: input.accountId }, sha256Hex(JSON.stringify([input.accountId, input.versionId, input.contentHash])), fingerprintRequest(operation, input.accountId, input),
    async () => { a = await lockPublishingAccount(client, input.accountId); await authorize(client, actor, a);if(a.owner_user_id!==input.source.expectedOwnerUserId || a.game_id!==input.source.expectedGameId)throw conflict("SOURCE_BINDING_MISMATCH"); }, async () => {
      await lockLegacySource(client,input.source);
      const mapping = await readLegacyMap(client, input.source);
      const v = await currentVersion(client, a!);
      if (!mapping || mapping.account_id !== input.accountId || mapping.source_digest !== input.source.sourceDigest || mapping.version_id !== input.source.expectedObservationVersionId || a!.revision !== input.expectedRevision || v.id !== input.versionId || v.content_hash !== input.contentHash || v.rule_release_id !== input.releaseId) throw conflict("SOURCE_BINDING_MISMATCH");
      if(!(await client.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE action='supply.legacy.trade_takeover' AND object_id=$1 AND outcome='SUCCESS' AND details->>'batchId'=$2 AND details->>'versionId'=$3 AND details->>'contentHash'=$4 AND details->>'state'='OWNER_ACCEPTANCE_REQUIRED'`,[input.accountId,input.batchId,input.versionId,input.contentHash])).rowCount)throw conflict("TAKEOVER_DRAFT_REQUIRED");
      await assertTierCoverage(client, a!);
      const result = await publishTakenOverDraft(client, a!, actor, input.source, input.batchId, gate);
      await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId: actor.requestId, action: operation, objectType: "rental_account", objectId: input.accountId, outcome: "SUCCESS", details: result });
      return { status: 200, body: result };
    });
}
