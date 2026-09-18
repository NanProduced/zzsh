import type { INestApplication } from "@nestjs/common";
import { readAdminContext, assertAdminContextInTransaction, type AuthSecurityOptions } from "./auth-security";
import { requirePermission, ADMIN_PERMISSION } from "./admin-authorization";
import { readUserContext } from "./user-identity";
import { withTransaction } from "./security-core";
import { assertReplayAuthorization } from "../order/order";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, sendJson } from "../supply/supply-util";
import { decodeId, safely, requireAdminAccess, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, notFound, type SupplyNodeRequest } from "../supply/supply-util";
import { readRentalMembership, membershipProjection, parseMembershipChange, changeRentalMembership } from "./rental-membership";

export async function handleRentalMembershipAdmin(request:SupplyNodeRequest,response:SupplyResponse,options:AuthSecurityOptions) {
  const requestId=ensureApiV1RequestId(request);
  await safely(response,requestId,async()=>{
    const path=(request.originalUrl??request.url??"").split("?")[0]!;
    const match=/^\/api\/(?:v1\/admin|bff\/admin)\/users\/([^/]+)\/rental-membership$/.exec(path);
    if(!match || !["GET","PUT"].includes(request.method??"GET"))throw notFound();
    const origin=request.headers.origin;
    if((request.method!=="GET" || origin!==undefined) && origin!==options.adminOrigin && origin!==options.apiOrigin)throw forbidden();
    const userId=decodeId(match[1]!);
    const context=await readAdminContext(request,options);
    const authorize=async(client:Parameters<typeof readRentalMembership>[0])=>{await assertAdminContextInTransaction(client,context);requirePermission(await requireAdminAccess(client,context.userId),ADMIN_PERMISSION.userRentalMembershipManage);};
    if(request.method==="GET") {
      const result=await withTransaction(options.pool,async client=>{await authorize(client);if(!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1`,[userId])).rowCount)throw notFound();return readRentalMembership(client,userId);});
      sendJson(response,200,{membership:result},requestId);return;
    }
    const input=parseMembershipChange(bodyOf(request));
    await runIdempotentWrite(options,request,response,requestId,{principalId:context.userId,operation:"user.rental_membership.update",resourceId:userId},{realm:"admin",id:context.userId,sessionId:context.sessionId},input,authorize,async client=>({status:200,body:{membership:await changeRentalMembership(client,userId,input,context,requestId)}}));
  });
}

export function mountRentalMembership(app:INestApplication,options:AuthSecurityOptions) {
  const express=app.getHttpAdapter().getInstance();
  express.use("/api/v1/admin/users",(request:SupplyNodeRequest,response:SupplyResponse)=>handleRentalMembershipAdmin(request,response,options));
  express.use("/api/v1/users/me/rental-membership",(request:SupplyNodeRequest,response:SupplyResponse)=>{
    const requestId=ensureApiV1RequestId(request);
    return safely(response,requestId,async()=>{
      if(request.method!=="GET" || (request.originalUrl??"").split("?")[0]!=="/api/v1/users/me/rental-membership")throw notFound();
      const context=await readUserContext(request,options);
      const membership=await withTransaction(options.pool,async client=>{await assertReplayAuthorization(client,context);return membershipProjection(await readRentalMembership(client,context.userId));});
      sendJson(response,200,{membership},requestId);
    });
  });
}
