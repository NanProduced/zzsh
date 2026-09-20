import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { assertGameScope, conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "./supply-util";
import { computeDeltaQuote, projectDeltaQuote, type HaffRatioRule, type PricingLineInput, type QuoteResult } from "./pricing";
import { DELTA_ROUNDING_POLICY, normalizeRentalPricing, parseDeltaPriceLines, validateDeltaHaffRule, type DeltaHaffRule, type DeltaPriceLineInputBody } from "./delta-rental";
import { computeContentHash, humanText, normalizeContentPayload, normalizeTime, withoutContentHash, type ContentDeclaration, type ContentPayloadInput } from "./content-hash";

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

export type HaffRuleInput = DeltaHaffRule;
export type PriceLineInputBody = DeltaPriceLineInputBody;
export const validateHaffRule = validateDeltaHaffRule;
export const parsePriceLines = parseDeltaPriceLines;

type VersionRow = Record<string, unknown>;

export async function listRules(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
): Promise<Record<string, unknown>> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const game = await client.query(
    `SELECT "id", "code", "name", "catalog_revision"::text AS "catalogRevision", "current_release_id" AS "currentReleaseId"
       FROM "zzsh_supply"."game" WHERE "id" = $1`,
    [gameId],
  );
  if (game.rows.length === 0) throw notFound();
  const release = await client.query(
    `SELECT r."id", r."game_id" AS "gameId", r."price_version_id" AS "priceVersionId", r."term_version_id" AS "termVersionId",
            r."agreement_version_id" AS "agreementVersionId", r."generation"::text AS "generation",
            r."activated_by_admin_id" AS "activatedByAdminId", r."activated_at" AS "activatedAt"
       FROM "zzsh_supply"."rule_release" r
      WHERE r."game_id" = $1 ORDER BY r."generation" DESC LIMIT 1`,
    [gameId],
  );
  const priceVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."mode", v."status", v."commission_rate"::text AS "commissionRate",
            v."haff_rule" AS "haffRule", v."rounding_policy" AS "roundingPolicy", v."compensation_policy_ref" AS "compensationPolicyRef",
            v."revision"::text AS "revision", v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt"
       FROM "zzsh_supply"."price_version" v
      WHERE v."game_id" = $1 ORDER BY v."created_at" DESC LIMIT 20`,
    [gameId],
  );
  const priceLines = await client.query(
    `SELECT l."price_version_id" AS "priceVersionId", l.customer_tier AS "customerTier", l."item_id" AS "itemId", l."pricing_kind" AS "pricingKind",
            l."unit_quantity"::text AS "unitQuantity", l."buyer_unit_amount"::text AS "buyerUnitAmount", l."owner_unit_amount"::text AS "ownerUnitAmount"
       FROM "zzsh_supply"."price_line" l
       JOIN "zzsh_supply"."price_version" v ON v."id" = l."price_version_id"
      WHERE v."game_id" = $1 ORDER BY l."item_id"`,
    [gameId],
  );
  const termVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."status", v."revision"::text AS "revision", v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt"
       FROM "zzsh_supply"."term_version" v WHERE v."game_id" = $1 ORDER BY v."created_at" DESC LIMIT 20`,
    [gameId],
  );
  const termOptions = await client.query(
    `SELECT o."version_id" AS "versionId", o."code", o."name", o."daily_consumption"::text AS "dailyConsumption", o."duration_rounding" AS "durationRounding"
       FROM "zzsh_supply"."term_option" o
       JOIN "zzsh_supply"."term_version" v ON v."id" = o."version_id"
      WHERE v."game_id" = $1 ORDER BY o."code"`,
    [gameId],
  );
  const agreementVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."title", v."body", v."digest", v."status", v."revision"::text AS "revision",
            v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt"
       FROM "zzsh_supply"."agreement_version" v WHERE v."game_id" = $1 ORDER BY v."created_at" DESC LIMIT 20`,
    [gameId],
  );
  const items = await client.query(
    `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "enabled", "sort_order" AS "sortOrder"
       FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );
  return {
    game: game.rows[0],
    release: release.rows[0] ?? null,
    priceVersions: priceVersions.rows,
    priceLines: priceLines.rows,
    termVersions: termVersions.rows,
    termOptions: termOptions.rows,
    agreementVersions: agreementVersions.rows,
    items: items.rows,
  };
}

async function lockDraftishVersion(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  table: "price_version" | "term_version" | "agreement_version",
  versionId: string,
): Promise<VersionRow> {
  const result = await client.query<VersionRow>(`SELECT * FROM "zzsh_supply"."${table}" WHERE "id" = $1 FOR UPDATE`, [versionId]);
  const row = result.rows[0];
  if (!row) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, String(row.game_id));
  return row;
}

function checkRevision(row: VersionRow, expectedRevision: unknown): void {
  if (typeof expectedRevision !== "string" || row.revision !== expectedRevision) throw conflict("Version changed; refresh and retry");
}

export async function createPriceDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  mode: unknown,
): Promise<{ id: string }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (mode !== "SPREAD" && mode !== "PERCENT") throw invalid("Mode is invalid");
  const id = newSupplyId("price");
  await client.query(
    `INSERT INTO "zzsh_supply"."price_version" ("id", "game_id", "mode", "created_by_admin_id")
     VALUES ($1, $2, $3, $4)`,
    [id, gameId, mode, adminUserId],
  );
  return { id };
}

export async function updatePriceDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "price_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed price versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  const mode = body.mode === undefined ? (current.mode as "SPREAD" | "PERCENT") : body.mode;
  if (mode !== "SPREAD" && mode !== "PERCENT") throw invalid("Mode is invalid");
  let commissionRate: string | null | undefined;
  if (body.commissionRate !== undefined) {
    if (mode !== "PERCENT") throw invalid("Commission rate is only valid for PERCENT mode");
    if (typeof body.commissionRate !== "string" || !DECIMAL_PATTERN.test(body.commissionRate)) throw invalid("Commission rate is invalid");
    const numeric = Number(body.commissionRate);
    if (!(numeric >= 0 && numeric < 1)) throw invalid("Commission rate is invalid");
    commissionRate = body.commissionRate;
  } else if (mode === "SPREAD") {
    commissionRate = null;
  }
  let haffRule: HaffRuleInput | null | undefined;
  if (body.haffRule !== undefined) {
    haffRule = body.haffRule === null ? null : validateDeltaHaffRule(body.haffRule, mode);
  }
  const lines = body.lines === undefined ? undefined : parseDeltaPriceLines(body.lines, mode);
  // Check both stored and requested schemas: an old editor must not erase tiers,
  // including when it also attempts to replace or clear the compatibility rule.
  if (lines && ((current.haff_rule as HaffRuleInput | null)?.schema === "haff-ratio-v2" || haffRule?.schema === "haff-ratio-v2")
    && lines.some((line) => line.customerTier === undefined)) {
    throw invalid("Compatibility price lines require an explicit customerTier", "lines");
  }
  const roundingPolicy = body.roundingPolicy === undefined ? undefined : body.roundingPolicy;
  if (roundingPolicy !== undefined && roundingPolicy !== DELTA_ROUNDING_POLICY) throw invalid("Rounding policy is unsupported");
  await client.query(
    `UPDATE "zzsh_supply"."price_version"
        SET "mode" = $1,
            "commission_rate" = CASE WHEN $2::boolean THEN $3::numeric ELSE "commission_rate" END,
            "haff_rule" = CASE WHEN $4::boolean THEN $5::jsonb ELSE "haff_rule" END,
            "rounding_policy" = COALESCE($6, "rounding_policy"),
            "revision" = "revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $7`,
    [
      mode,
      commissionRate !== undefined,
      commissionRate ?? null,
      haffRule !== undefined,
      haffRule === null || haffRule === undefined ? null : JSON.stringify(haffRule),
      roundingPolicy ?? null,
      versionId,
    ],
  );
  if (lines !== undefined) {
    const items = await client.query<{ id: string; unit: string; gameId: string }>(
      `SELECT "id", "unit", "game_id" AS "gameId" FROM "zzsh_supply"."billable_item" WHERE "id" = ANY($1::text[])`,
      [lines.map((line) => line.itemId)],
    );
    const itemById = new Map(items.rows.map((item) => [item.id, item]));
    if (itemById.size !== new Set(lines.map((line) => line.itemId)).size) throw invalid("Price line item does not exist");
    for (const line of lines) {
      const item = itemById.get(line.itemId)!;
      if (item.gameId !== String(current.game_id)) throw invalid("Price line item belongs to another game");
      if ((item.unit === "HAFF_BASE") !== (line.pricingKind === "HAFF_RATIO")) throw invalid("Haff items must use the haff ratio pricing kind");
    }
    await client.query(`DELETE FROM "zzsh_supply"."price_line" WHERE "price_version_id" = $1`, [versionId]);
    for (const line of lines) {
      await client.query(
        `INSERT INTO "zzsh_supply"."price_line" ("id", "price_version_id", "item_id", "pricing_kind", "unit_quantity", "buyer_unit_amount", "owner_unit_amount", customer_tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newSupplyId("pline"), versionId, line.itemId, line.pricingKind, line.unitQuantity ?? null, line.buyerUnitAmount ?? null, line.ownerUnitAmount ?? null, line.customerTier ?? "STANDARD"],
      );
    }
  }
}

export async function sealVersion(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  table: "price_version" | "term_version" | "agreement_version",
  versionId: string,
  expectedRevision: unknown,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, table, versionId);
  if (current.status !== "DRAFT") throw conflict("Version is already sealed");
  if (typeof expectedRevision !== "string" || current.revision !== expectedRevision) throw conflict("Version changed; refresh and retry");
  await client.query(
    `UPDATE "zzsh_supply"."${table}"
        SET "status" = 'SEALED', "sealed_at" = clock_timestamp(), "sealed_by_admin_id" = $1,
            "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $2`,
    [adminUserId, versionId],
  );
}

export async function createTermDraft(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string): Promise<{ id: string }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const id = newSupplyId("term");
  await client.query(`INSERT INTO "zzsh_supply"."term_version" ("id", "game_id", "created_by_admin_id") VALUES ($1, $2, $3)`, [id, gameId, adminUserId]);
  return { id };
}

export function parseTermOptions(value: unknown): Array<{ code: string; name: string; dailyConsumption: string; durationRounding: "CEIL_DAY" }> {
  if (!Array.isArray(value) || value.length === 0) throw invalid("Term options are required");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Term option is invalid");
    const option = entry as Record<string, unknown>;
    const code = option.code;
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw invalid("Term option code is invalid");
    if (seen.has(code)) throw invalid("Term option codes must be unique");
    seen.add(code);
    if (typeof option.name !== "string" || option.name.length === 0 || option.name.length > 120) throw invalid("Term option name is invalid");
    if (typeof option.dailyConsumption !== "string" || !/^[1-9]\d{0,23}$/.test(option.dailyConsumption)) throw invalid("Daily consumption is invalid");
    if (option.durationRounding !== undefined && option.durationRounding !== "CEIL_DAY") throw invalid("Duration rounding is unsupported");
    return { code, name: option.name, dailyConsumption: option.dailyConsumption, durationRounding: "CEIL_DAY" as const };
  });
}

export async function updateTermDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "term_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed term versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  const options = parseTermOptions(body.options);
  await client.query(`DELETE FROM "zzsh_supply"."term_option" WHERE "version_id" = $1`, [versionId]);
  for (const option of options) {
    await client.query(
      `INSERT INTO "zzsh_supply"."term_option" ("id", "version_id", "code", "name", "daily_consumption", "duration_rounding")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newSupplyId("termopt"), versionId, option.code, option.name, option.dailyConsumption, option.durationRounding],
    );
  }
  await client.query(`UPDATE "zzsh_supply"."term_version" SET "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [versionId]);
}

export async function createAgreementDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  title: string,
  body: string,
): Promise<{ id: string }> {
  title = humanText(title);
  body = humanText(body);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (title.length === 0 || title.length > 120) throw invalid("Title is invalid");
  if (body.trim().length === 0 || Buffer.byteLength(body, "utf8") > 20_000) throw invalid("Agreement body is invalid");
  const id = newSupplyId("agreement");
  await client.query(
    `INSERT INTO "zzsh_supply"."agreement_version" ("id", "game_id", "title", "body", "digest", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, gameId, title, body, createHash("sha256").update(body, "utf8").digest("hex"), adminUserId],
  );
  return { id };
}

export async function updateAgreementDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "agreement_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed agreement versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  const title = body.title === undefined ? undefined : humanText(body.title as string);
  const agreementBody = body.body === undefined ? undefined : humanText(body.body as string);
  if (title === undefined && agreementBody === undefined) throw invalid();
  if (title !== undefined && (typeof title !== "string" || title.length === 0 || title.length > 120)) throw invalid("Title is invalid");
  if (agreementBody !== undefined && (typeof agreementBody !== "string" || agreementBody.trim().length === 0 || Buffer.byteLength(agreementBody, "utf8") > 20_000)) {
    throw invalid("Agreement body is invalid");
  }
  const digest = agreementBody === undefined ? undefined : createHash("sha256").update(agreementBody, "utf8").digest("hex");
  await client.query(
    `UPDATE "zzsh_supply"."agreement_version"
        SET "title" = COALESCE($1, "title"),
            "body" = COALESCE($2, "body"),
            "digest" = COALESCE($3, "digest"),
            "revision" = "revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $4`,
    [title ?? null, agreementBody ?? null, digest ?? null, versionId],
  );
}

export type ActivationResult = { releaseId: string; generation: string; affectedCount: number };

export async function activateRelease(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  priceVersionId: string,
  termVersionId: string,
  agreementVersionId: string,
  expectedGeneration: string,
): Promise<ActivationResult> {
  if (!/^(0|[1-9]\d*)$/.test(expectedGeneration)) throw invalid("Expected generation is required");
  if (!isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only a boss can activate a rule release");
  const game = await client.query(`SELECT "id" FROM "zzsh_supply"."game" WHERE "id" = $1 FOR UPDATE`, [gameId]);
  if (game.rows.length === 0) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const versions = await client.query<{ id: string; status: string; gameId: string }>(
    `SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."price_version" WHERE "id" = $1
     UNION ALL SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."term_version" WHERE "id" = $2
     UNION ALL SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."agreement_version" WHERE "id" = $3`,
    [priceVersionId, termVersionId, agreementVersionId],
  );
  if (versions.rows.length !== 3) throw invalid("Rule versions do not exist");
  for (const row of versions.rows) {
    if (row.gameId !== gameId) throw invalid("Rule versions must belong to this game");
    if (row.status !== "SEALED") throw conflict("Rule versions must be sealed before activation");
  }
  const nextGeneration = await client.query<{ generation: string }>(
    `SELECT (COALESCE(MAX("generation"), 0) + 1)::text AS "generation" FROM "zzsh_supply"."rule_release" WHERE "game_id" = $1`,
    [gameId],
  );
  const generation = nextGeneration.rows[0]!.generation;
  if (BigInt(generation) - 1n !== BigInt(expectedGeneration)) throw conflict("Rule release changed; reload before confirming activation");
  const releaseId = newSupplyId("release");
  await client.query(
    `INSERT INTO "zzsh_supply"."rule_release" ("id", "game_id", "price_version_id", "term_version_id", "agreement_version_id", "generation", "activated_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [releaseId, gameId, priceVersionId, termVersionId, agreementVersionId, generation, adminUserId],
  );
  await client.query(`UPDATE "zzsh_supply"."game" SET "current_release_id" = $1, "updated_at" = clock_timestamp() WHERE "id" = $2`, [releaseId, gameId]);
  const affected = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "zzsh_supply"."rental_account" a
      WHERE a."game_id" = $1 AND a."lifecycle" = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."rule_acceptance" r WHERE r."account_id" = a."id" AND r."rule_release_id" = $2)`,
    [gameId, releaseId],
  );
  return { releaseId, generation, affectedCount: Number(affected.rows[0]?.count ?? "0") };
}

export async function quotePreview(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  body: Record<string, unknown>,
): Promise<{ gameId: string; quotable: boolean; quote?: unknown; contentPayload?: ContentPayloadInput; contentHash?: string; reasonCodes?: string[] }> {
  ensureOnlyFields(body, ["priceVersionId", "termVersionId", "accountId", "conditions", "inventory", "entitlements", "deposits", "title", "description", "skins", "mediaBindings", "releaseId", "agreementVersionId", "agreementDigest"]);
  const priceVersionId = String(body.priceVersionId ?? "");
  const termVersionId = String(body.termVersionId ?? "");
  const price = await client.query<{
    id: string;
    gameId: string;
    mode: "SPREAD" | "PERCENT";
    status: string;
    commissionRate: string | null;
    haffRule: unknown;
    roundingPolicy: string;
  }>(
    `SELECT "id", "game_id" AS "gameId", "mode", "status", "commission_rate"::text AS "commissionRate",
            "haff_rule" AS "haffRule", "rounding_policy" AS "roundingPolicy"
       FROM "zzsh_supply"."price_version" WHERE "id" = $1`,
    [priceVersionId],
  );
  const priceRow = price.rows[0];
  if (!priceRow) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, priceRow.gameId);
  const term = await client.query<{ id: string; gameId: string; status: string }>(
    `SELECT "id", "game_id" AS "gameId", "status" FROM "zzsh_supply"."term_version" WHERE "id" = $1`,
    [termVersionId],
  );
  const termRow = term.rows[0];
  if (!termRow || termRow.gameId !== priceRow.gameId) throw invalid("Term version does not belong to this game");

  const conditions = body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)
    ? (body.conditions as Record<string, unknown>)
    : {};
  ensureOnlyFields(conditions, ["safeBoxCode", "vitLevel", "bearLevel", "termOptionCode", "pricingOptionCode", "rentalPricing"]);
  const termOptionCode = typeof conditions.termOptionCode === "string" ? conditions.termOptionCode : "";
  const termOptionRow = await client.query<{ code: string; dailyConsumption: string; durationRounding: "CEIL_DAY" }>(
    `SELECT "code", "daily_consumption"::text AS "dailyConsumption", "duration_rounding" AS "durationRounding"
       FROM "zzsh_supply"."term_option" WHERE "version_id" = $1 AND "code" = $2`,
    [termVersionId, termOptionCode],
  );
  const termOption = termOptionRow.rows[0];
  if (!termOption) throw invalid("Term option is not defined in the selected term version");

  const inventory = Array.isArray(body.inventory) ? body.inventory : [];
  const inventoryById = new Map<string, string>();
  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Inventory is invalid");
    const item = entry as Record<string, unknown>;
    ensureOnlyFields(item, ["itemId", "quantity"]);
    if (typeof item.itemId !== "string" || typeof item.quantity !== "string" || !/^(0|[1-9]\d{0,23})$/.test(item.quantity)) throw invalid("Inventory is invalid");
    if (inventoryById.has(item.itemId)) throw invalid("Inventory must not repeat an item");
    inventoryById.set(item.itemId, item.quantity);
  }

  const lineRows = await client.query<{
    itemId: string;
    unit: string;
    pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
    unitQuantity: string | null;
    buyerUnitAmount: string | null;
    ownerUnitAmount: string | null;
  }>(
    `SELECT l."item_id" AS "itemId", i."unit", l."pricing_kind" AS "pricingKind", l."unit_quantity"::text AS "unitQuantity",
            l."buyer_unit_amount"::text AS "buyerUnitAmount", l."owner_unit_amount"::text AS "ownerUnitAmount"
       FROM "zzsh_supply"."price_line" l JOIN "zzsh_supply"."billable_item" i ON i."id" = l."item_id"
      WHERE l."price_version_id" = $1 AND l.customer_tier='STANDARD' ORDER BY l."item_id"`,
    [priceVersionId],
  );
  const lines: PricingLineInput[] = [];
  for (const row of lineRows.rows) {
    const quantity = inventoryById.get(row.itemId);
    if (quantity === undefined) continue;
    lines.push({
      customerTier: "STANDARD",
      itemId: row.itemId,
      quantity,
      pricingKind: row.pricingKind,
      unit: row.unit as PricingLineInput["unit"],
      ...(row.unitQuantity !== null ? { unitQuantity: row.unitQuantity } : {}),
      ...(row.buyerUnitAmount !== null ? { buyerUnitAmount: row.buyerUnitAmount } : {}),
      ...(row.ownerUnitAmount !== null ? { ownerUnitAmount: row.ownerUnitAmount } : {}),
    });
  }
  if (lines.length === 0) throw invalid("No declared inventory matches the selected price version");

  const entitlementInputs: Array<{ entitlementId: string; expiryKind: "PERMANENT" | "TIMED"; expiresAt?: string }> = [];
  if (Array.isArray(body.entitlements)) {
    for (const entry of body.entitlements) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Entitlements are invalid");
      const entitlement = entry as Record<string, unknown>;
      ensureOnlyFields(entitlement, ["entitlementId", "expiresAt"]);
      if (typeof entitlement.entitlementId !== "string") throw invalid("Entitlements are invalid");
      const known = await client.query<{ expiryKind: "PERMANENT" | "TIMED"; gameId: string }>(
        `SELECT "expiry_kind" AS "expiryKind", "game_id" AS "gameId" FROM "zzsh_supply"."entitlement" WHERE "id" = $1`,
        [entitlement.entitlementId],
      );
      const row = known.rows[0];
      if (!row || row.gameId !== priceRow.gameId) throw invalid("Entitlement does not belong to this game");
      const expiresAt = typeof entitlement.expiresAt === "string" ? normalizeTime(entitlement.expiresAt) : null;
      entitlementInputs.push({
        entitlementId: entitlement.entitlementId,
        expiryKind: row.expiryKind,
        ...(typeof expiresAt === "string" ? { expiresAt } : {}),
      });
    }
  }

  const deposits = body.deposits && typeof body.deposits === "object" && !Array.isArray(body.deposits)
    ? (body.deposits as { tenantDepositCents?: unknown; publisherBailRequirementCents?: unknown })
    : undefined;
  if (deposits) ensureOnlyFields(deposits, ["tenantDepositCents", "publisherBailRequirementCents"]);
  if (body.skins !== undefined && (!Array.isArray(body.skins) || body.skins.some((id) => typeof id !== "string"))) throw invalid("Skins must be an array of IDs");
  if (body.mediaBindings !== undefined) {
    if (!Array.isArray(body.mediaBindings)) throw invalid("Media bindings must be an array");
    for (const entry of body.mediaBindings) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Invalid media binding");
      ensureOnlyFields(entry, ["assetId", "byteHash", "purpose", "position"]);
    }
  }

  const result: QuoteResult = computeDeltaQuote({
    customerTier: "STANDARD",
    priceVersionId,
    mode: priceRow.mode,
    roundingPolicy: priceRow.roundingPolicy,
    ...(priceRow.commissionRate !== null ? { commissionRate: priceRow.commissionRate } : {}),
    ...(priceRow.haffRule ? { haffRule: priceRow.haffRule as HaffRatioRule } : {}),
    lines,
    conditions: {
      ...(conditions.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(conditions.rentalPricing) }),
      ...(typeof conditions.safeBoxCode === "string" ? { safeBoxCode: conditions.safeBoxCode } : {}),
      ...(typeof conditions.vitLevel === "number" ? { vitLevel: conditions.vitLevel } : {}),
      ...(typeof conditions.bearLevel === "number" ? { bearLevel: conditions.bearLevel } : {}),
      ...(termOptionCode ? { termOptionCode } : {}),
      ...(typeof conditions.pricingOptionCode === "string" ? { pricingOptionCode: conditions.pricingOptionCode } : {}),
    },
    termOption,
    entitlements: entitlementInputs,
    ...(deposits
      ? {
          deposits: {
            ...(typeof deposits.tenantDepositCents === "string" ? { tenantDepositCents: deposits.tenantDepositCents } : {}),
            ...(typeof deposits.publisherBailRequirementCents === "string" ? { publisherBailRequirementCents: deposits.publisherBailRequirementCents } : {}),
          },
        }
      : {}),
  });

  if (!result.quotable) return { gameId: priceRow.gameId, quotable: false, reasonCodes: result.reasonCodes };

  let contentHash: string | undefined;
  let contentPayload: ContentPayloadInput | undefined;
  if (typeof body.accountId === "string" && body.accountId.length > 0) {
    const declaration: ContentDeclaration = {
      title: typeof body.title === "string" ? body.title : "",
      description: typeof body.description === "string" ? body.description : null,
      attributes: conditions.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(conditions.rentalPricing) },
      inventory: [...inventoryById.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
      skins: Array.isArray(body.skins) ? body.skins.filter((value): value is string => typeof value === "string") : [],
      entitlements: entitlementInputs.map((entitlement) => ({
        entitlementId: entitlement.entitlementId,
        value: null,
        expiresAt: entitlement.expiresAt ?? null,
        expiryKnowledge: entitlement.expiresAt ? "KNOWN" : "UNKNOWN",
      })),
      termOptionCode,
      pricingOptionCode: typeof conditions.pricingOptionCode === "string" ? conditions.pricingOptionCode : "",
      mediaBindings: Array.isArray(body.mediaBindings)
        ? body.mediaBindings
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
              assetId: String(entry.assetId ?? ""),
              byteHash: String(entry.byteHash ?? ""),
              purpose: String(entry.purpose ?? ""),
              position: typeof entry.position === "number" ? entry.position : 0,
            }))
        : [],
    };
    const payload: ContentPayloadInput = {
      schemaVersion: result.quote.schemaVersion,
      accountId: body.accountId,
      gameId: priceRow.gameId,
      declaration,
      ruleRefs: {
        releaseId: typeof body.releaseId === "string" ? body.releaseId : "",
        priceVersionId,
        termVersionId,
        agreementVersionId: typeof body.agreementVersionId === "string" ? body.agreementVersionId : "",
        agreementDigest: typeof body.agreementDigest === "string" ? body.agreementDigest : "",
      },
      quoteValues: withoutContentHash(result.quote) as unknown as Record<string, unknown>,
    };
    contentPayload = normalizeContentPayload(payload);
    contentHash = computeContentHash(contentPayload);
  }

  const projected = projectDeltaQuote({ ...result.quote, ...(contentHash ? { contentHash } : {}) }, "admin");
  return { gameId: priceRow.gameId, quotable: true, quote: projected, ...(contentPayload ? { contentPayload } : {}), ...(contentHash ? { contentHash } : {}) };
}
