import type { PoolClient } from "pg";
import {
  canonicalize,
  humanText,
  normalizeDeclaration,
  type ContentDeclaration,
} from "./content-hash";
import {
  assertEditable,
  lockPublishingAccount,
  type PublishingAccount,
  type SupplyGateReader,
} from "./publishing";
import {
  assertGameScope,
  conflict,
  fingerprintRequest,
  invalid,
  newSupplyId,
  notFound,
  sha256Hex,
  withIdempotency,
} from "./supply-util";
import {
  loadEffectiveAdminAccess,
  requirePermission,
} from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import {
  LEGACY_SKIN_FIELDS,
  type LegacySkinField,
  splitLegacySkinColumn,
  buildLegacySkinIndex,
  mapLegacySkinHolding,
  declarableLegacySkinIds,
  type LegacySkinCatalogEntry,
  type LegacySkinTokenRule,
} from "../legacy-load/legacy-skin-holdings";

type LegacyInventoryInput = {
  itemId: string;
  quantity: string | null;
};

type LegacyMediaBindingInput = {
  assetId: string;
  position: number;
};

export type LegacyCompleteDeclarationInput = {
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  skins: string[];
  entitlements: ContentDeclaration["entitlements"];
  mediaBindings: LegacyMediaBindingInput[];
  termOptionCode: string;
  pricingOptionCode: string;
};

export type LegacyObservationInput = {
  sourceSystem: string;
  sourceEntity: string;
  legacyId: string;
  evidenceRef: string;
  sourceDigest: string;
  inventory: LegacyInventoryInput[];
  /** Optional keeps the old inventory-only observation caller compatible. */
  declaration?: LegacyCompleteDeclarationInput;
};

export type LegacyImportActor = {
  id: string;
  sessionId: string;
  requestId: string;
};

export type LegacyDraftResolutionInput = {
  sourceSystem: string;
  sourceEntity: string;
  legacyId: string;
  sourceDigest: string;
  expectedObservationVersionId: string;
  /** A server-side assertion from the legal account-create result. */
  expectedOwnerUserId: string;
  expectedGameId: string;
};

export type LegacyDraftResolutionResult = {
  accountId: string;
  observationVersionId: string;
  versionId: string;
  status: "DRAFT";
};

type NormalizedLegacyObservation = Omit<LegacyObservationInput, "inventory" | "declaration"> & {
  inventory: LegacyInventoryInput[];
  declaration?: LegacyCompleteDeclarationInput;
};

export type LegacyMapRow = {
  source_digest: string;
  account_id: string;
  version_id: string;
  evidence_ref: string;
};

type LegacyObservationVersionRow = {
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
  schema_version: number;
};

type LegacyComparableContent = {
  inventory: LegacyInventoryInput[];
  declaration: LegacyCompleteDeclarationInput;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^$|^[a-z][a-z0-9_:-]{1,63}$/;
const QUANTITY_PATTERN = /^(0|[1-9]\d{0,23})$/;

// Only source conversion uses the old 60-round group. Native inventory is
// already in base units and must never pass through this function again.
export function legacyResourceBaseQuantity(field: string, value: unknown, insuranceSemantic: "DAY" = "DAY"): { quantity: string | null; unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY" | "UNKNOWN" } {
  const units: Record<string, "HAFF_BASE" | "ROUND" | "PIECE"> = { haff:"HAFF_BASE",level6_bullet_num:"ROUND",awm_bullet_num:"ROUND",barrett_bullet_num:"ROUND",level6_armor_num:"PIECE",level6_helmet_num:"PIECE",coffee_num:"PIECE" };
  if (field === "top_insure_card_num" && insuranceSemantic !== "DAY") throw invalid("顶级保险卡基础单位为天");
  const unit = field === "top_insure_card_num" ? "DAY" : units[field];
  if (!unit) throw invalid("Unknown legacy resource field");
  if (value === null || value === undefined || value === "") return { quantity:null, unit };
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !QUANTITY_PATTERN.test(text)) throw invalid("Legacy quantity is invalid");
  const quantity = (BigInt(text) * (field === "level6_bullet_num" ? 60n : 1n)).toString();
  if (!QUANTITY_PATTERN.test(quantity)) throw invalid("Legacy quantity is out of range");
  return { quantity, unit };
}

export const DELTA_LEGACY_RESOURCES = [
  ["haff", ["haff_base", "df_billable_haff"]],
  ["level6_bullet_num", ["level6_round", "df_billable_level6_bullet"]],
  ["awm_bullet_num", ["awm_round", "df_billable_awm_bullet"]],
  ["barrett_bullet_num", ["df_billable_barrett_bullet"]],
  ["level6_armor_num", ["level6_armor", "df_billable_level6_armor"]],
  ["level6_helmet_num", ["level6_helmet", "df_billable_level6_helmet"]],
  ["coffee_num", ["coffee", "df_billable_coffee"]],
  ["top_insure_card_num", ["df_billable_top_insure_card"]],
] as const;

/** Restore-source account inventory only. Native declarations already contain
 * base quantities; frozen orders keep their own quantities/prices unchanged. */
export function convertLegacyDeltaInventory(
  source: { sourceSystem: string; sourceEntity: string; legacyId: string; row: Record<string, unknown> },
  catalog: Array<{ id: string; code: string; unit: string; quantityScale: number }>,
): { inventory: LegacyInventoryInput[]; pending: Array<{ field: string; quantity: string | null; unit: string; reason: string }> } {
  if (source.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts" || !source.legacyId)
    throw invalid("Legacy resource source is not verified");
  const inventory: LegacyInventoryInput[] = [], pending: Array<{ field: string; quantity: string | null; unit: string; reason: string }> = [];
  for (const [field, codes] of DELTA_LEGACY_RESOURCES) {
    if (!Object.hasOwn(source.row, field)) { pending.push({field,quantity:null,unit:"UNKNOWN",reason:"SOURCE_FIELD_MISSING"}); continue; }
    // Old and new insurance share the original DAY identity and unchanged day quantity.
    const converted = legacyResourceBaseQuantity(field, source.row[field], "DAY");
    const matches = catalog.filter(item => (codes as readonly string[]).includes(item.code));
    if (matches.length !== 1) { pending.push({field,...converted,reason:matches.length ? "AMBIGUOUS_ITEM_ID" : "CATALOG_ITEM_MISSING"}); continue; }
    const item = matches[0]!;
    if (item.unit !== converted.unit || item.quantityScale !== 0) { pending.push({field,...converted,reason:"CATALOG_UNIT_MISMATCH"}); continue; }
    inventory.push({itemId:item.id,quantity:converted.quantity});
  }
  if (new Set(inventory.map(item => item.itemId)).size !== inventory.length) throw invalid("Legacy resources cannot share a target identity");
  return {inventory:inventory.sort((a,b)=>a.itemId.localeCompare(b.itemId)),pending};
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function idText(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw invalid("Legacy identifier is invalid", path);
  return value;
}

function sourceReferenceFields(input: {
  sourceSystem: unknown;
  sourceEntity: unknown;
  legacyId: unknown;
  evidenceRef?: unknown;
  sourceDigest: unknown;
}): void {
  if (
    typeof input.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
    ![
      input.sourceSystem,
      input.sourceEntity,
      input.legacyId,
      ...(input.evidenceRef === undefined ? [] : [input.evidenceRef]),
    ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)
  )
    throw invalid("Legacy source reference is required");
}

function normalizeInventory(inventory: unknown): LegacyInventoryInput[] {
  if (!Array.isArray(inventory) || inventory.length > 100)
    throw invalid("Legacy inventory is invalid", "inventory");
  const seen = new Set<string>();
  const normalized = inventory.map((entry) => {
    if (!recordValue(entry) || Object.keys(entry).some((key) => !["itemId", "quantity"].includes(key)))
      throw invalid("Legacy inventory is invalid", "inventory");
    const itemId = idText(entry.itemId, "inventory");
    if (seen.has(itemId)) throw invalid("Legacy inventory is duplicated", "inventory");
    seen.add(itemId);
    const quantity = entry.quantity;
    if (quantity !== null && (typeof quantity !== "string" || !QUANTITY_PATTERN.test(quantity)))
      throw invalid("Legacy quantity requires a base-unit integer or null", "inventory");
    return { itemId, quantity };
  });
  return normalized.sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function normalizeCompleteDeclaration(
  declaration: LegacyCompleteDeclarationInput,
): LegacyCompleteDeclarationInput {
  if (!recordValue(declaration)) throw invalid("Legacy declaration is invalid", "declaration");
  const allowed = [
    "title",
    "description",
    "attributes",
    "skins",
    "entitlements",
    "mediaBindings",
    "termOptionCode",
    "pricingOptionCode",
  ];
  if (Object.keys(declaration).some((key) => !allowed.includes(key)))
    throw invalid("Legacy declaration contains unsupported fields", "declaration");
  if (typeof declaration.title !== "string") throw invalid("Legacy title is invalid", "declaration.title");
  if (declaration.description !== null && typeof declaration.description !== "string")
    throw invalid("Legacy description is invalid", "declaration.description");
  if (!recordValue(declaration.attributes)) throw invalid("Legacy attributes are invalid", "declaration.attributes");
  if (!Array.isArray(declaration.skins) || declaration.skins.length > 100)
    throw invalid("Legacy skins are invalid", "declaration.skins");
  if (new Set(declaration.skins).size !== declaration.skins.length)
    throw invalid("Legacy skins are duplicated", "declaration.skins");
  const skins = declaration.skins.map((skin) => idText(skin, "declaration.skins")).sort();
  if (!Array.isArray(declaration.entitlements) || declaration.entitlements.length > 100)
    throw invalid("Legacy entitlements are invalid", "declaration.entitlements");
  if (!Array.isArray(declaration.mediaBindings) || declaration.mediaBindings.length > 100)
    throw invalid("Legacy media bindings are invalid", "declaration.mediaBindings");
  if (typeof declaration.termOptionCode !== "string" || !CODE_PATTERN.test(declaration.termOptionCode))
    throw invalid("Legacy term option is invalid", "declaration.termOptionCode");
  if (typeof declaration.pricingOptionCode !== "string" || !CODE_PATTERN.test(declaration.pricingOptionCode))
    throw invalid("Legacy pricing option is invalid", "declaration.pricingOptionCode");

  const seenEntitlements = new Set<string>();
  for (const entitlement of declaration.entitlements) {
    if (!recordValue(entitlement)) throw invalid("Legacy entitlement is invalid", "declaration.entitlements");
    const entitlementId = idText(entitlement.entitlementId, "declaration.entitlements");
    if (seenEntitlements.has(entitlementId)) throw invalid("Legacy entitlements are duplicated", "declaration.entitlements");
    seenEntitlements.add(entitlementId);
    if (!["entitlementId", "value", "expiresAt", "expiryKnowledge"].every((key) => Object.hasOwn(entitlement, key)))
      throw invalid("Legacy entitlement is incomplete", "declaration.entitlements");
  }

  const seenMediaPositions = new Set<number>();
  for (const media of declaration.mediaBindings) {
    if (!recordValue(media) || Object.keys(media).some((key) => !["assetId", "position"].includes(key)))
      throw invalid("Legacy media binding is invalid", "declaration.mediaBindings");
    const assetId = idText(media.assetId, "declaration.mediaBindings");
    if (!Number.isSafeInteger(media.position) || media.position < 0 || media.position > 99)
      throw invalid("Legacy media position is invalid", "declaration.mediaBindings");
    if (seenMediaPositions.has(media.position)) throw invalid("Legacy media position is duplicated", "declaration.mediaBindings");
    seenMediaPositions.add(media.position);
  }

  let normalized: ContentDeclaration;
  try {
    normalized = normalizeDeclaration(
      {
        title: humanText(declaration.title),
        description: declaration.description === null ? null : humanText(declaration.description),
        attributes: declaration.attributes,
        inventory: [],
        skins,
        entitlements: declaration.entitlements,
        termOptionCode: declaration.termOptionCode,
        pricingOptionCode: declaration.pricingOptionCode,
        mediaBindings: [],
      },
      Object.hasOwn(declaration.attributes, "rentalPricing") ? 2 : 1,
    );
  } catch {
    throw invalid("Legacy declaration attributes or values are invalid", "declaration");
  }
  if (normalized.title.length > 120) throw invalid("Legacy title is too long", "declaration.title");
  if (normalized.description !== null && normalized.description.length > 4000)
    throw invalid("Legacy description is too long", "declaration.description");
  return {
    title: normalized.title,
    description: normalized.description,
    attributes: normalized.attributes,
    skins: [...normalized.skins],
    entitlements: [...normalized.entitlements],
    mediaBindings: [...declaration.mediaBindings].sort(
      (left, right) => left.position - right.position || left.assetId.localeCompare(right.assetId),
    ),
    termOptionCode: normalized.termOptionCode,
    pricingOptionCode: normalized.pricingOptionCode,
  };
}

/** Pure boundary normalization used by both the writer and its offline tests. */
export function normalizeLegacyObservationInput(
  input: LegacyObservationInput,
): NormalizedLegacyObservation {
  if (!recordValue(input)) throw invalid("Legacy observation is invalid");
  sourceReferenceFields(input);
  const inventory = normalizeInventory(input.inventory);
  if (input.declaration === undefined)
    return {
      sourceSystem: input.sourceSystem,
      sourceEntity: input.sourceEntity,
      legacyId: input.legacyId,
      evidenceRef: input.evidenceRef,
      sourceDigest: input.sourceDigest,
      inventory,
    };
  return {
    sourceSystem: input.sourceSystem,
    sourceEntity: input.sourceEntity,
    legacyId: input.legacyId,
    evidenceRef: input.evidenceRef,
    sourceDigest: input.sourceDigest,
    inventory,
    declaration: normalizeCompleteDeclaration(input.declaration),
  };
}

export function normalizeResolutionInput(input: LegacyDraftResolutionInput): LegacyDraftResolutionInput {
  sourceReferenceFields(input);
  return {
    sourceSystem: input.sourceSystem,
    sourceEntity: input.sourceEntity,
    legacyId: input.legacyId,
    sourceDigest: input.sourceDigest,
    expectedObservationVersionId: idText(input.expectedObservationVersionId, "expectedObservationVersionId"),
    expectedOwnerUserId: idText(input.expectedOwnerUserId, "expectedOwnerUserId"),
    expectedGameId: idText(input.expectedGameId, "expectedGameId"),
  };
}

export async function lockLegacySource(client: PoolClient, input: Pick<LegacyObservationInput, "sourceSystem" | "sourceEntity" | "legacyId">): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [JSON.stringify(["supply-legacy-source", input.sourceSystem, input.sourceEntity, input.legacyId])],
  );
}

export async function readLegacyMap(
  client: PoolClient,
  input: Pick<LegacyObservationInput, "sourceSystem" | "sourceEntity" | "legacyId">,
): Promise<LegacyMapRow | undefined> {
  // The source advisory lock serializes map creation; the immutable map intentionally
  // grants runtime SELECT/INSERT without the UPDATE privilege required by FOR UPDATE.
  return (
    await client.query<LegacyMapRow>(
      `SELECT source_digest,account_id,version_id,evidence_ref
         FROM zzsh_supply.legacy_supply_map
        WHERE source_system=$1 AND source_entity=$2 AND legacy_id=$3`,
      [input.sourceSystem, input.sourceEntity, input.legacyId],
    )
  ).rows[0];
}

/** Reads the immutable source map bound to one target account. */


function comparableContent(input: NormalizedLegacyObservation): LegacyComparableContent {
  return {
    inventory: input.inventory,
    declaration: input.declaration ?? normalizeCompleteDeclaration({
      title: "历史资料待核实",
      description: null,
      attributes: {},
      skins: [],
      entitlements: [],
      mediaBindings: [],
      termOptionCode: "",
      pricingOptionCode: "",
    }),
  };
}

function comparableContentFingerprint(content: LegacyComparableContent): string {
  return sha256Hex(canonicalize(content));
}

async function readStoredObservationContent(
  client: PoolClient,
  versionId: string,
  accountId: string,
): Promise<LegacyComparableContent> {
  const version = (
    await client.query<LegacyObservationVersionRow>(
      `SELECT id,account_id,sequence,origin,review_state,title,description,attributes,term_option_code,pricing_option_code,schema_version
         FROM zzsh_supply.listing_version
        WHERE id=$1 AND account_id=$2
        FOR UPDATE`,
      [versionId, accountId],
    )
  ).rows[0];
  if (!version) throw conflict("Legacy observation version is missing");
  const inventory = (
    await client.query<LegacyInventoryInput>(
      `SELECT item_id AS "itemId",quantity::text AS quantity
         FROM zzsh_supply.inventory_line
        WHERE version_id=$1
        ORDER BY item_id`,
      [versionId],
    )
  ).rows;
  const skins = (
    await client.query<{ skinId: string }>(
      `SELECT skin_id AS "skinId"
         FROM zzsh_supply.listing_skin
        WHERE version_id=$1
        ORDER BY skin_id`,
      [versionId],
    )
  ).rows.map(({ skinId }) => skinId);
  const entitlements = (
    await client.query<ContentDeclaration["entitlements"][number]>(
      `SELECT entitlement_id AS "entitlementId",value,
              CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt",
              expiry_knowledge AS "expiryKnowledge"
         FROM zzsh_supply.listing_entitlement
        WHERE version_id=$1
        ORDER BY entitlement_id`,
      [versionId],
    )
  ).rows;
  const mediaBindings = (
    await client.query<LegacyMediaBindingInput>(
      `SELECT asset_id AS "assetId",position
         FROM zzsh_supply.listing_media
        WHERE version_id=$1
        ORDER BY position,asset_id`,
      [versionId],
    )
  ).rows;
  return {
    inventory,
    declaration: normalizeCompleteDeclaration({
      title: version.title,
      description: version.description,
      attributes: version.attributes,
      skins,
      entitlements,
      mediaBindings,
      termOptionCode: version.term_option_code,
      pricingOptionCode: version.pricing_option_code,
    }),
  };
}

async function assertLegacyResolutionState(
  client: PoolClient,
  account: PublishingAccount,
  observation: LegacyObservationVersionRow,
): Promise<void> {
  if (account.current_version_id === observation.id) {
    if (account.legacy_hold !== "UNRESOLVED")
      throw conflict("Legacy hold requires an explicit resolution state");
    return;
  }
  const prior = (
    await client.query<{ id: string; origin: string; review_state: string }>(
      `SELECT id,origin,review_state FROM zzsh_supply.listing_version
        WHERE account_id=$1 AND sequence=$2`,
      [account.id, String(BigInt(observation.sequence) + 1n)],
    )
  ).rows[0];
  if (
    account.current_version_id === prior?.id &&
    prior.origin === "NATIVE" &&
    prior.review_state === "DRAFT"
  ) {
    if (account.legacy_hold !== "NONE") throw conflict("Legacy hold requires an explicit resolution state");
    return;
  }
  throw conflict("The account version changed after the legacy observation");
}

async function writeLegacyChildren(
  client: PoolClient,
  versionId: string,
  inventory: readonly LegacyInventoryInput[],
  declaration?: LegacyCompleteDeclarationInput,
): Promise<void> {
  for (const item of inventory)
    await client.query(
      `INSERT INTO zzsh_supply.inventory_line(version_id,item_id,quantity) VALUES($1,$2,$3)`,
      [versionId, item.itemId, item.quantity],
    );
  if (!declaration) return;
  for (const skinId of declaration.skins)
    await client.query(
      `INSERT INTO zzsh_supply.listing_skin(version_id,skin_id) VALUES($1,$2)`,
      [versionId, skinId],
    );
  for (const entitlement of declaration.entitlements)
    await client.query(
      `INSERT INTO zzsh_supply.listing_entitlement(version_id,entitlement_id,value,expires_at,expiry_knowledge) VALUES($1,$2,$3,$4,$5)`,
      [
        versionId,
        entitlement.entitlementId,
        JSON.stringify(entitlement.value ?? null),
        entitlement.expiresAt,
        entitlement.expiryKnowledge,
      ],
    );
  for (const media of declaration.mediaBindings)
    await client.query(
      `INSERT INTO zzsh_supply.listing_media(version_id,asset_id,position) VALUES($1,$2,$3)`,
      [versionId, media.assetId, media.position],
    );
}

async function authorizeLegacyAdmin(
  client: PoolClient,
  actor: LegacyImportActor,
  account: PublishingAccount,
): Promise<void> {
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage");
  await assertGameScope(client, actor.id, access!.isBoss, account.game_id);
}

/**
 * Controlled compatibility seam. The caller must already own a transaction;
 * there is intentionally no public route or import command around this method.
 */
export async function recordLegacyObservation(
  client: PoolClient,
  accountId: string,
  input: LegacyObservationInput,
  actor: LegacyImportActor,
): Promise<string> {
  const normalized = normalizeLegacyObservationInput(input);
  const operation = "supply.legacy.observation";
  const idempotencyKey = sha256Hex(
    JSON.stringify([operation, normalized.sourceSystem, normalized.sourceEntity, normalized.legacyId]),
  );
  const fingerprint = fingerprintRequest(operation, accountId, normalized);
  let account: PublishingAccount | undefined;
  let previous: LegacyMapRow | undefined;
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.id, operation, resourceId: accountId },
    idempotencyKey,
    fingerprint,
    async () => {
      account = await lockPublishingAccount(client, accountId);
      await authorizeLegacyAdmin(client, actor, account);
      await lockLegacySource(client, normalized);
      previous = await readLegacyMap(client, normalized);
      if (previous) {
        if (previous.source_digest !== normalized.sourceDigest || previous.account_id !== accountId)
          throw conflict("Legacy source conflicts with the recorded observation");
        const recorded = await readStoredObservationContent(client, previous.version_id, accountId);
        if (comparableContentFingerprint(comparableContent(normalized)) !== comparableContentFingerprint(recorded))
          throw conflict("Legacy source content conflicts with the recorded observation");
      }
      return false;
    },
    async () => {
      const a = account!;
      if (previous) return { status: 200, body: { versionId: previous.version_id } };
      if (a.current_version_id) throw conflict("Do not overwrite a new-platform declaration");
      const id = newSupplyId("observation");
      const declaration = normalized.declaration;
      await client.query(
        `INSERT INTO zzsh_supply.listing_version
          (id,account_id,sequence,origin,title,description,attributes,term_option_code,pricing_option_code,schema_version)
         VALUES($1,$2,1,'LEGACY_OBSERVATION',$3,$4,$5,$6,$7,$8)`,
        [
          id,
          a.id,
          declaration?.title ?? "历史资料待核实",
          declaration?.description ?? null,
          declaration?.attributes ?? {},
          declaration?.termOptionCode ?? "",
          declaration?.pricingOptionCode ?? "",
          declaration?.attributes && Object.hasOwn(declaration.attributes, "rentalPricing") ? 2 : 1,
        ],
      );
      await writeLegacyChildren(client, id, normalized.inventory, declaration);
      await client.query(
        `UPDATE zzsh_supply.listing_version SET review_state='IMPORTED_UNVERIFIED' WHERE id=$1`,
        [id],
      );
      await client.query(
        `INSERT INTO zzsh_supply.legacy_supply_map(source_system,source_entity,legacy_id,account_id,version_id,evidence_ref,source_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          normalized.sourceSystem,
          normalized.sourceEntity,
          normalized.legacyId,
          a.id,
          id,
          normalized.evidenceRef,
          normalized.sourceDigest,
        ],
      );
      await client.query(
        `UPDATE zzsh_supply.rental_account
            SET current_version_id=$2,legacy_hold='UNRESOLVED',revision=revision+1
          WHERE id=$1`,
        [a.id, id],
      );
      await recordAudit(client, {
        actorType: "admin",
        actorId: actor.id,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        action: "supply.publication.legacy_observed",
        objectType: "rental_account",
        objectId: a.id,
        outcome: "SUCCESS",
        reason: "保留旧来源观察，不补造审核与报价",
        details: {
          before: { currentVersionId: null },
          after: {
            currentVersionId: id,
            state: "IMPORTED_UNVERIFIED",
            evidenceRef: normalized.evidenceRef,
            sourceSystem: normalized.sourceSystem,
            sourceEntity: normalized.sourceEntity,
            legacyId: normalized.legacyId,
            sourceDigest: normalized.sourceDigest,
            completeDeclaration: Boolean(declaration),
          },
          result: "OBSERVED",
        },
      });
      return { status: 200, body: { versionId: id } };
    },
  );
  return (result.body as { versionId: string }).versionId;
}

/**
 * Resolve one already-created target account. This does not create an account:
 * the caller obtains accountId from the normal user account-create result first.
 */
export async function resolveLegacyObservationToDraft(
  client: PoolClient,
  accountId: string,
  input: LegacyDraftResolutionInput,
  actor: LegacyImportActor,
  gate: SupplyGateReader,
): Promise<LegacyDraftResolutionResult> {
  const normalized = normalizeResolutionInput(input);
  const operation = "supply.legacy.resolve-draft";
  const idempotencyKey = sha256Hex(
    JSON.stringify([operation, normalized.sourceSystem, normalized.sourceEntity, normalized.legacyId]),
  );
  const fingerprint = fingerprintRequest(operation, accountId, normalized);
  let account: PublishingAccount | undefined;
  let mapping: LegacyMapRow | undefined;
  let observation: LegacyObservationVersionRow | undefined;
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.id, operation, resourceId: accountId },
    idempotencyKey,
    fingerprint,
    async () => {
      account = await lockPublishingAccount(client, accountId);
      await authorizeLegacyAdmin(client, actor, account);
      if (account.owner_user_id !== normalized.expectedOwnerUserId)
        throw conflict("Target account owner does not match the resolved owner");
      if (account.game_id !== normalized.expectedGameId)
        throw conflict("Target account game does not match the resolved game");
      await assertEditable(client, account, gate, true);
      await lockLegacySource(client, normalized);
      mapping = await readLegacyMap(client, normalized);
      if (!mapping) throw notFound();
      if (mapping.source_digest !== normalized.sourceDigest || mapping.account_id !== accountId)
        throw conflict("Legacy source conflicts with the target account");
      if (mapping.version_id !== normalized.expectedObservationVersionId)
        throw conflict("Legacy observation version does not match the request");
      observation = (
        await client.query<LegacyObservationVersionRow>(
          `SELECT id,account_id,sequence,origin,review_state,title,description,attributes,term_option_code,pricing_option_code,schema_version
             FROM zzsh_supply.listing_version
            WHERE id=$1 AND account_id=$2
            FOR UPDATE`,
          [mapping.version_id, accountId],
        )
      ).rows[0];
      if (!observation) throw conflict("Legacy observation version is missing");
      if (observation.origin !== "LEGACY_OBSERVATION" || observation.review_state !== "IMPORTED_UNVERIFIED")
        throw conflict("Legacy observation is no longer resolvable");
      await assertLegacyResolutionState(client, account, observation);
      return false;
    },
    async () => {
      const a = account!;
      const old = observation!;
      await assertLegacyResolutionState(client, a, old);
      if (a.current_version_id !== old.id) {
        const prior = (
          await client.query<{ id: string; origin: string; review_state: string }>(
            `SELECT id,origin,review_state FROM zzsh_supply.listing_version
              WHERE account_id=$1 AND sequence=$2`,
            [accountId, String(BigInt(old.sequence) + 1n)],
          )
        ).rows[0]!;
        return {
          status: 200,
          body: {
            accountId,
            observationVersionId: old.id,
            versionId: prior.id,
            status: "DRAFT" as const,
          },
        };
      }
      const nextSequence = (
        await client.query<{ next: string }>(
          `SELECT (COALESCE(MAX(sequence),0)+1)::text AS next FROM zzsh_supply.listing_version WHERE account_id=$1`,
          [accountId],
        )
      ).rows[0]!.next;
      const id = newSupplyId("listing");
      await client.query(
        `INSERT INTO zzsh_supply.listing_version
          (id,account_id,sequence,origin,review_state,title,description,attributes,term_option_code,pricing_option_code,schema_version)
         SELECT $1,account_id,$2,'NATIVE','DRAFT',title,description,attributes,term_option_code,pricing_option_code,schema_version
           FROM zzsh_supply.listing_version
          WHERE id=$3 AND account_id=$4`,
        [id, nextSequence, old.id, accountId],
      );
      for (const [table, fields] of [
        ["inventory_line", "item_id,quantity"],
        ["listing_entitlement", "entitlement_id,value,expires_at,expiry_knowledge"],
        ["listing_media", "asset_id,position"],
      ])
        await client.query(
          `INSERT INTO zzsh_supply.${table}(version_id,${fields}) SELECT $1,${fields} FROM zzsh_supply.${table} WHERE version_id=$2`,
          [id, old.id],
        );
      await client.query(
        `INSERT INTO zzsh_supply.listing_skin(version_id, skin_id)
         SELECT $1, skin_id FROM (
           SELECT unnest(h.skin_ids) AS skin_id
           FROM zzsh_supply.legacy_skin_holding h
           WHERE h.observation_version_id = $2
           UNION ALL
           SELECT ls.skin_id
           FROM zzsh_supply.listing_skin ls
           WHERE ls.version_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM zzsh_supply.legacy_skin_holding h2
               WHERE h2.observation_version_id = $2
             )
         ) u ON CONFLICT (version_id, skin_id) DO NOTHING`,
        [id, old.id],
      );
      const updated = await client.query(
        `UPDATE zzsh_supply.rental_account
            SET current_version_id=$2,legacy_hold='NONE',revision=revision+1
          WHERE id=$1 AND current_version_id=$3 AND legacy_hold='UNRESOLVED'
        RETURNING id`,
        [accountId, id, old.id],
      );
      if (updated.rowCount !== 1) throw conflict("The account changed during legacy resolution");
      await recordAudit(client, {
        actorType: "admin",
        actorId: actor.id,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        action: "supply.publication.legacy_resolved",
        objectType: "rental_account",
        objectId: accountId,
        outcome: "SUCCESS",
        reason: "已核定来源与目标号主后形成原生草稿；资格与发布仍走现有流程",
        details: {
          before: { currentVersionId: old.id, legacyHold: "UNRESOLVED" },
          after: { currentVersionId: id, legacyHold: "NONE", state: "DRAFT", origin: "NATIVE" },
          sourceSystem: normalized.sourceSystem,
          sourceEntity: normalized.sourceEntity,
          legacyId: normalized.legacyId,
          sourceDigest: normalized.sourceDigest,
          observationVersionId: old.id,
          result: "DRAFT_CREATED",
        },
      });
      return {
        status: 200,
        body: {
          accountId,
          observationVersionId: old.id,
          versionId: id,
          status: "DRAFT" as const,
        },
      };
    },
  );
  return result.body as LegacyDraftResolutionResult;
}

export type LegacySkinHoldingsSourcePackage = {
  schema: "legacy-skin-holdings-source-v1";
  sourceSystem: "legacy_mysql_restore";
  sourceEntity: "la_rental_accounts";
  sourceExtractSha256: string;
  sourceCutoff: string;
  targetBindingsSha256: string;
  tokenRulesVersion: string;
  tokenRulesExtractSha256: string;
  tokenRules: LegacySkinTokenRule[];
  gameId: string;
  catalogRevision: string;
  rows: Array<{
    legacyId: string;
    accountId: string;
    observationVersionId: string;
    sourceDigest: string;
    sourceUpdatedAtUtc: string;
    columns: Record<LegacySkinField, string | null>;
  }>;
};

export type LegacySkinHoldingsAdmission = Readonly<{ packageSha256: string }>;
type SkinSourceState = Omit<LegacySkinHoldingsSourcePackage, "rows"> & {
  tokenRulesDigest: string;
  rows: Map<string, LegacySkinHoldingsSourcePackage["rows"][number]>;
};
const admittedSkinSources = new WeakMap<LegacySkinHoldingsAdmission, SkinSourceState>();
const SKIN_SOURCE_HEX = /^[a-f0-9]{64}$/;
const SKIN_SOURCE_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;

function validateSkinColumns(columns: unknown): asserts columns is Record<LegacySkinField, string | null> {
  if (!recordValue(columns)) throw invalid("All four legacy skin columns are required", "columns");
  if (Object.keys(columns).some(field => !(LEGACY_SKIN_FIELDS as readonly string[]).includes(field)))
    throw invalid("Unexpected legacy skin column in columns", "columns");
  if (LEGACY_SKIN_FIELDS.some(field => !Object.hasOwn(columns, field) || columns[field] === undefined))
    throw invalid("All four legacy skin columns must be observed", "columns");
  if (LEGACY_SKIN_FIELDS.some(field => columns[field] !== null && typeof columns[field] !== "string"))
    throw invalid("Legacy skin columns must be strings or null", "columns");
}

/** Integrity is not approval: only the controlled maintenance loader supplies the independent Root-window SHA, never a request body. */
export function prepareLegacySkinHoldingsAdmission(bytes: string | Buffer, approvedPackageSha256: string): LegacySkinHoldingsAdmission {
  const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (!Buffer.isBuffer(raw) || raw.length > 2 * 1024 * 1024 || !SKIN_SOURCE_HEX.test(approvedPackageSha256))
    throw invalid("An independently admitted skin source package is required");
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw) || sha256Hex(text) !== approvedPackageSha256)
    throw invalid("Admitted skin source package bytes do not match");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid("Admitted skin source package must be JSON"); }
  if (!recordValue(value)) throw invalid("Admitted skin source package must be an object");
  const source = value as unknown as LegacySkinHoldingsSourcePackage;
  if (source.schema !== "legacy-skin-holdings-source-v1" || source.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts"
    || [source.sourceExtractSha256, source.targetBindingsSha256, source.tokenRulesExtractSha256].some(v => typeof v !== "string" || !SKIN_SOURCE_HEX.test(v))
    || typeof source.sourceCutoff !== "string" || !SKIN_SOURCE_UTC.test(source.sourceCutoff) || !Number.isFinite(Date.parse(source.sourceCutoff))
    || typeof source.tokenRulesVersion !== "string" || !source.tokenRulesVersion.trim() || source.tokenRulesVersion.length > 128
    || !Array.isArray(source.tokenRules) || typeof source.catalogRevision !== "string" || !/^[1-9]\d{0,18}$/.test(source.catalogRevision)
    || !Array.isArray(source.rows) || source.rows.length === 0 || source.rows.length > 500)
    throw invalid("Admitted skin source bindings are incomplete");
  if (source.tokenRules.some(rule => !recordValue(rule) || !(LEGACY_SKIN_FIELDS as readonly string[]).includes(rule.field)
    || typeof rule.token !== "string" || !rule.token || !["ALIAS_OF", "INVALID", "HISTORICAL", "PENDING_DECISION", "SOURCE_AMBIGUOUS"].includes(rule.decision)))
    throw invalid("Admitted skin token rules are invalid");
  idText(source.gameId, "gameId");
  const rows = new Map<string, LegacySkinHoldingsSourcePackage["rows"][number]>(), accounts = new Set<string>(), versions = new Set<string>();
  for (const row of source.rows) {
    if (!recordValue(row)) throw invalid("Admitted skin source row is invalid");
    for (const key of ["legacyId", "accountId", "observationVersionId"] as const) idText(row[key], key);
    if (typeof row.sourceDigest !== "string" || !SKIN_SOURCE_HEX.test(row.sourceDigest) || typeof row.sourceUpdatedAtUtc !== "string" || !SKIN_SOURCE_UTC.test(row.sourceUpdatedAtUtc)
      || !Number.isFinite(Date.parse(row.sourceUpdatedAtUtc)) || Date.parse(row.sourceUpdatedAtUtc) > Date.parse(source.sourceCutoff))
      throw invalid("Admitted skin source row digest or cutoff is invalid");
    validateSkinColumns(row.columns);
    if (rows.has(row.legacyId) || accounts.has(row.accountId) || versions.has(row.observationVersionId))
      throw invalid("Admitted skin source targets must be unique");
    rows.set(row.legacyId, row); accounts.add(row.accountId); versions.add(row.observationVersionId);
  }
  const admission = Object.freeze({ packageSha256: approvedPackageSha256 });
  admittedSkinSources.set(admission, { ...source, tokenRulesDigest: sha256Hex(canonicalize(source.tokenRules)), rows });
  return admission;
}

function admittedSkinRow(admission: LegacySkinHoldingsAdmission, legacyId: string) {
  const source = admittedSkinSources.get(admission);
  if (!source) throw invalid("A server-admitted legacy skin source context is required");
  const row = source.rows.get(legacyId);
  if (!row) throw conflict("Legacy skin source row was not admitted");
  const bindingDigest = sha256Hex(canonicalize({ sourceExtractSha256: source.sourceExtractSha256, sourceCutoff: source.sourceCutoff,
    targetBindingsSha256: source.targetBindingsSha256, tokenRulesVersion: source.tokenRulesVersion, tokenRulesExtractSha256: source.tokenRulesExtractSha256,
    tokenRulesDigest: source.tokenRulesDigest, gameId: source.gameId, catalogRevision: source.catalogRevision, row }));
  return { source, row, bindingDigest };
}

/** Root uses the same mapper for the frozen DTO; the writer rechecks the actual catalog and exact map on its transaction client. */
export function prepareLegacySkinHoldingsInput(admission: LegacySkinHoldingsAdmission, legacyId: string, catalog: readonly LegacySkinCatalogEntry[], evidenceRef: string) {
  const { source, row } = admittedSkinRow(admission, legacyId);
  const holding = mapLegacySkinHolding({ accountKey: row.legacyId, gameId: source.gameId, columns: row.columns }, buildLegacySkinIndex(catalog, source.tokenRules), source.catalogRevision);
  const skinIds = declarableLegacySkinIds(holding);
  if (!skinIds) throw invalid("Admitted legacy skin source is not completely declarable");
  return { accountId: row.accountId, input: { observationVersionId: row.observationVersionId, sourceSystem: source.sourceSystem,
    sourceEntity: source.sourceEntity, legacyId: row.legacyId, sourceDigest: row.sourceDigest, holdingDigest: holding.digest,
    skinIds, evidenceRef, columns: { ...row.columns }, catalogRevision: source.catalogRevision } satisfies LegacySkinHoldingsInput };
}

export type LegacySkinHoldingsInput = {
  observationVersionId: string;
  sourceSystem: string;
  sourceEntity: string;
  legacyId: string;
  sourceDigest: string;
  holdingDigest: string;
  skinIds: string[];
  evidenceRef: string;
  columns: Record<LegacySkinField, string | null>;
  catalogRevision?: string;
};

export type LegacySkinHoldingsResult = {
  accountId: string;
  observationVersionId: string;
  attachedSkins: string[];
};

/**
 * Controlled additive seam: attach verified legacy skin holdings to an immutable observation version.
 * Persists to zzsh_supply.legacy_skin_holding, avoiding non-DRAFT listing_skin 40001 constraint.
 * Idempotent, audit-logged, and verified against game scope, exact map, holding digest, and public verified skins.
 */
export async function recordLegacySkinHoldings(
  client: PoolClient,
  accountId: string,
  input: LegacySkinHoldingsInput,
  actor: LegacyImportActor,
  admission: LegacySkinHoldingsAdmission,
): Promise<LegacySkinHoldingsResult> {
  if (!input || typeof input !== "object") throw invalid("Invalid legacy skin holdings input");
  const accountIdText = idText(accountId, "accountId");
  const observationVersionId = idText(input.observationVersionId, "observationVersionId");
  const legacyId = idText(input.legacyId, "legacyId");
  if (input.sourceSystem !== "legacy_mysql_restore" || input.sourceEntity !== "la_rental_accounts")
    throw invalid("Legacy skin source system/entity is not allowed");
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest))
    throw invalid("Source digest is invalid", "sourceDigest");
  if (!/^[a-f0-9]{64}$/.test(input.holdingDigest))
    throw invalid("Holding digest is invalid", "holdingDigest");
  if (typeof input.evidenceRef !== "string" || input.evidenceRef.length === 0 || input.evidenceRef.length > 512)
    throw invalid("Invalid evidence ref", "evidenceRef");
  if (!Array.isArray(input.skinIds))
    throw invalid("skinIds must be an array", "skinIds");
  const skinIds = Array.from(new Set(input.skinIds.map(id => idText(id, "skinIds")))).sort();

  validateSkinColumns(input.columns);

  const allColumnsEmpty = LEGACY_SKIN_FIELDS.every((f) => splitLegacySkinColumn(input.columns[f]).length === 0);
  if (allColumnsEmpty && skinIds.length > 0) {
    throw invalid("Empty skin columns cannot claim positive skin holdings", "skinIds");
  }
  if (!allColumnsEmpty && skinIds.length === 0) {
    throw invalid("Empty skinIds requires proof of four observed empty columns", "skinIds");
  }
  const { source, row: sealedRow, bindingDigest } = admittedSkinRow(admission, legacyId);

  const operation = "supply.legacy.skin_holdings";
  // SK11-A03: skinIds does NOT participate in idempotencyKey so set changes cannot produce disjoint keys.
  const idempotencyKey = sha256Hex(
    JSON.stringify([operation, input.sourceSystem, input.sourceEntity, legacyId, accountIdText, input.sourceDigest]),
  );
  const fingerprint = fingerprintRequest(operation, accountIdText, { ...input, skinIds, sourceAdmissionDigest: bindingDigest });

  let account: PublishingAccount | undefined;
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.id, operation, resourceId: accountIdText },
    idempotencyKey,
    fingerprint,
    async () => {
      account = await lockPublishingAccount(client, accountIdText);
      await authorizeLegacyAdmin(client, actor, account);

      // Verify immutable observation version
      const versionRow = (
        await client.query<{ id: string; origin: string; review_state: string }>(
          `SELECT id, origin, review_state FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,
          [observationVersionId, accountIdText],
        )
      ).rows[0];
      if (!versionRow) throw notFound();
      if (versionRow.origin !== "LEGACY_OBSERVATION" || versionRow.review_state !== "IMPORTED_UNVERIFIED") {
        throw invalid("Observation version must be an IMPORTED_UNVERIFIED legacy observation", "observationVersionId");
      }

      // SK11-A02: Strict legacy_supply_map binding
      const mapRow = (
        await client.query<{ source_digest: string; version_id: string; account_id: string }>(
          `SELECT source_digest, version_id, account_id FROM zzsh_supply.legacy_supply_map WHERE source_system=$1 AND source_entity=$2 AND legacy_id=$3`,
          [input.sourceSystem, input.sourceEntity, legacyId],
        )
      ).rows[0];
      if (!mapRow) {
        throw conflict("Legacy supply map not found for source tuple");
      }
      if (mapRow.account_id !== accountIdText) {
        throw conflict("Legacy supply map account does not match target account");
      }
      if (mapRow.version_id !== observationVersionId) {
        throw conflict("Legacy supply map observation version does not match target version");
      }
      if (mapRow.source_digest !== input.sourceDigest) {
        throw conflict("Legacy source digest conflicts with recorded observation");
      }
      if (sealedRow.accountId !== accountIdText || sealedRow.observationVersionId !== observationVersionId || sealedRow.sourceDigest !== input.sourceDigest || source.gameId !== account!.game_id)
        throw conflict("Legacy skin source target does not match the admitted map and version");

      // Check existing persistent holding in zzsh_supply.legacy_skin_holding
      const existing = (
        await client.query<{ holding_digest: string; skin_ids: string[]; source_digest: string; observation_version_id: string }>(
          `SELECT holding_digest, skin_ids, source_digest, observation_version_id FROM zzsh_supply.legacy_skin_holding WHERE account_id=$1`,
          [accountIdText],
        )
      ).rows[0];
      if (existing) {
        const existingSet = new Set(existing.skin_ids);
        const newSet = new Set(skinIds);
        const setsEqual = existingSet.size === newSet.size && skinIds.every((s) => existingSet.has(s));
        if (
          existing.holding_digest === input.holdingDigest &&
          existing.source_digest === input.sourceDigest &&
          existing.observation_version_id === observationVersionId &&
          setsEqual
        ) {
          // Replay of identical holding
          return false;
        }
        // SK11-A03: Different set conflicts!
        throw conflict("Legacy skin holdings conflict with recorded holding for this account");
      }

      return false;
    },
    async () => {
      const a = account!;
      if (canonicalize(input.columns) !== canonicalize(sealedRow.columns))
        throw conflict("Legacy skin source columns conflict with the admitted sealed row");
      if (input.catalogRevision !== undefined && input.catalogRevision !== source.catalogRevision)
        throw conflict("Legacy skin catalog revision does not match its admitted source context");

      // Verify catalog mapping against observed columns and declared skinIds
      const gameRevisionRow = (
        await client.query<{ catalogRevision: string }>(
          `SELECT catalog_revision::text AS "catalogRevision" FROM zzsh_supply.game WHERE id=$1`,
          [a.game_id],
        )
      ).rows[0];
      const catalogRevision = gameRevisionRow?.catalogRevision;
      if (!catalogRevision || catalogRevision !== source.catalogRevision)
        throw conflict("Legacy skin catalog changed after source admission");

      const catalogRows = (
        await client.query<{
          id: string;
          gameId: string;
          sourceField: string | null;
          sourceToken: string | null;
          namingState: "LEGACY" | "PENDING" | "VERIFIED";
          enabled: boolean;
          formVisible: boolean;
        }>(
          `SELECT id, game_id AS "gameId", source_field AS "sourceField", source_token AS "sourceToken",
                  naming_state AS "namingState", enabled, form_visible AS "formVisible"
             FROM zzsh_supply.skin
            WHERE game_id=$1`,
          [a.game_id],
        )
      ).rows;

      const catalogEntries: LegacySkinCatalogEntry[] = catalogRows.map((r) => ({
        skinId: r.id,
        gameId: r.gameId,
        sourceField: r.sourceField,
        sourceToken: r.sourceToken,
        namingState: r.namingState,
        enabled: Boolean(r.enabled),
        formVisible: Boolean(r.formVisible),
      }));

      const skinIndex = buildLegacySkinIndex(catalogEntries, source.tokenRules);
      const holding = mapLegacySkinHolding(
        { accountKey: legacyId, gameId: a.game_id, columns: sealedRow.columns },
        skinIndex,
        catalogRevision,
      );

      if (!holding.complete) {
        throw invalid("Legacy skin holding source has unmapped, pending, or ambiguous skins", "columns");
      }
      const declarable = declarableLegacySkinIds(holding);
      if (
        !declarable ||
        declarable.length !== skinIds.length ||
        !skinIds.every((id) => declarable.includes(id))
      ) {
        throw invalid("Declared skinIds do not match mapped declarable skins from observed columns", "skinIds");
      }
      if (holding.digest !== input.holdingDigest) {
        throw conflict("Holding digest does not match computed digest from observed columns");
      }

      const existing = (
        await client.query<{ skin_ids: string[] }>(
          `SELECT skin_ids FROM zzsh_supply.legacy_skin_holding WHERE account_id=$1`,
          [accountIdText],
        )
      ).rows[0];
      if (existing) {
        return {
          status: 200,
          body: {
            accountId: accountIdText,
            observationVersionId,
            attachedSkins: existing.skin_ids,
          },
        };
      }

      // SK11-A01 & SK11-C01: Insert into zzsh_supply.legacy_skin_holding with exact 10 columns
      await client.query(
        `INSERT INTO zzsh_supply.legacy_skin_holding(
           account_id, observation_version_id, source_system, source_entity, legacy_id,
           source_digest, holding_digest, skin_ids, evidence_ref, created_by_admin_id
         ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          accountIdText,
          observationVersionId,
          input.sourceSystem,
          input.sourceEntity,
          legacyId,
          input.sourceDigest,
          input.holdingDigest,
          skinIds,
          input.evidenceRef,
          actor.id,
        ],
      );

      await recordAudit(client, {
        actorType: "admin",
        actorId: actor.id,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        action: "supply.legacy.skin_holdings_recorded",
        objectType: "rental_account",
        objectId: accountIdText,
        outcome: "SUCCESS",
        reason: "旧站账号已核实皮肤持有记录保存；关联至历史观察版本与独立持有事实表",
        details: {
          sourceSystem: input.sourceSystem,
          sourceEntity: input.sourceEntity,
          legacyId,
          sourceDigest: input.sourceDigest,
          holdingDigest: input.holdingDigest,
          observationVersionId,
          attachedSkins: skinIds,
          evidenceRef: input.evidenceRef,
          sourceAdmission: { packageSha256: admission.packageSha256, bindingDigest, sourceExtractSha256: source.sourceExtractSha256,
            sourceCutoff: source.sourceCutoff, sourceUpdatedAtUtc: sealedRow.sourceUpdatedAtUtc, targetBindingsSha256: source.targetBindingsSha256,
            tokenRulesVersion: source.tokenRulesVersion, tokenRulesExtractSha256: source.tokenRulesExtractSha256,
            tokenRulesDigest: source.tokenRulesDigest, catalogRevision },
          result: "SKIN_HOLDINGS_RECORDED",
        },
      });

      return {
        status: 200,
        body: {
          accountId: accountIdText,
          observationVersionId,
          attachedSkins: skinIds,
        },
      };
    },
  );
  return result.body as LegacySkinHoldingsResult;
}


