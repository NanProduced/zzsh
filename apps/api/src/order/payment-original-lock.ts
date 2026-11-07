import type { PoolClient } from "pg";

/** Shared by payment acceptance and refund paths; caller keeps the established lock order. */
export async function lockRefundOrderNo(client: PoolClient, merchantIdentityId: string, orderNo: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-order-no:v1',$1::text,$2::text)::text,0))`, [merchantIdentityId, orderNo]);
  // Legacy imports do not prove a merchant identity, so reserve the number across identities as well.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:legacy-original-order-no:v1',$1::text)::text,0))`, [orderNo]);
}

export async function lockRefundOrderNos(client:PoolClient,merchantIdentityId:string,orderNos:readonly string[]){
  for(const orderNo of [...new Set(orderNos)].sort())await lockRefundOrderNo(client,merchantIdentityId,orderNo);
}

export async function hasNativeOriginalOrderNo(client: PoolClient, orderNo: string): Promise<boolean> {
  const row = (await client.query<{found:boolean}>(`SELECT
    EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation WHERE source='JOINPAY' AND merchant_order_no=$1)
    OR EXISTS(SELECT 1 FROM zzsh_order.payment_request WHERE channel='JOINPAY' AND channel_order_no=$1)
    OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND original_payment_order_no=$1) AS found`, [orderNo])).rows[0];
  return row?.found !== false;
}
