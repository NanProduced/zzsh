import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import { readLegacyPublicSlots } from "./legacy-path-projection";
import type { LegacyImageCdn, LegacyImageCdnDelivery, LegacyImageProof } from "./legacy-image-cdn";
import { readPublicListing, readPublishingAccount, type SupplyGateReader } from "./publishing";
import { newSupplyId } from "./supply-util";

type DesiredSlot = { versionId: string; position: number; proof: LegacyImageProof };
type LegacyDeliveryRow = LegacyImageCdnDelivery & Pick<LegacyImageProof, "sha256" | "byteSize" | "mime"> & { state: "PENDING_IMPORT" | "UNAVAILABLE" | "PUBLISHING" | "READY" | "REVOKING"; removable: boolean };
type LegacySyncContext = { gate: SupplyGateReader; legacyPublicAdmission?: LegacyPublicAdmission; legacyPublicAdmissionDetail?: LegacyPublicAdmissionDetailIndex };
const slotKey = (slot: { versionId: string; position: number }) => `${slot.versionId}/${slot.position}`;

async function readDesiredLegacy(client: PoolClient, accountId: string, cdn: LegacyImageCdn, context: LegacySyncContext): Promise<DesiredSlot[]> {
  if (!cdn.enabled) return [];
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const account = await readPublishingAccount(client, accountId);
    const listing = await readPublicListing(client, account, context.gate, context.legacyPublicAdmission, false, "DETAIL", context.legacyPublicAdmissionDetail);
    const versionId = String(listing.versionId);
    const slots = (await readLegacyPublicSlots(client, [listing])).get(listing) ?? [];
    const approved = slots.flatMap(slot => {
      const proof = cdn.proof(slot.path);
      return proof ? [{ versionId, position: slot.position, proof }] : [];
    });
    await client.query("COMMIT");
    return approved;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof SecurityApiError && error.status === 404) return [];
    throw error;
  }
}

/** Native and legacy jobs run on the same session lock. The path remains private until a new generation is reserved. */
export async function synchronizeLegacyImages(client: PoolClient, item: { accountId: string; revision: string }, cdn: LegacyImageCdn, context: LegacySyncContext, stopping: () => boolean,
  readEligible = readDesiredLegacy): Promise<boolean> {
  const read = () => readEligible(client, item.accountId, cdn, context);
  const desired = await read();
  const wanted = new Map(desired.map(slot => [slotKey(slot), slot.proof]));
  const active = (await client.query<LegacyDeliveryRow>(
    `SELECT id, account_id AS "accountId", version_id AS "versionId", position, source_path AS "sourcePath", sha256, byte_size AS "byteSize", mime, state,
        (published_at IS NOT NULL OR created_at<=clock_timestamp()-interval '2 minutes') AS removable
       FROM zzsh_supply.legacy_image_cdn_delivery WHERE account_id=$1 AND state<>'REVOKED'`, [item.accountId],
  )).rows;
  const current = new Map<string, LegacyDeliveryRow>();
  let complete = true;
  for (const delivery of active) {
    if (stopping()) return false;
    const key = slotKey(delivery), proof = wanted.get(key);
    const matches = proof && proof.path === delivery.sourcePath && proof.sha256 === delivery.sha256 && proof.byteSize === delivery.byteSize && proof.mime === delivery.mime;
    const marker = delivery.state === "PENDING_IMPORT" || delivery.state === "UNAVAILABLE";
    if (marker && !matches) {
      await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKED' WHERE id=$1 AND state IN ('PENDING_IMPORT','UNAVAILABLE')`, [delivery.id]);
      continue;
    }
    if (delivery.state === "REVOKING" || delivery.state === "PUBLISHING" || delivery.state === "READY" && !matches) {
      await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING' WHERE id=$1 AND state IN ('READY','PUBLISHING')`, [delivery.id]);
      if (delivery.removable) {
        const task = await cdn.revoke(delivery);
        await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKED', purge_task_id=$2 WHERE id=$1 AND state='REVOKING'`, [delivery.id, task]);
        continue;
      }
      complete = false;
    }
    current.set(key, delivery);
  }
  for (const slot of desired) {
    if (stopping()) return false;
    const previous = current.get(slotKey(slot));
    if (previous && previous.state !== "PENDING_IMPORT" && previous.state !== "UNAVAILABLE") continue;
    const source = await cdn.inspectSource(slot.proof);
    if (stopping()) return false;
    if (source !== "READY" && previous) {
      await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state=$2 WHERE id=$1 AND state IN ('PENDING_IMPORT','UNAVAILABLE')`, [previous.id, source]);
      continue;
    }
    if (previous) await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKED' WHERE id=$1 AND state IN ('PENDING_IMPORT','UNAVAILABLE')`, [previous.id]);
    const delivery: LegacyImageCdnDelivery = { id: newSupplyId("cdn"), accountId: item.accountId, versionId: slot.versionId, position: slot.position, sourcePath: slot.proof.path };
    const matches = (row: DesiredSlot) => slotKey(row) === slotKey(slot) && row.proof.path === slot.proof.path && row.proof.sha256 === slot.proof.sha256;
    if (!(await read()).some(matches)) return false;
    const reserved = await client.query(
      `INSERT INTO zzsh_supply.legacy_image_cdn_delivery(id, account_id, version_id, position, source_path, sha256, byte_size, mime, state)
       SELECT $1, account_id, $4, $5, $6, $7, $8, $9, $10 FROM zzsh_supply.account_image_cdn_queue WHERE account_id=$2 AND request_revision=$3 FOR SHARE`,
      [delivery.id, item.accountId, item.revision, slot.versionId, slot.position, slot.proof.path, slot.proof.sha256, slot.proof.byteSize, slot.proof.mime, source === "READY" ? "PUBLISHING" : source],
    );
    if (!reserved.rowCount || stopping()) return false;
    if (source !== "READY") continue;
    let ready = false;
    try {
      await cdn.publish(delivery, slot.proof);
      ready = !stopping() && (await read()).some(matches);
    } catch { /* The reserved version remains traceable even if the copy outcome is unknown. */ }
    const done = ready && (await client.query(
      `WITH q AS MATERIALIZED (SELECT account_id FROM zzsh_supply.account_image_cdn_queue WHERE account_id=$3 AND request_revision=$2 FOR SHARE)
       UPDATE zzsh_supply.legacy_image_cdn_delivery d SET state='READY', published_at=clock_timestamp()
       FROM q WHERE d.id=$1 AND d.state='PUBLISHING' AND q.account_id=d.account_id`, [delivery.id, item.revision, item.accountId],
    )).rowCount;
    if (!done) {
      await client.query(`UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING' WHERE id=$1 AND state='PUBLISHING'`, [delivery.id]);
      return false;
    }
  }
  return complete;
}
