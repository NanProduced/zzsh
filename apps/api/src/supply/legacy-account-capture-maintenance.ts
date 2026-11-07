import type { PoolClient } from "pg";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { legacyAccountCaptureFactDigest, legacyAccountCaptureFactFromSource, type LegacyAccountCaptureFact } from "./legacy-account-capture-fact";
import { canonicalize } from "./content-hash";
import { assertGameScope, conflict, fingerprintRequest, invalid, sha256Hex, withIdempotency } from "./supply-util";

type Binding = Omit<LegacyAccountCaptureFact, "schema" | "sourceAccountBaseRatioWanPerYuan" | "ratioIssue" | "sourceAccountFullPayoutSelected" | "payoutIssue">;
type Actor = { id:string; sessionId:string; requestId:string; reviewRef?:string; attempt?:string };

/** Bounded append; the source package and target identity must be verified by the maintenance loader. */
export async function recordLegacyAccountCaptureFactsBatch(client:PoolClient, inputs:Array<{binding:Binding;source:Record<string,unknown>}>, actor:Actor) {
  if(!Array.isArray(inputs)||inputs.length<1||inputs.length>400)throw invalid("A bounded capture fact batch is required");
  if(!/^[A-Za-z0-9._:-]{1,179}$/.test(actor.reviewRef??"")||!/^[A-Za-z0-9._:-]{1,179}$/.test(actor.attempt??""))
    throw invalid("A reviewed capture attempt is required");
  const facts=inputs.map(({binding,source})=>legacyAccountCaptureFactFromSource(binding,source))
    .sort((a,b)=>a.accountId<b.accountId?-1:a.accountId>b.accountId?1:0);
  if(new Set(facts.map(f=>f.accountId)).size!==facts.length || new Set(facts.map(f=>f.legacyId)).size!==facts.length
    || new Set(facts.map(f=>f.captureSha256)).size!==1)throw invalid("Captured account batch binding is duplicated");
  const digests=facts.map(f=>legacyAccountCaptureFactDigest(f)), batchDigest=sha256Hex(canonicalize(digests));
  const operation="supply.legacy.account_capture_facts", key=`legacy-account-capture-batch-v1:${batchDigest}`;
  const result=await withIdempotency(client,{realm:"admin",principalId:actor.id,operation,resourceId:facts[0]!.captureSha256},key,
    fingerprintRequest(operation,facts[0]!.captureSha256,{batchDigest,facts}),async(replay)=>{
      const access=await loadEffectiveAdminAccess(client,actor.id); requirePermission(access,"supply.catalog.manage");
      const rows=(await client.query(`SELECT a.id,a.game_id,h.legacy_id,h.observation_version_id,h.source_digest,h.source_updated_at,
          d.display_digest,c.evidence_digest FROM zzsh_supply.rental_account a
        JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=a.id
        JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=a.id AND d.schema_version=1
        LEFT JOIN zzsh_supply.legacy_listing_capture_fact c ON c.account_id=a.id
        WHERE a.id=ANY($1::text[]) ORDER BY a.id COLLATE "C" FOR UPDATE OF a`,[facts.map(f=>f.accountId)])).rows;
      if(rows.length!==facts.length)throw conflict("Captured account batch targets changed");
      const games=new Set<string>();
      for(let i=0;i<facts.length;i++){
        const f=facts[i]!,r=rows[i]!; games.add(r.game_id);
        if(r.id!==f.accountId||r.legacy_id!==f.legacyId||r.observation_version_id!==f.observationVersionId
          ||r.source_digest!==f.baseSourceDigest||r.display_digest!==f.displayDigest
          ||!(r.source_updated_at instanceof Date)||r.source_updated_at.toISOString()!==f.sourceUpdatedAt
          ||r.evidence_digest!=null&&r.evidence_digest!==digests[i] || replay && r.evidence_digest!==digests[i])throw conflict("Captured account batch source or prior fact changed");
      }
      for(const gameId of games)await assertGameScope(client,actor.id,access!.isBoss,gameId);
    },async()=>{
      const existing=(await client.query('SELECT account_id,evidence_digest FROM zzsh_supply.legacy_listing_capture_fact WHERE account_id=ANY($1::text[])',[facts.map(f=>f.accountId)])).rows;
      const present=new Map(existing.map(row=>[row.account_id,row.evidence_digest]));
      const fresh=facts.flatMap((fact,i)=>{
        if(present.has(fact.accountId)){if(present.get(fact.accountId)!==digests[i])throw conflict("Captured account fact is immutable");return [];}
        return [{account_id:fact.accountId,observation_version_id:fact.observationVersionId,base_source_digest:fact.baseSourceDigest,
          display_digest:fact.displayDigest,capture_sha256:fact.captureSha256,source_updated_at:fact.sourceUpdatedAt,
          base_ratio_wan_per_yuan:fact.sourceAccountBaseRatioWanPerYuan,ratio_issue:fact.ratioIssue,
          full_payout_selected:fact.sourceAccountFullPayoutSelected,payout_issue:fact.payoutIssue,evidence_digest:digests[i]}];
      });
      if(fresh.length){
        await client.query(`INSERT INTO zzsh_supply.legacy_listing_capture_fact(account_id,observation_version_id,base_source_digest,
          display_digest,capture_sha256,source_updated_at,base_ratio_wan_per_yuan,ratio_issue,full_payout_selected,payout_issue,evidence_digest,created_by_admin_id)
          SELECT x.account_id,x.observation_version_id,x.base_source_digest,x.display_digest,x.capture_sha256,x.source_updated_at,
            x.base_ratio_wan_per_yuan,x.ratio_issue,x.full_payout_selected,x.payout_issue,x.evidence_digest,$2
          FROM jsonb_to_recordset($1::jsonb) x(account_id text,observation_version_id text,base_source_digest text,display_digest text,
            capture_sha256 text,source_updated_at timestamptz,base_ratio_wan_per_yuan text,ratio_issue text,full_payout_selected boolean,payout_issue text,evidence_digest text)
          ORDER BY x.account_id`,[JSON.stringify(fresh),actor.id]);
        await recordAudit(client,{actorType:"admin",actorId:actor.id,sessionId:actor.sessionId,requestId:actor.requestId,
          action:operation,objectType:"legacy_account_capture_batch",objectId:batchDigest,outcome:"SUCCESS",
          reason:"批量补充旧账号采集时展示事实，不改变原快照、订单或发布报价",
          details:{captureSha256:facts[0]!.captureSha256,batchDigest,count:facts.length,created:fresh.length,
            approvalRef:actor.reviewRef,attempt:actor.attempt,financialEffects:false}});
      }
      return {status:200,body:{batchDigest,count:facts.length,created:fresh.length}};
    });
  return {...result.body as {batchDigest:string;count:number;created:number},replayed:result.replayed};
}
