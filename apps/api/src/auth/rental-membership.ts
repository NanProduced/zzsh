import type { PoolClient } from "pg";
import { CUSTOMER_TIERS, type CustomerTier } from "../supply/delta-rental";
import { conflict, ensureOnlyFields, invalid, notFound } from "../supply/supply-util";
import { recordAudit } from "./security-core";

export type RentalMembership = { tier: CustomerTier | "UNKNOWN"; version: string; sourceRef: string | null };

export async function readRentalMembership(client: PoolClient, userId: string): Promise<RentalMembership> {
  const row = (await client.query<{tier:string;version:string;sourceRef:string;updatedBy:string|null}>(`SELECT tier,version::text,source_ref AS "sourceRef",updated_by_admin_id AS "updatedBy" FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[userId])).rows[0];
  if (!row) return {tier:"UNKNOWN",version:"0",sourceRef:null};
  const sourceValid=Boolean(row.sourceRef?.trim()) && (row.updatedBy!==null || (row.sourceRef==="registration:v1" && row.tier==="STANDARD"));
  return {tier:CUSTOMER_TIERS.includes(row.tier as CustomerTier) && sourceValid ? row.tier as CustomerTier : "UNKNOWN",version:row.version,sourceRef:row.sourceRef};
}

export function membershipProjection(value: RentalMembership) { return {tier:value.tier,version:value.version}; }

export function parseMembershipChange(body: Record<string,unknown>) {
  ensureOnlyFields(body,["tier","expectedVersion","sourceRef","reason"]);
  if (typeof body.tier!=="string" || ![...CUSTOMER_TIERS,"UNKNOWN"].includes(body.tier)) throw invalid("Invalid membership tier","tier");
  if (typeof body.expectedVersion!=="string" || !/^(0|[1-9]\d{0,18})$/.test(body.expectedVersion)) throw invalid("Expected membership version required","expectedVersion");
  for(const field of ["sourceRef","reason"] as const) if(typeof body[field]!=="string" || body[field].trim().length<2 || body[field].length>(field==="reason"?500:256)) throw invalid("Membership provenance and reason required",field);
  return {tier:body.tier,expectedVersion:body.expectedVersion,sourceRef:(body.sourceRef as string).trim(),reason:(body.reason as string).trim()};
}

export async function changeRentalMembership(client:PoolClient,userId:string,input:ReturnType<typeof parseMembershipChange>,actor:{userId:string;sessionId:string},requestId:string) {
  if(!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[userId])).rowCount) throw notFound();
  const before=await readRentalMembership(client,userId);
  if(before.version!==input.expectedVersion) throw conflict("Membership changed; reload and retry");
  if(before.version==="0") await client.query(`INSERT INTO zzsh_iam.user_rental_membership(user_id,tier,source_ref,updated_by_admin_id) VALUES($1,$2,$3,$4)`,[userId,input.tier,input.sourceRef,actor.userId]);
  else {
    const result=await client.query(`UPDATE zzsh_iam.user_rental_membership SET tier=$2,source_ref=$3,updated_by_admin_id=$4,version=version+1 WHERE user_id=$1 AND version=$5`,[userId,input.tier,input.sourceRef,actor.userId,input.expectedVersion]);
    if(result.rowCount!==1) throw conflict("Membership changed; reload and retry");
  }
  const after=await readRentalMembership(client,userId);
  await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,requestId,action:"user.rental_membership.updated",objectType:"user_rental_membership",objectId:userId,outcome:"SUCCESS",reason:input.reason,details:{before,after}});
  return after;
}
