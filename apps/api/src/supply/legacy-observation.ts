import type { PoolClient } from "pg";
import { conflict, invalid, newSupplyId } from "./supply-util";
import { lockPublishingAccount } from "./publishing";
import {
  loadEffectiveAdminAccess,
  requirePermission,
} from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { assertGameScope } from "./supply-util";
/** Controlled compatibility seam; no production scanner, import command or public write route. */
export async function recordLegacyObservation(
  client: PoolClient,
  accountId: string,
  input: {
    sourceSystem: string;
    sourceEntity: string;
    legacyId: string;
    evidenceRef: string;
    sourceDigest: string;
    inventory: Array<{
      itemId: string;
      quantity: string | null;
    }>;
  },
  actor: {
    id: string;
    sessionId: string;
    requestId: string;
  },
): Promise<string> {
  if (
    !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
    ![
      input.sourceSystem,
      input.sourceEntity,
      input.legacyId,
      input.evidenceRef,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 512)
  )
    throw invalid("Legacy source reference is required");
  const a = await lockPublishingAccount(client, accountId);
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage");
  await assertGameScope(client, actor.id, access!.isBoss, a.game_id);
  const previous = (
    await client.query(
      `SELECT version_id,source_digest,account_id FROM zzsh_supply.legacy_supply_map WHERE source_system=$1 AND source_entity=$2 AND legacy_id=$3`,
      [input.sourceSystem, input.sourceEntity, input.legacyId],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.source_digest !== input.sourceDigest ||
      previous.account_id !== accountId
    )
      throw conflict("Legacy source conflicts with the recorded observation");
    return previous.version_id;
  }
  if (a.current_version_id)
    throw conflict("Do not overwrite a new-platform declaration");
  const id = newSupplyId("observation");
  await client.query(
    `INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,origin,title) VALUES($1,$2,1,'LEGACY_OBSERVATION','历史资料待核实')`,
    [id, a.id],
  );
  for (const item of input.inventory) {
    if (item.quantity !== null && !/^(0|[1-9]\d{0,23})$/.test(item.quantity))
      throw invalid("Legacy quantity requires evidence of the base unit");
    await client.query(
      `INSERT INTO zzsh_supply.inventory_line(version_id,item_id,quantity) VALUES($1,$2,$3)`,
      [id, item.itemId, item.quantity],
    );
  }
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='IMPORTED_UNVERIFIED' WHERE id=$1`,
    [id],
  );
  await client.query(
    `INSERT INTO zzsh_supply.legacy_supply_map(source_system,source_entity,legacy_id,account_id,version_id,evidence_ref,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.sourceSystem,
      input.sourceEntity,
      input.legacyId,
      a.id,
      id,
      input.evidenceRef,
      input.sourceDigest,
    ],
  );
  await client.query(
    `UPDATE zzsh_supply.rental_account SET current_version_id=$2,legacy_hold='UNRESOLVED',revision=revision+1 WHERE id=$1`,
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
        evidenceRef: input.evidenceRef,
        sourceSystem: input.sourceSystem,
        sourceEntity: input.sourceEntity,
        legacyId: input.legacyId,
        sourceDigest: input.sourceDigest,
      },
      result: "OBSERVED",
    },
  });
  return id;
}
