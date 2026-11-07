import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { settleLegacyCommissionDueOn } from "../order/legacy-finance-duty";

export type LegacyCommissionCursor={at:string;id:string};
export class LegacyCommissionCommitUnknown extends Error {
  constructor(){super("Legacy commission commit outcome is unknown; recheck the original duty");}
}

/** The caller holds the same live advisory-lock session as the native distribution worker. */
export async function runLegacyCommissionDuePage(client:PoolClient,cursor:LegacyCommissionCursor|null,limit:number,stopping:()=>boolean=()=>false){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100 || cursor!==null && (!Number.isFinite(Date.parse(cursor.at)) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cursor.id)))throw new Error("Invalid legacy commission cursor or limit");
  const ready=(await client.query<{ready:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('zzsh_order.legacy_commission_due_idx')
      AND indrelid=to_regclass('zzsh_order.legacy_order_duty') AND indisvalid AND indisready)
    AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.legacy_duty_finance_fact')
      WHERE p.oid=to_regprocedure('zzsh_order.post_legacy_finance_duty(text,text,text)') AND p.proowner=c.relowner AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog'] AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS ready`)).rows[0]?.ready;
  if(ready!==true)return {available:false,cursor:null,posted:0,deferred:0,scanned:0};
  let rows:Array<{id:string;orderId:string;at:string}>;
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='15s'");
    rows=(await client.query<{id:string;orderId:string;at:string}>(`SELECT d.id,d.order_id AS "orderId",
      to_char(d.maturity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM zzsh_order.legacy_order_duty d JOIN zzsh_order.legacy_order_read_snapshot o ON o.id=d.order_id
      WHERE d.kind='COMMISSION' AND d.status IN('PENDING','MATURED') AND (d.continuation_version_id IS NOT NULL OR d.admission_id IS NOT NULL)
        AND d.maturity_at<=statement_timestamp() AND o.source_pay_status=1
        AND ((o.source_order_status IN(3,8,9) AND d.continuation_version_id IS NOT NULL AND d.admission_id IS NULL)
          OR (o.source_order_status=4 AND d.admission_id IS NOT NULL AND d.continuation_version_id IS NULL))
        AND ($1::timestamptz IS NULL OR (d.maturity_at,d.id COLLATE "C")>($1::timestamptz,$2::text COLLATE "C"))
      ORDER BY d.maturity_at,d.id COLLATE "C" LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit])).rows;
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  let posted=0,deferred=0,scanned=0,last=cursor;
  for(const row of rows){
    if(stopping())break;
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) || !Number.isFinite(Date.parse(row.at)))throw new Error("Invalid original legacy commission source");
    let commitStarted=false;
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='3s'");
      const result=await settleLegacyCommissionDueOn(client,row.orderId,row.id);
      commitStarted=true;await client.query("COMMIT");
      if(result.outcome==="POSTED" || result.outcome==="ALREADY_POSTED")posted++;
      else if(result.outcome==="REVIEW_REQUIRED")deferred++;
    } catch(error) {
      const rolledBack=await client.query("ROLLBACK").then(()=>true,()=>false);
      if(commitStarted || !rolledBack)throw new LegacyCommissionCommitUnknown();
      if(!(error instanceof SecurityApiError) || ![409,503].includes(error.status))throw error;
      deferred++;
    }
    last={at:row.at,id:row.id};scanned++;
  }
  return {available:true,cursor:scanned<rows.length?last:rows.length<limit?null:last,posted,deferred,scanned};
}
