import type { PoolClient } from "pg";

import { gameScopeSql } from "./admin-scope";
import { forbidden, invalid, notFound, sha256Hex } from "../supply/supply-util";
import { isEffectivePublicationState } from "../supply/listing-query";
import { loadLegacyHistoricalRead, loadLegacyHistoricalReads } from "../supply/legacy-listing-read";
import { publicListingBasis, readPublicListing, readPublishingAccount, type SupplyGateReader } from "../supply/publishing";
import {
  TIMESTAMP_TEXT,
  encodeKeysetCursor,
  parseKeysetCursor,
  publishedAccountSql,
  type AdminDirectoryViewer,
} from "./user-directory-list";

export type UserRentalAccountRow = {
  id: string;
  displayNo: string | null;
  lifecycle: string;
  ownerPaused: boolean;
  staffRestricted: boolean;
  restrictionReason: string | null;
  legacyHold: string;
  currentVersionId: string | null;
  createdAt: string;
  gameId: string;
  gameCode: string;
  gameName: string;
  versionState: string | null;
  publicationSource: string | null;
  retiredLegacy: boolean;
};

export async function listUserRentalAccounts(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  page: { limit: number; cursor?: string; publication?: "published" },
): Promise<Record<string, unknown>> {
  if (!viewer.resourceRead) throw forbidden("Resource reading requires supply.rental_account.read");
  if (page.publication !== undefined && page.publication !== "published") throw invalid("Publication filter is invalid");
  const filterKey = sha256Hex(
    JSON.stringify({ scope: "admin-user-rental-accounts", principal: viewer.adminId, isBoss: viewer.isBoss, authorizationKey: viewer.authorizationKey ?? null, userId, limit: page.limit, ...(page.publication ? { publication: page.publication } : {}) }),
  );
  const cursor = parseKeysetCursor(page.cursor, filterKey);
  const legacyMarketIds = new Set(viewer.legacyMarketAccountIds);
  const rows = (
    await client.query<UserRentalAccountRow>(
      `SELECT a.id, ${viewer.legacyRead ? "COALESCE(a.display_no,(SELECT l.legacy_account_no FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=a.id ORDER BY l.imported_at DESC LIMIT 1))" : "a.display_no"} AS "displayNo", a.lifecycle, a.owner_paused AS "ownerPaused",
              a.staff_restricted AS "staffRestricted",
              CASE WHEN a.staff_restricted THEN a.restriction_reason ELSE NULL END AS "restrictionReason",
              a.legacy_hold AS "legacyHold", a.current_version_id AS "currentVersionId",
              v.review_state AS "versionState", p.source AS "publicationSource",
              to_char(a.created_at ${TIMESTAMP_TEXT}) AS "createdAt",
              g.id AS "gameId", g.code AS "gameCode", g.name AS "gameName",
              (g.code='delta' AND EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id
                AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts')) AS "retiredLegacy"
         FROM zzsh_supply.rental_account a
         JOIN zzsh_supply.game g ON g.id = a.game_id
         LEFT JOIN zzsh_supply.listing_version v ON v.id = a.current_version_id AND v.account_id = a.id
         LEFT JOIN zzsh_supply.listing_publication p ON p.version_id = v.id AND p.account_id = a.id
           AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id AND p.rule_release_id=v.rule_release_id AND p.content_hash=v.content_hash
        WHERE a.owner_user_id = $1
          AND ${gameScopeSql("a.game_id","$3","$2")}
          ${page.publication ? `AND ${publishedAccountSql("a", legacyMarketIds.size ? "$7" : undefined)}` : ""}
          AND ($4::timestamptz IS NULL OR a.created_at < $4::timestamptz OR (a.created_at = $4::timestamptz AND a.id < $5))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $6`,
      [userId, viewer.isBoss, viewer.adminId, cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1,
        ...(page.publication && legacyMarketIds.size ? [[...legacyMarketIds]] : [])],
    )
  ).rows;
  const items = rows.slice(0, page.limit);
  const hasMore = rows.length > page.limit;
  const last = items.at(-1);
  const historical = await loadLegacyHistoricalReads(client, items.map(row => row.id));
  return {
    items: items.map((row) => ({
      accountId: row.id,
      displayNo: row.displayNo,
      game: { id: row.gameId, code: row.gameCode, name: row.gameName },
      lifecycle: row.lifecycle,
      ownerPaused: row.ownerPaused,
      staffRestricted: row.staffRestricted,
      restrictionReason: row.restrictionReason,
      legacyHold: row.legacyHold,
      currentVersionId: row.currentVersionId,
      publication: { versionState: row.versionState ?? null, source: row.publicationSource ?? null,
        ...(legacyMarketIds.has(row.id) ? { publiclyListed: true } : {}),
        versionPublished: isEffectivePublicationState(row.versionState, row.publicationSource),
        currentlyPublished: row.lifecycle === "ACTIVE" && row.retiredLegacy !== true && isEffectivePublicationState(row.versionState, row.publicationSource) },
      createdAt: row.createdAt,
      historicalRead: historical.get(row.id) ?? null,
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.createdAt, id: last.id }) : null,
    limit: page.limit,
  };
}

export async function readDirectoryRentalAccount(client:PoolClient,viewer:AdminDirectoryViewer,accountId:string,gate?:SupplyGateReader) {
  if(!viewer.resourceRead)throw forbidden("Resource reading requires supply.rental_account.read");
  const account=(await client.query(`SELECT a.id AS "accountId",COALESCE(a.display_no,(SELECT l.legacy_account_no FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=a.id AND l.legacy_account_no IS NOT NULL ORDER BY l.imported_at DESC LIMIT 1)) AS "displayNo",
    a.owner_user_id AS "ownerUserId",u.name AS "ownerName",a.lifecycle,a.owner_paused AS "ownerPaused",a.staff_restricted AS "staffRestricted",a.legacy_hold AS "legacyHold",v.title,v.id AS "versionId",v.review_state AS "versionState",g.name AS "gameName",g.id AS "gameId"
    FROM zzsh_supply.rental_account a JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
    WHERE a.id=$1 AND ${gameScopeSql("a.game_id","$3","$2")}`,[accountId,viewer.isBoss,viewer.adminId])).rows[0];
  if(!account)throw notFound();
  let publicVisible: boolean | null = null, publicBasis: ReturnType<typeof publicListingBasis> = null;
  if (gate) {
    try {
      publicBasis = publicListingBasis(await readPublicListing(client, await readPublishingAccount(client, accountId), gate, undefined, false, "DETAIL"));
      publicVisible = true;
    } catch (error) {
      if ((error as { status?: number }).status === 404) publicVisible = false;
      else throw error;
    }
  }
  return {account:{...account,historicalRead:await loadLegacyHistoricalRead(client,accountId),publicVisible,publicVersionId:publicBasis?.id ?? null,publicBasis},contextKey:viewer.authorizationKey};
}
