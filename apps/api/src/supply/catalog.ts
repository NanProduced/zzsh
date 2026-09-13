import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "../auth/security-core";
import {
  assertGameExists,
  assertGameScope,
  bumpCatalogRevision,
  conflict,
  invalid,
  newSupplyId,
  notFound,
  optionalBoolean,
  optionalInteger,
  optionalNullableString,
  optionalString,
  optionalTrimmedString,
  requiredString,
} from "./supply-util";

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;
const UNITS = new Set(["HAFF_BASE", "ROUND", "PIECE"]);

function requireCode(body: Record<string, unknown>, field = "code"): string {
  const value = requiredString(body, field, 64);
  if (!CODE_PATTERN.test(value)) throw invalid("Stable code is invalid");
  return value;
}

type GameRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  catalogRevision: string;
  currentReleaseId: string | null;
  coverMediaId: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listGames(client: PoolClient, adminUserId: string, isBoss: boolean): Promise<{ games: GameRow[] }> {
  const scoped = isBoss
    ? ""
    : ` AND EXISTS (SELECT 1 FROM "zzsh_supply"."admin_supply_scope" s WHERE s."game_id" = g."id" AND s."admin_user_id" = $1)`;
  const result = await client.query<GameRow>(
    `SELECT g."id", g."code", g."name", g."description", g."enabled",
            g."catalog_revision"::text AS "catalogRevision", g."current_release_id" AS "currentReleaseId",
            g."cover_media_id" AS "coverMediaId", g."created_at" AS "createdAt", g."updated_at" AS "updatedAt"
       FROM "zzsh_supply"."game" g
      WHERE true${scoped}
      ORDER BY g."code"`,
    isBoss ? [] : [adminUserId],
  );
  return { games: result.rows };
}

export async function createGame(
  client: PoolClient,
  isBoss: boolean,
  body: Record<string, unknown>,
): Promise<GameRow> {
  if (!isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only a boss can create a game");
  const code = requireCode(body);
  const name = requiredString(body, "name", 120);
  const description = optionalTrimmedString(body, "description", 1000) ?? null;
  const existing = await client.query(`SELECT 1 FROM "zzsh_supply"."game" WHERE "code" = $1`, [code]);
  if (existing.rows.length > 0) throw conflict("Game code already exists");
  const id = newSupplyId("game");
  const result = await client.query<GameRow>(
    `INSERT INTO "zzsh_supply"."game" ("id", "code", "name", "description")
     VALUES ($1, $2, $3, $4)
     RETURNING "id", "code", "name", "description", "enabled",
       "catalog_revision"::text AS "catalogRevision", "current_release_id" AS "currentReleaseId",
       "cover_media_id" AS "coverMediaId", "created_at" AS "createdAt", "updated_at" AS "updatedAt"`,
    [id, code, name, description],
  );
  return result.rows[0]!;
}

export async function updateGame(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "string" || !/^[1-9]\d*$/.test(expectedRevision)) throw invalid();
  const name = optionalString(body, "name", 120);
  const description = optionalNullableString(body, "description", 1000);
  const enabled = optionalBoolean(body, "enabled");
  if (name === undefined && description === undefined && enabled === undefined) throw invalid();
  const result = await client.query(
    `UPDATE "zzsh_supply"."game"
        SET "name" = COALESCE($1, "name"),
            "description" = CASE WHEN $2::boolean THEN $3::text ELSE "description" END,
            "enabled" = COALESCE($4, "enabled"),
            "catalog_revision" = "catalog_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $5 AND "catalog_revision"::text = $6`,
    [name ?? null, description !== undefined, description ?? null, enabled ?? null, gameId, expectedRevision],
  );
  if (result.rowCount !== 1) throw conflict("Catalog changed; refresh and retry");
}

type CatalogRow = { id: string };

export async function createCatalogEntry(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  kind: "items" | "rarities" | "categories" | "skins" | "entitlements",
  gameId: string,
  body: Record<string, unknown>,
): Promise<CatalogRow> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const id = newSupplyId(kind.slice(0, -1));
  if (kind === "items") {
    const unit = requiredString(body, "unit", 16);
    if (!UNITS.has(unit)) throw invalid("Unit is invalid");
    const code = requireCode(body);
    await assertUnique(client, "billable_item", gameId, code);
    await client.query(
      `INSERT INTO "zzsh_supply"."billable_item" ("id", "game_id", "code", "name", "unit", "quantity_scale", "required", "enabled", "sort_order", "source_field", "source_token", "source_note")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        unit,
        optionalInteger(body, "quantityScale", 0, 6) ?? 0,
        optionalBoolean(body, "required") ?? false,
        optionalBoolean(body, "enabled") ?? true,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalString(body, "sourceField", 64) ?? null,
        optionalString(body, "sourceToken", 200) ?? null,
        optionalTrimmedString(body, "sourceNote", 500) ?? null,
      ],
    );
  } else if (kind === "rarities") {
    const code = requireCode(body);
    await assertUnique(client, "skin_rarity", gameId, code);
    await client.query(
      `INSERT INTO "zzsh_supply"."skin_rarity" ("id", "game_id", "code", "name", "sort_order", "enabled")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, gameId, code, requiredString(body, "name", 120), optionalInteger(body, "sortOrder", -100000, 100000) ?? 0, optionalBoolean(body, "enabled") ?? true],
    );
  } else if (kind === "categories") {
    const code = requireCode(body);
    await assertUnique(client, "skin_category", gameId, code);
    const parentId = optionalNullableString(body, "parentId", 128);
    if (parentId !== undefined && parentId !== null) await assertCategoryParent(client, gameId, parentId);
    await client.query(
      `INSERT INTO "zzsh_supply"."skin_category" ("id", "game_id", "code", "name", "parent_id", "sort_order", "enabled", "form_visible")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        parentId ?? null,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalBoolean(body, "enabled") ?? true,
        optionalBoolean(body, "formVisible") ?? true,
      ],
    );
  } else if (kind === "skins") {
    const code = requireCode(body);
    await assertUnique(client, "skin", gameId, code);
    const categoryId = requiredString(body, "categoryId", 128);
    await assertCategoryParent(client, gameId, categoryId);
    const rarityCode = optionalNullableString(body, "rarityCode", 64);
    if (rarityCode !== undefined && rarityCode !== null) await assertRarity(client, gameId, rarityCode);
    await client.query(
      `INSERT INTO "zzsh_supply"."skin" ("id", "game_id", "code", "name", "category_id", "rarity_code", "enabled", "form_visible", "media_id", "sort_order", "source_field", "source_token")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        categoryId,
        rarityCode ?? null,
        optionalBoolean(body, "enabled") ?? true,
        optionalBoolean(body, "formVisible") ?? true,
        null,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalString(body, "sourceField", 64) ?? null,
        optionalString(body, "sourceToken", 200) ?? null,
      ],
    );
  } else {
    const code = requireCode(body);
    await assertUnique(client, "entitlement", gameId, code);
    const valueKind = requiredString(body, "valueKind", 16);
    if (!["FLAG", "LEVEL", "CAPACITY"].includes(valueKind)) throw invalid("Value kind is invalid");
    const expiryKind = requiredString(body, "expiryKind", 16);
    if (!["PERMANENT", "TIMED"].includes(expiryKind)) throw invalid("Expiry kind is invalid");
    await client.query(
      `INSERT INTO "zzsh_supply"."entitlement" ("id", "game_id", "code", "name", "value_kind", "expiry_kind", "enabled", "sort_order", "source_field", "source_token")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        valueKind,
        expiryKind,
        optionalBoolean(body, "enabled") ?? true,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalString(body, "sourceField", 64) ?? null,
        optionalString(body, "sourceToken", 200) ?? null,
      ],
    );
  }
  await bumpCatalogRevision(client, gameId);
  return { id };
}

export async function updateCatalogEntry(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  kind: "items" | "rarities" | "categories" | "skins" | "entitlements",
  entryId: string,
  body: Record<string, unknown>,
): Promise<{ gameId: string }> {
  const table = TABLE_BY_KIND[kind];
  const current = await client.query<Record<string, unknown>>(
    `SELECT * FROM "zzsh_supply"."${table}" WHERE "id" = $1`,
    [entryId],
  );
  const row = current.rows[0];
  if (!row) throw notFound();
  const gameId = String(row.game_id);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (kind === "items") {
    const name = optionalString(body, "name", 120);
    const unit = optionalString(body, "unit", 16);
    if (unit !== undefined && !UNITS.has(unit)) throw invalid("Unit is invalid");
    const required = optionalBoolean(body, "required");
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    const quantityScale = optionalInteger(body, "quantityScale", 0, 6);
    const mediaId = optionalNullableString(body, "mediaId", 128);
    if ([name, unit, required, enabled, sortOrder, quantityScale, mediaId].every((value) => value === undefined)) throw invalid();
    if (mediaId !== undefined && mediaId !== null) await assertPlatformMediaBinding(client, gameId, mediaId, "ITEM_MEDIA");
    await client.query(
      `UPDATE "zzsh_supply"."billable_item"
          SET "name" = COALESCE($1, "name"), "unit" = COALESCE($2, "unit"),
              "required" = COALESCE($3, "required"), "enabled" = COALESCE($4, "enabled"),
              "sort_order" = COALESCE($5, "sort_order"), "quantity_scale" = COALESCE($6, "quantity_scale"),
              "media_id" = CASE WHEN $7::boolean THEN $8::text ELSE "media_id" END,
              "updated_at" = clock_timestamp()
        WHERE "id" = $9`,
      [name ?? null, unit ?? null, required ?? null, enabled ?? null, sortOrder ?? null, quantityScale ?? null, mediaId !== undefined, mediaId ?? null, entryId],
    );
  } else if (kind === "rarities") {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
    if (enabled === false) await assertRarityUnused(client, gameId, String(row.code));
    await client.query(
      `UPDATE "zzsh_supply"."skin_rarity" SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"), "sort_order" = COALESCE($3, "sort_order"), "updated_at" = clock_timestamp() WHERE "id" = $4`,
      [name ?? null, enabled ?? null, sortOrder ?? null, entryId],
    );
  } else if (kind === "categories") {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const formVisible = optionalBoolean(body, "formVisible");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    const parentId = optionalNullableString(body, "parentId", 128);
    if ([name, enabled, formVisible, sortOrder, parentId].every((value) => value === undefined)) throw invalid();
    if (parentId !== undefined && parentId !== null) await assertCategoryParent(client, gameId, parentId);
    await client.query(
      `UPDATE "zzsh_supply"."skin_category"
          SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"),
              "form_visible" = COALESCE($3, "form_visible"), "sort_order" = COALESCE($4, "sort_order"),
              "parent_id" = CASE WHEN $5::boolean THEN $6 ELSE "parent_id" END,
              "updated_at" = clock_timestamp()
        WHERE "id" = $7`,
      [name ?? null, enabled ?? null, formVisible ?? null, sortOrder ?? null, parentId !== undefined, parentId ?? null, entryId],
    );
  } else if (kind === "skins") {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const formVisible = optionalBoolean(body, "formVisible");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    const categoryId = optionalString(body, "categoryId", 128);
    const rarityCode = optionalNullableString(body, "rarityCode", 64);
    const mediaId = optionalNullableString(body, "mediaId", 128);
    if ([name, enabled, formVisible, sortOrder, categoryId, rarityCode, mediaId].every((value) => value === undefined)) throw invalid();
    if (categoryId !== undefined) await assertCategoryParent(client, gameId, categoryId);
    if (rarityCode !== undefined && rarityCode !== null) await assertRarity(client, gameId, rarityCode);
    if (mediaId !== undefined && mediaId !== null) await assertPlatformMediaBinding(client, gameId, mediaId, "SKIN_MEDIA");
    await client.query(
      `UPDATE "zzsh_supply"."skin"
          SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"),
              "form_visible" = COALESCE($3, "form_visible"), "sort_order" = COALESCE($4, "sort_order"),
              "category_id" = COALESCE($5, "category_id"),
              "rarity_code" = CASE WHEN $6::boolean THEN $7::text ELSE "rarity_code" END,
              "media_id" = CASE WHEN $8::boolean THEN $9::text ELSE "media_id" END,
              "updated_at" = clock_timestamp()
        WHERE "id" = $10`,
      [name ?? null, enabled ?? null, formVisible ?? null, sortOrder ?? null, categoryId ?? null, rarityCode !== undefined, rarityCode ?? null, mediaId !== undefined, mediaId ?? null, entryId],
    );
  } else {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
    await client.query(
      `UPDATE "zzsh_supply"."entitlement" SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"), "sort_order" = COALESCE($3, "sort_order"), "updated_at" = clock_timestamp() WHERE "id" = $4`,
      [name ?? null, enabled ?? null, sortOrder ?? null, entryId],
    );
  }
  await bumpCatalogRevision(client, gameId);
  return { gameId };
}

const TABLE_BY_KIND = {
  items: "billable_item",
  rarities: "skin_rarity",
  categories: "skin_category",
  skins: "skin",
  entitlements: "entitlement",
} as const;

async function assertUnique(client: PoolClient, table: string, gameId: string, code: string): Promise<void> {
  const existing = await client.query(`SELECT 1 FROM "zzsh_supply"."${table}" WHERE "game_id" = $1 AND "code" = $2`, [gameId, code]);
  if (existing.rows.length > 0) throw conflict("Stable code already exists in this game");
}

async function assertCategoryParent(client: PoolClient, gameId: string, categoryId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin_category" WHERE "id" = $1 AND "game_id" = $2`, [categoryId, gameId]);
  if (result.rows.length === 0) throw invalid("Category does not belong to this game");
}

async function assertRarity(client: PoolClient, gameId: string, rarityCode: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin_rarity" WHERE "game_id" = $1 AND "code" = $2`, [gameId, rarityCode]);
  if (result.rows.length === 0) throw invalid("Rarity is not defined for this game");
}

async function assertRarityUnused(client: PoolClient, gameId: string, rarityCode: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin" WHERE "game_id" = $1 AND "rarity_code" = $2 LIMIT 1`, [gameId, rarityCode]);
  if (result.rows.length > 0) throw conflict("Rarity is still referenced by skins");
}

export async function bindGameCover(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const mediaId = optionalNullableString(body, "mediaId", 128);
  if (mediaId === undefined) throw invalid();
  if (mediaId !== null) await assertPlatformMediaBinding(client, gameId, mediaId, "GAME_COVER");
  await client.query(
    `UPDATE "zzsh_supply"."game" SET "cover_media_id" = $1, "catalog_revision" = "catalog_revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $2`,
    [mediaId, gameId],
  );
}

export async function assertPlatformMediaBinding(
  client: PoolClient,
  gameId: string,
  mediaId: string,
  purpose: string,
): Promise<void> {
  const result = await client.query<{ ownershipKind: string; purpose: string; reviewState: string; accessClass: string; gameId: string }>(
    `SELECT "ownership_kind" AS "ownershipKind", "purpose", "review_state" AS "reviewState",
            "access_class" AS "accessClass", "game_id" AS "gameId"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1`,
    [mediaId],
  );
  const asset = result.rows[0];
  if (!asset || asset.gameId !== gameId) throw invalid("Media does not belong to this game");
  if (asset.ownershipKind !== "PLATFORM_CATALOG") throw invalid("Only reviewed platform catalog media can be bound");
  if (asset.purpose !== purpose) throw invalid("Media purpose does not match this binding");
  if (asset.reviewState !== "APPROVED" || asset.accessClass !== "PUBLIC_DISPLAY") throw invalid("Media is not approved for public display");
}

export type CatalogFilters = { q?: string; categoryId?: string; rarityCode?: string };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function parseCursor(cursor: string, binding: { gameId: string; revision: string; filters: CatalogFilters }): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalid("Cursor is invalid");
  const record = decoded as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.gameId !== binding.gameId ||
    record.revision !== binding.revision ||
    (record.q ?? null) !== (binding.filters.q ?? null) ||
    (record.categoryId ?? null) !== (binding.filters.categoryId ?? null) ||
    (record.rarityCode ?? null) !== (binding.filters.rarityCode ?? null) ||
    typeof record.lastSkinId !== "string"
  ) {
    throw conflict("Catalog changed or cursor does not match the current filters; refresh and retry");
  }
  return record.lastSkinId;
}

export function encodeCursor(binding: { gameId: string; revision: string; filters: CatalogFilters }, lastSkinId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, gameId: binding.gameId, revision: binding.revision, q: binding.filters.q ?? null, categoryId: binding.filters.categoryId ?? null, rarityCode: binding.filters.rarityCode ?? null, lastSkinId })).toString("base64url");
}

export async function readPublicCatalog(
  client: Pool | PoolClient,
  gameId: string,
  filters: CatalogFilters,
  limit: number,
  cursor?: string,
  scope: "browse" | "publishing" = "browse",
): Promise<Record<string, unknown>> {
  const game = await client.query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    catalogRevision: string;
    currentReleaseId: string | null;
    coverMediaId: string | null;
  }>(
    `SELECT "id", "code", "name", "description", "catalog_revision"::text AS "catalogRevision",
            "current_release_id" AS "currentReleaseId", "cover_media_id" AS "coverMediaId"
       FROM "zzsh_supply"."game" WHERE "id" = $1 AND "enabled" = true`,
    [gameId],
  );
  const gameRow = game.rows[0];
  if (!gameRow) throw notFound();
  let lastSkinId: string | undefined;
  if (cursor !== undefined) lastSkinId = parseCursor(cursor, { gameId, revision: gameRow.catalogRevision, filters });

  const itemSearch = scope === "browse" ? filters.q : undefined;
  const items = await client.query(
    `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "sort_order" AS "sortOrder",
            CASE WHEN EXISTS (SELECT 1 FROM zzsh_supply.media_asset a WHERE a.id=i.media_id AND a.game_id=i.game_id AND a.ownership_kind='PLATFORM_CATALOG' AND a.purpose='ITEM_MEDIA' AND a.review_state='APPROVED' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL) THEN i."media_id" ELSE NULL END AS "mediaId"
       FROM "zzsh_supply"."billable_item" i
      WHERE "game_id" = $1 AND "enabled" = true${scope === "publishing" ? ` AND EXISTS (SELECT 1 FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_line p ON p.price_version_id=r.price_version_id WHERE g.id=$1 AND p.item_id=i.id AND p.customer_tier='STANDARD')` : ""}${itemSearch ? ` AND "name" ILIKE $2 ESCAPE '\\'` : ""}
      ORDER BY "sort_order", "code", "id"`,
    itemSearch ? [gameId, `%${escapeLike(itemSearch)}%`] : [gameId],
  );

  const categories = await client.query(
    `WITH RECURSIVE visible AS (
       SELECT c."id", c."code", c."name", c."parent_id" AS "parentId", c."sort_order" AS "sortOrder"
         FROM "zzsh_supply"."skin_category" c
        WHERE c."game_id" = $1 AND c."enabled" = true AND c."form_visible" = true AND c."parent_id" IS NULL
       UNION ALL
       SELECT c."id", c."code", c."name", c."parent_id" AS "parentId", c."sort_order" AS "sortOrder"
         FROM "zzsh_supply"."skin_category" c
         JOIN visible p ON c."parent_id" = p."id"
        WHERE c."game_id" = $1 AND c."enabled" = true AND c."form_visible" = true
     )
     SELECT * FROM visible ORDER BY "sortOrder", "code", "id"`,
    [gameId],
  );

  const rarities = await client.query(
    `SELECT "code", "name", "sort_order" AS "sortOrder" FROM "zzsh_supply"."skin_rarity"
      WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );

  const entitlements = await client.query(
    `SELECT "id", "code", "name", "value_kind" AS "valueKind", "expiry_kind" AS "expiryKind", "sort_order" AS "sortOrder"
       FROM "zzsh_supply"."entitlement"
      WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );

  const parameters: unknown[] = [gameId];
  const conditions: string[] = [`s."game_id" = $1`, `s."enabled" = true`, `s."form_visible" = true`];
  parameters.push(categories.rows.map(c=>c.id));
  conditions.push(`s."category_id" = ANY($${parameters.length}::text[])`);
  if (filters.categoryId) {
    parameters.push(filters.categoryId);
    conditions.push(`s."category_id" IN (
      WITH RECURSIVE descendants AS (
        SELECT "id" FROM "zzsh_supply"."skin_category" WHERE "id" = $${parameters.length} AND "game_id" = $1
        UNION ALL
        SELECT c."id" FROM "zzsh_supply"."skin_category" c JOIN descendants d ON c."parent_id" = d."id"
      )
      SELECT "id" FROM descendants
    )`);
  }
  if (filters.rarityCode) {
    parameters.push(filters.rarityCode);
    conditions.push(`s."rarity_code" = $${parameters.length}`);
  }
  if (filters.q) {
    parameters.push(`%${escapeLike(filters.q)}%`);
    conditions.push(`s."name" ILIKE $${parameters.length} ESCAPE '\\'`);
  }
  if (lastSkinId !== undefined) {
    parameters.push(lastSkinId);
    conditions.push(`s."id" > $${parameters.length}`);
  }
  parameters.push(limit + 1);
  const skins = await client.query(
    `SELECT s."id", s."code", s."name", s."category_id" AS "categoryId", s."rarity_code" AS "rarityCode",
            CASE WHEN EXISTS (SELECT 1 FROM zzsh_supply.media_asset a WHERE a.id=s.media_id AND a.game_id=s.game_id AND a.ownership_kind='PLATFORM_CATALOG' AND a.review_state='APPROVED' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL) THEN s."media_id" ELSE NULL END AS "mediaId", s."sort_order" AS "sortOrder"
       FROM "zzsh_supply"."skin" s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s."id"
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = skins.rows.length > limit;
  const page = hasMore ? skins.rows.slice(0, limit) : skins.rows;
  const nextCursor = hasMore ? encodeCursor({ gameId, revision: gameRow.catalogRevision, filters }, page[page.length - 1]!.id) : null;

  const missing = scope === "publishing" ? (await client.query(`SELECT id,name FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled AND required AND NOT (id=ANY($2::text[]))`,[gameId,items.rows.map(i=>i.id)])).rows : [];
  return {
    ...(scope === "publishing" ? {ready: Boolean(gameRow.currentReleaseId) && missing.length===0, blockers: !gameRow.currentReleaseId ? [{code:"RULE_UNCONFIGURED",path:"rules"}] : missing.map(i=>({code:"REQUIRED_ITEM_UNPRICED",path:"inventory",itemId:i.id,name:i.name})), inputScale:0} : {}),
    game: gameRow,
    items: items.rows,
    categories: categories.rows,
    rarities: rarities.rows,
    entitlements: entitlements.rows,
    skins: page,
    nextCursor,
    limit,
  };
}

export async function readAdminCatalog(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
): Promise<Record<string, unknown>> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const game = await client.query(
    `SELECT "id", "code", "name", "description", "enabled", "catalog_revision"::text AS "catalogRevision",
            "current_release_id" AS "currentReleaseId", "cover_media_id" AS "coverMediaId"
       FROM "zzsh_supply"."game" WHERE "id" = $1`,
    [gameId],
  );
  if (game.rows.length === 0) throw notFound();
  const [items, rarities, categories, skins, entitlements] = await Promise.all([
    client.query(
      `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "enabled",
              "sort_order" AS "sortOrder", "media_id" AS "mediaId", "source_field" AS "sourceField", "source_token" AS "sourceToken", "source_note" AS "sourceNote"
         FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "sort_order" AS "sortOrder", "enabled" FROM "zzsh_supply"."skin_rarity" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "parent_id" AS "parentId", "sort_order" AS "sortOrder", "enabled", "form_visible" AS "formVisible"
         FROM "zzsh_supply"."skin_category" WHERE "game_id" = $1 ORDER BY "parent_id" NULLS FIRST, "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "category_id" AS "categoryId", "rarity_code" AS "rarityCode", "enabled",
              "form_visible" AS "formVisible", "media_id" AS "mediaId", "sort_order" AS "sortOrder",
              "source_field" AS "sourceField", "source_token" AS "sourceToken"
         FROM "zzsh_supply"."skin" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "value_kind" AS "valueKind", "expiry_kind" AS "expiryKind", "enabled",
              "sort_order" AS "sortOrder", "source_field" AS "sourceField", "source_token" AS "sourceToken"
         FROM "zzsh_supply"."entitlement" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
  ]);
  return {
    game: game.rows[0],
    items: items.rows,
    rarities: rarities.rows,
    categories: categories.rows,
    skins: skins.rows,
    entitlements: entitlements.rows,
  };
}
