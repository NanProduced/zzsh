import type { PoolClient } from "pg";

import { gameScopeSql } from "./admin-scope";
import { forbidden, notFound, sha256Hex } from "../supply/supply-util";
import { projectPublicAttributeDisplay } from "../supply/listing-query";
import { accountViewFrozen, orderReadKeyRelation, orderReadRelation, projectAdminReadOrder, type OrderAccountViewReader } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { legacyUserOrderResources } from "../order/legacy-user-order-read";
import { readDirectoryUserSummaries } from "./user-directory-summary";
import {
  TIMESTAMP_TEXT,
  encodeKeysetCursor,
  parseKeysetCursor,
  type AdminDirectoryViewer,
} from "./user-directory-list";

const USER_ORDER_ROLES = ["renter", "owner", "any"] as const;
export type UserOrderRole = (typeof USER_ORDER_ROLES)[number];

export type UserOrderFilter = {
  role?: UserOrderRole;
  status?: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" | "current";
  limit: number;
  cursor?: string;
};

type UserOrderRow = {
  id: string;
  displayNo: string;
  status: string;
  role: "renter" | "owner";
  accountId: string;
  accountDisplayNo: string | null;
  title: string;
  gameId: string;
  rentalAmountCents: string;
  depositAmountCents: string;
  currency: string;
  counterpartyName: string;
  counterpartyUserId: string;
  createdAt: string;
  holdUntil: string;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  expiredAwaitingCancel: boolean;
  versionId?: string;
  contentHash?: string;
  termSeconds?: string;
};

type OrderAccountBinding = { origin: 'NATIVE' | 'LEGACY'; orderId: string; accountId: string; versionId?: string | null; contentHash?: string | null };
type OrderAccountFacts = { source: 'ORDER_VERSION' | 'ACCOUNT_PUBLIC_VERSION' | 'LEGACY_ACCOUNT_SNAPSHOT'; resources: Array<{code: string; name?: string; quantity: string | null; unit: string}>; loginMethodText: string | null; termDays?: string; safeBoxText?: string | null; gradingText?: string | null };

/** Page-selected accounts only: never substitute current inventory for the frozen native version. */
async function readOrderAccountFacts(client: PoolClient, viewer: AdminDirectoryViewer, bindings: OrderAccountBinding[], accountViews?: OrderAccountViewReader) {
  const facts = new Map<string, OrderAccountFacts>();
  if (!viewer.resourceRead || viewer.businessScopeUsable === false || !bindings.length) return facts;
  const selected = bindings.filter(row=>row.origin==='LEGACY' || row.versionId && row.contentHash);
  if (!selected.length) return facts;
  const rows = (await client.query<{origin: 'NATIVE'|'LEGACY'; orderId: string; accountId: string; versionId: string | null; attributes: Record<string, unknown>; presentationItems: unknown; resources: Array<{itemId: string; code: string; quantity: string | null; unit: string}>}>(
      `SELECT /* directory-order-account-facts */ wanted.origin,wanted."orderId",wanted."accountId",v.id AS "versionId",v.attributes,v.presentation->'items' AS "presentationItems",
        COALESCE(jsonb_agg(jsonb_build_object('itemId',l.item_id,'code',i.code,'quantity',l.quantity::text,'unit',i.unit) ORDER BY i.sort_order,i.id) FILTER (WHERE i.id IS NOT NULL),'[]'::jsonb) AS resources
       FROM jsonb_to_recordset($1::jsonb) AS wanted(origin text,"orderId" text,"accountId" text,"versionId" text,"contentHash" text)
       JOIN zzsh_supply.rental_account a ON a.id=wanted."accountId"
       LEFT JOIN zzsh_supply.listing_version v ON wanted.origin='NATIVE' AND v.id=wanted."versionId" AND v.account_id=wanted."accountId" AND v.content_hash=wanted."contentHash"
       LEFT JOIN zzsh_supply.inventory_line l ON l.version_id=v.id
       LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id
       WHERE ${gameScopeSql('a.game_id','$3','$2')}
       GROUP BY wanted.origin,wanted."orderId",wanted."accountId",v.id`, [JSON.stringify(selected),viewer.isBoss,viewer.adminId],
  )).rows;
  for (const row of rows) if (row.origin==='NATIVE' && row.versionId) {
    const frozen = new Map<string, Record<string, unknown> | null>();
    for (const item of Array.isArray(row.presentationItems) ? row.presentationItems : []) {
      if (item && typeof item==='object' && typeof item.id==='string') frozen.set(item.id,frozen.has(item.id)?null:item);
    }
    const resources = row.resources.map(item=>{
      const original = frozen.get(item.itemId);
      // A missing/ambiguous frozen name must not become today's renamed catalog label.
      return {code:typeof original?.code==='string'?original.code:item.code,
        ...(typeof original?.name==='string' && original.name.trim()?{name:original.name}:{}),
        quantity:item.quantity,unit:typeof original?.unit==='string'?original.unit:item.unit};
    });
    const display = projectPublicAttributeDisplay(row.attributes);
    facts.set(`NATIVE\u0000${row.orderId}`, {source:'ORDER_VERSION',resources,loginMethodText:display.loginMethod?.displayName ?? null,safeBoxText:display.safeBox?.displayName ?? null,gradingText:display.grading?.displayName ?? null});
  }
  const legacy = rows.filter(row => row.origin==='LEGACY');
  // 迁入单当前账号资料与供给页同源；来源随投影保留，原单事实单独读取。
  const views = accountViews && legacy.length ? await accountViews(client, [...new Set(legacy.map(row => row.accountId))]) : new Map();
  for (const row of legacy) {
    const view = views.get(row.accountId);
    if (!view) continue;
    const account = accountViewFrozen(view);
    const resources = [...(account.haff ? [account.haff] : []), ...account.materials].map(item => ({code:item.code,...(item.name ? {name:item.name} : {}),quantity:item.quantity,unit:item.unit}));
    facts.set(`LEGACY\u0000${row.orderId}`, {source:account.source,resources,loginMethodText:account.loginMethodText,...(account.termDays ? {termDays:account.termDays} : {}),safeBoxText:account.safeBoxText ?? null,gradingText:account.gradingText ?? null});
  }
  return facts;
}

export async function listUserOrders(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  filter: UserOrderFilter,
  accountViews?: OrderAccountViewReader,
): Promise<Record<string, unknown>> {
  if (!viewer.orderRead) throw forbidden("Order reading requires order.read");
  if (viewer.legacyRead) return listUserReadOrders(client,viewer,userId,filter,accountViews);
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: "admin-user-orders",
      principal: viewer.adminId,
      isBoss: viewer.isBoss,
      authorizationKey: viewer.authorizationKey ?? null,
      userId,
      role: filter.role ?? "any",
      status: filter.status ?? null,
      limit: filter.limit,
    }),
  );
  const cursor = parseKeysetCursor(filter.cursor, filterKey);
  const values: unknown[] = [userId, viewer.isBoss, viewer.adminId];
  const conditions = [
    `(o.renter_user_id = $1 OR o.owner_user_id = $1)`,
    gameScopeSql("o.game_id","$3","$2"),
  ];
  if (filter.role === "renter") conditions.push(`o.renter_user_id = $1`);
  if (filter.role === "owner") conditions.push(`o.owner_user_id = $1`);
  if (filter.status === "current") conditions.push(`o.status IN ('PENDING_PAYMENT','PAID')`);
  else if (filter.status) conditions.push(`o.status = $${values.push(filter.status)}`);
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, filter.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  conditions.push(`($${cursorTime}::timestamptz IS NULL OR o.created_at < $${cursorTime}::timestamptz OR (o.created_at = $${cursorTime}::timestamptz AND o.id < $${cursorId}))`);
  const rows = (
    await client.query<UserOrderRow>(
      `SELECT o.id, o.display_no AS "displayNo", o.status,
              CASE WHEN o.renter_user_id = $1 THEN 'renter' ELSE 'owner' END AS role,
              o.account_id AS "accountId", a.display_no AS "accountDisplayNo", o.title, o.game_id AS "gameId",
              o.rental_amount_cents::text AS "rentalAmountCents", o.deposit_amount_cents::text AS "depositAmountCents",
              o.currency,
              cp.name AS "counterpartyName", cp.id AS "counterpartyUserId",
              to_char(o.created_at ${TIMESTAMP_TEXT}) AS "createdAt",
              to_char(o.hold_until ${TIMESTAMP_TEXT}) AS "holdUntil",
              to_char(o.paid_at ${TIMESTAMP_TEXT}) AS "paidAt",
              CASE WHEN o.cancelled_at IS NULL THEN NULL ELSE to_char(o.cancelled_at ${TIMESTAMP_TEXT}) END AS "cancelledAt",
              o.cancel_reason AS "cancelReason",
              o.listing_version_id AS "versionId",o.content_hash AS "contentHash",o.term_seconds::text AS "termSeconds",
              (o.status = 'PENDING_PAYMENT' AND o.hold_until <= clock_timestamp()) AS "expiredAwaitingCancel"
         FROM zzsh_order.rental_order o
         LEFT JOIN zzsh_supply.rental_account a ON a.id = o.account_id
         JOIN zzsh_auth_user."user" cp ON cp.id = CASE WHEN o.renter_user_id = $1 THEN o.owner_user_id ELSE o.renter_user_id END
        WHERE ${conditions.join(" AND ")}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, filter.limit);
  const counterparties = await readDirectoryUserSummaries(client, items.map(row => row.counterpartyUserId), viewer.permissions, viewer);
  const accountFacts = await readOrderAccountFacts(client, viewer, items.map(row => ({origin:'NATIVE',orderId:row.id,accountId:row.accountId,versionId:row.versionId,contentHash:row.contentHash})));
  const hasMore = rows.length > filter.limit;
  const last = items.at(-1);
  const toYuan = (cents: string) => {
    const value = BigInt(cents);
    const sign = value < 0n ? "-" : "";
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  };
  return {
    items: items.map((row) => ({
      orderId: row.id,
      displayNo: row.displayNo,
      status: row.status,
      role: row.role,
      ...(viewer.resourceRead ? { accountId: row.accountId, accountDisplayNo: row.accountDisplayNo } : {}),
      title: row.title,
      orderFacts: {termSeconds: row.termSeconds ?? null, resources: []},
      ...(accountFacts.has(`NATIVE\u0000${row.id}`) ? {accountFacts: accountFacts.get(`NATIVE\u0000${row.id}`)!} : {}),
      gameId: row.gameId,
      counterpartyName: row.counterpartyName,
      counterpartyUserId: row.counterpartyUserId,
      ...(counterparties.has(row.counterpartyUserId) ? { counterpartySummary: counterparties.get(row.counterpartyUserId)! } : {}),
      amounts: {
        rental: { currency: row.currency, unit: "yuan", amount: toYuan(row.rentalAmountCents), scale: 2 },
        deposit: { currency: row.currency, unit: "yuan", amount: toYuan(row.depositAmountCents), scale: 2 },
        totalDue: {
          currency: row.currency,
          unit: "yuan",
          amount: toYuan((BigInt(row.rentalAmountCents) + BigInt(row.depositAmountCents)).toString()),
          scale: 2,
        },
      },
      createdAt: row.createdAt,
      holdUntil: row.holdUntil,
      paidAt: row.paidAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      expiredAwaitingCancel: row.expiredAwaitingCancel,
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.createdAt, id: last.id }) : null,
    limit: filter.limit,
  };
}

async function listUserReadOrders(client:PoolClient,viewer:AdminDirectoryViewer,userId:string,filter:UserOrderFilter,accountViews?:OrderAccountViewReader) {
  const key=sha256Hex(JSON.stringify({scope:'admin-user-read-orders',principal:viewer.adminId,authorizationKey:viewer.authorizationKey??null,userId,role:filter.role??'any',status:filter.status??null,limit:filter.limit}));
  const cursor=parseKeysetCursor(filter.cursor,key),values:unknown[]=[userId,viewer.isBoss,viewer.adminId],where=[`(x.owner_user_id=$1 OR x.renter_user_id=$1)`,gameScopeSql("x.game_id","$3","$2")];
  if(filter.role==='owner')where.push('x.owner_user_id=$1');if(filter.role==='renter')where.push('x.renter_user_id=$1');
  if(filter.status==='current')where.push("x.status IN ('PENDING_PAYMENT','PAID')");else if(filter.status)where.push('x.status=$'+values.push(filter.status));
  const time='$'+values.push(cursor?.createdAt??null),id='$'+values.push(cursor?.id??null),limit='$'+values.push(filter.limit+1);
  where.push(`(${time}::timestamptz IS NULL OR COALESCE(x.created_at,'0001-01-01'::timestamptz)<${time}::timestamptz OR (COALESCE(x.created_at,'0001-01-01'::timestamptz)=${time}::timestamptz AND x.id<${id}))`);
  const continuationReady=await legacyContinuationReady(client);
  const rows=(await client.query(`WITH all_orders AS(${orderReadKeyRelation(continuationReady,{participantUserId:'$1'})}) SELECT x.origin,x.id,CASE WHEN x.renter_user_id=$1 THEN 'renter' ELSE 'owner' END AS role,to_char(COALESCE(x.created_at,'0001-01-01'::timestamptz) ${TIMESTAMP_TEXT}) AS "sortAt" FROM all_orders x WHERE ${where.join(' AND ')} ORDER BY x.created_at DESC NULLS LAST,x.id DESC LIMIT ${limit}`,values)).rows;
  const items=rows.slice(0,filter.limit),last=items.at(-1);
  const recordsByKey=new Map<string,Record<string,unknown>>();
  if(items.length){
    // Scope and cursor are decided on narrow keys; only this page's origin-bound records are expanded.
    const recordValues=[items.filter(row=>row.origin==='NATIVE').map(row=>row.id),items.filter(row=>row.origin==='LEGACY').map(row=>row.id)];
    const records=(await client.query<{origin:string;id:string;record:Record<string,unknown>}>(`WITH all_orders AS(${orderReadRelation(continuationReady,false,{nativeIds:'$1',legacyIds:'$2'})}) SELECT x.origin,x.id,x.record FROM all_orders x`,recordValues)).rows;
    for(const row of records)recordsByKey.set(`${row.origin}\u0000${row.id}`,row.record);
  }
  const projected=items.map(row=>{
      const record=recordsByKey.get(`${row.origin}\u0000${row.id}`);
      if(!record)throw notFound();
      const order=projectAdminReadOrder(row.origin,record,{adminId:viewer.adminId,isBoss:viewer.isBoss,internalQuote:false,authorizationKey:viewer.authorizationKey??''});
      const raw=record.source_snapshot as Record<string, unknown> | undefined;
      const resources=row.origin==='LEGACY'?legacyUserOrderResources({
        expendHaff:raw?.expend_haff as string | null,awmBulletNum:raw?.awm_bullet_num as string | null,level6BulletNum:raw?.level6_bullet_num as string | null,
        level6HelmetNum:raw?.level6_helmet_num as string | null,level6ArmorNum:raw?.level6_armor_num as string | null,topInsureCardNum:raw?.top_insure_card_num as string | null,
        barrettBulletNum:raw?.barrett_bullet_num as string | null,coffeeNum:raw?.coffee_num as string | null,
      }):[];
      return {orderId:order.id,displayNo:order.displayNo,status:order.status,role:row.role,
        ...(viewer.resourceRead?{accountId:order.accountId,accountDisplayNo:order.accountDisplayNo}:{}),
        title:order.title,gameId:order.gameId,counterpartyName:row.role==='renter'?order.ownerName:order.renterName,
        orderFacts:{termSeconds:row.origin==='NATIVE'?order.termSeconds??null:null,resources},
        counterpartyUserId:row.role==='renter'?order.ownerUserId:order.renterUserId,
        amounts:order.amounts,
        createdAt:order.createdAt,paidAt:order.paidAt,cancelledAt:order.cancelledAt,cancelReason:order.cancelReason,
        holdUntil:order.holdUntil,expiredAwaitingCancel:order.expiredAwaitingCancel,
        payment:order.payment,source:order.source};
    });
  const counterparties=await readDirectoryUserSummaries(client,projected.flatMap(row=>typeof row.counterpartyUserId==='string'?[row.counterpartyUserId]:[]),viewer.permissions,viewer);
  const accountFacts=await readOrderAccountFacts(client,viewer,items.map(row=>{
    const record=recordsByKey.get(`${row.origin}\u0000${row.id}`)!;
    return {origin:row.origin as 'NATIVE'|'LEGACY',orderId:row.id,accountId:String(record.account_id),versionId:row.origin==='NATIVE'?record.listing_version_id as string:null,contentHash:row.origin==='NATIVE'?record.content_hash as string:null};
  }),accountViews);
  return {
    items:projected.map((row,index)=>({...row,...(counterparties.has(row.counterpartyUserId)?{counterpartySummary:counterparties.get(row.counterpartyUserId)!}:{}),...(accountFacts.has(`${items[index]!.origin}\u0000${row.orderId}`)?{accountFacts:accountFacts.get(`${items[index]!.origin}\u0000${row.orderId}`)!}:{})})),
    nextCursor:rows.length>filter.limit&&last?encodeKeysetCursor(key,{sortAt:last.sortAt,id:last.id}):null,limit:filter.limit,
  };
}
