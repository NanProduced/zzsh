import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { assertFreshCreateAuthorization, insertReservationSnapshot, type OrderUserContext } from "./order";
import { authenticateConfirmation, verifyConfirmation } from "./confirmation-token";
import { verifyPersonalConfirmation, type PersonalConfirmationOptions } from "./personal-confirmation";
import { ensureOnlyFields, invalid } from "../supply/supply-util";
import type { PublishingAccount, ListingVersion } from "../supply/publishing";

export const PERSONAL_ORDER_OPERATION="order.reservation.create.v2";
export function personalOrderInput(body:Record<string,unknown>):{confirmationToken:string} {
  ensureOnlyFields(body,["confirmationToken"]);
  if(typeof body.confirmationToken!=="string" || body.confirmationToken.length<1 || body.confirmationToken.length>4096)throw invalid("Invalid confirmation credential","confirmationToken");
  // No signature, current key, expiry, membership or hold validation before replay lookup.
  return {confirmationToken:body.confirmationToken};
}
const used=():never=>{throw new SecurityApiError(409,"CONFIRMATION_USED","Confirmation already consumed; confirm again");};

export async function createPersonalReservation(client:PoolClient,context:OrderUserContext,token:string,options:PersonalConfirmationOptions & {holdSeconds?:number},requestId:string) {
  const now=Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now`)).rows[0].now);
  const authenticated=authenticateConfirmation(token,context,now,options.key);
  await assertFreshCreateAuthorization(client,context,authenticated.accountId);
  // Both users are locked. Same-subject consumption races serialize here before availability checks.
  if((await client.query(`SELECT 1 FROM zzsh_order.rental_order WHERE confirmation_id=$1`,[authenticated.confirmationId])).rowCount)used();
  if(!Number.isSafeInteger(options.holdSeconds) || options.holdSeconds!<=0)throw new SecurityApiError(503,"INTERNAL_ERROR","Order hold is not configured");
  const input={accountId:authenticated.accountId,versionId:authenticated.versionId,releaseId:authenticated.releaseId};
  const verified=await verifyPersonalConfirmation(client,context,input,token,options);
  const account=(await client.query<PublishingAccount>(`SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,[input.accountId])).rows[0]!;
  const version=(await client.query<ListingVersion>(`SELECT * FROM zzsh_supply.listing_version WHERE id=$1`,[input.versionId])).rows[0]!;
  const {quote,...personal}=verified.snapshot;
  const snapshot={...quote,quoteKind:"ORDER_CONFIRMATION" as const,orderSnapshotSchema:1,confirmationId:verified.claims.confirmationId,confirmationDigest:verified.claims.quoteDigest,confirmationExpiresAt:verified.claims.expiresAt,listingHash:verified.claims.listingHash,personal};
  const insertNow=Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now`)).rows[0].now);
  verifyConfirmation(token,authenticated,insertNow,options.key);
  try {
    return await insertReservationSnapshot(client,{context,account,version,snapshot,holdSeconds:options.holdSeconds!,requestId,confirmationId:verified.claims.confirmationId});
  } catch(error) {
    const db=error as {code?:string;constraint?:string;message?:string};
    if(db.code==="23505" && db.constraint==="rental_order_confirmation_unique")used();
    if(db.code==="40001" && db.message==="personal confirmation expired")throw new SecurityApiError(409,"CONFIRMATION_EXPIRED","Confirmation expired; confirm again");
    throw error;
  }
}
