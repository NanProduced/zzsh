import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { preflightBoundSourceBatches, readBoundSourceBatches } from "./local-source-adapter.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Exactly the resource shape handed to the guarded opening importer. */
export function openingReviewResource(ctx) {
  return { host: "127.0.0.1", port: Number(ctx.targetPort ?? 55432), database: "zzsh_test_regression",
    oid: Number(ctx.state.binding.oid), owner: ctx.state.resource.owner, marker: ctx.state.resource.marker,
    role: ctx.state.resource.role, roleOid: Number(ctx.state.resource.role_oid),
    ...(ctx.state.binding.migrationProfile ? { migrationProfile: ctx.state.binding.migrationProfile,
      systemIdentifier: ctx.state.binding.instance?.systemIdentifier, nonce: ctx.state.binding.nonce } : {}) };
}

/** Inspect the exact pending batch only; a missing receipt remains UNKNOWN. */
export async function recoverSystemOpeningDomain(ctx){
  const pending=ctx.state?.pending,reviewed=ctx.state?.additiveInputs?.opening;
  if(!pending||pending.domain!=='storedOpening'||pending.receiptMode!=='SYSTEM_OPENING_V1'||reviewed?.receiptMode!=='SYSTEM_OPENING_V1'
    ||!Number.isSafeInteger(pending.start)||pending.start<0||!Number.isSafeInteger(pending.end)||pending.end<=pending.start||pending.end-pending.start>200
    ||!/^[a-f0-9]{64}$/.test(pending.phaseBodyDigest??'')||!/^[a-f0-9]{64}$/.test(pending.fenceEpochSha256??'')
    ||!Array.isArray(reviewed.fenceEpochs)||!reviewed.fenceEpochs.includes(pending.fenceEpochSha256)
    ||!Array.isArray(pending.sourceIds)||pending.sourceIds.length!==pending.end-pending.start
    ||ctx.systemOpening?.receiptMode!=='SYSTEM_OPENING_V1'||typeof ctx.systemOpening.recoverBatch!=='function')throw new Error('ORIGINAL_OPENING_PENDING_REQUIRED');
  const dir=resolve(reviewed.directory??'');
  if(!dir.toLowerCase().startsWith('e:\\zzsh-local-state\\restricted\\')||!/^[a-f0-9]{64}$/.test(reviewed.manifestSha256??''))throw new Error('BOUND_OPENING_PROOF_REQUIRED');
  const bytes=readFileSync(join(dir,'manifest.json'));if(hash(bytes)!==reviewed.manifestSha256)throw new Error('OPENING_PROOF_MANIFEST_SHA_MISMATCH');
  const plan=JSON.parse(bytes);
  if(plan.status!=='REVIEWED_CANDIDATES_TARGET_NOT_RUN'||plan.datasetSha256!==ctx.state.binding.datasetSha256||plan.file!==basename(plan.file)
    ||plan.sha256!==reviewed.sourceFileSha256)throw new Error('OPENING_PROOF_NOT_BOUND');
  const file=join(dir,plan.file),entry={sha256:plan.sha256,rows:plan.stats?.subjects},proof=await preflightBoundSourceBatches(file,entry,200),batch=[];
  let index=0;for await(const row of readBoundSourceBatches(file,entry,proof))if(row.state==='CANDIDATE'){
    if(index>=pending.start&&index<pending.end)batch.push(row);index++;
  }
  const canonical=ctx.mod('supply/content-hash').canonicalize;
  if(batch.length!==pending.end-pending.start||hash(canonical(batch))!==pending.phaseBodyDigest
    ||JSON.stringify(batch.map(row=>row.sourceId))!==JSON.stringify(pending.sourceIds))throw new Error('ORIGINAL_OPENING_PENDING_CHANGED');
  const window={ref:'CORE_FULL_STORED_OPENING_'+ctx.state.binding.oid,attempt:'opening-'+reviewed.manifestSha256.slice(0,16),
    notBefore:reviewed.notBefore,expiresAt:reviewed.expiresAt};
  const result=await ctx.systemOpening.recoverBatch(batch.map(row=>row.input),window);
  const openingPlanCore=ctx.mod('finance/personal-finance-maintenance').openingPlanCore;
  if(!result||!['KNOWN','UNKNOWN'].includes(result.knowledge)||!Array.isArray(result.results)||result.results.length!==batch.length
    ||typeof openingPlanCore!=='function'||result.results.some((row,index)=>!['KNOWN','UNKNOWN'].includes(row.knowledge)
      ||row.subjectId!==batch[index].input.proof.userId||row.key!==openingPlanCore(batch[index].input).key
      ||(row.knowledge==='KNOWN'?row.originalOpeningVerified!==true:row.receipt!==null)))throw new Error('ORIGINAL_OPENING_RECOVERY_INVALID');
  const known=result.results.filter(row=>row.knowledge==='KNOWN').length,unknown=result.results.length-known;
  if((result.knowledge==='KNOWN')!==(unknown===0))throw new Error('ORIGINAL_OPENING_RECOVERY_INVALID');
  return{knowledge:result.knowledge,subjects:batch.length,known,unknown,originalKeysPreserved:true};
}

/** Original stored balances use their independently reviewed economic proofs, never a sum of flows. */
export async function applyOpeningDomain(ctx, directory, manifestSha256) {
  const path = resolve(directory ?? "");
  if (!path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("BOUND_OPENING_PROOF_REQUIRED");
  const bytes = readFileSync(join(path, "manifest.json"));
  if (hash(bytes) !== manifestSha256) throw new Error("OPENING_PROOF_MANIFEST_SHA_MISMATCH");
  const plan = JSON.parse(bytes);
  if (plan.status !== "REVIEWED_CANDIDATES_TARGET_NOT_RUN" || plan.datasetSha256 !== ctx.state.binding.datasetSha256 || plan.file !== basename(plan.file)) throw new Error("OPENING_PROOF_NOT_BOUND");
  const file = join(path, plan.file);
  const entry = {sha256:plan.sha256,rows:plan.stats?.subjects};
  const sourceProof = ctx.isNextMigration === true ? await preflightBoundSourceBatches(file,entry,200) : null;
  if (!sourceProof) {
    const digest = createHash("sha256");for await (const bytes of createReadStream(file)) digest.update(bytes);
    if (digest.digest("hex") !== plan.sha256) throw new Error("OPENING_PROOF_FILE_SHA_MISMATCH");
  }
  ctx.state.additiveInputs ??= {};
  if (ctx.state.additiveInputs.opening?.manifestSha256 && ctx.state.additiveInputs.opening.manifestSha256 !== manifestSha256) throw new Error("OPENING_CHECKPOINT_INPUT_CHANGED");
  const module = ctx.mod("finance/personal-finance-maintenance"), canonical = ctx.mod("supply/content-hash").canonicalize;
  const reviewed = ctx.state.additiveInputs.opening ?? { directory: path, manifestSha256, sourceFileSha256: plan.sha256, ...(ctx.state.executionWindow ?? { notBefore: new Date().toISOString(), expiresAt: new Date(Date.now() + 12 * 3600000).toISOString() }), candidateCount: plan.stats.candidate, isolatedCount: plan.stats.reviewRequired };
  if(ctx.isNextMigration){
    if(!ctx.systemOpening||ctx.systemOpening.receiptMode!=='SYSTEM_OPENING_V1'||typeof ctx.systemOpening.importBatch!=='function'
      ||!/^[a-f0-9]{64}$/.test(ctx.systemOpening.fenceEpochSha256??'')
      ||ctx.state.openingSourcePreflight?.status!=='SOURCE_FINANCIAL_FACTS_VERIFIED')throw new Error('NEXT_SYSTEM_OPENING_SOURCE_REQUIRED');
    if(reviewed.receiptMode!==undefined&&reviewed.receiptMode!=='SYSTEM_OPENING_V1'
      ||reviewed.receiptMode===undefined&&(ctx.state.phases?.storedOpening?.nextIndex??0)>0)throw new Error('OPENING_RECEIPT_MODE_CHANGED');
    reviewed.receiptMode='SYSTEM_OPENING_V1';
    if(reviewed.fenceEpochs!==undefined&&(!Array.isArray(reviewed.fenceEpochs)||reviewed.fenceEpochs.some(value=>!/^[a-f0-9]{64}$/.test(value))))throw new Error('OPENING_FENCE_HISTORY_INVALID');
    reviewed.fenceEpochs=[...new Set([...(reviewed.fenceEpochs??[]),ctx.systemOpening.fenceEpochSha256])];
  }
  ctx.state.additiveInputs.opening = reviewed;
  ctx.save();
  const common = { ref: "CORE_FULL_STORED_OPENING_" + ctx.state.binding.oid, attempt: "opening-" + manifestSha256.slice(0, 16), ...(ctx.isNextMigration ? {} : { actor: { userId: ctx.actor.userId, sessionId: ctx.actor.sessionId } }), resource: openingReviewResource(ctx), notBefore: reviewed.notBefore, expiresAt: reviewed.expiresAt };
  const expected = { subjects: 0, positive: 0, zero: 0, amountCents: 0n, isolated: [] };
  async function* candidates() {
    for await (const row of (sourceProof ? readBoundSourceBatches(file,entry,sourceProof) : ctx.readRows(file))) {
      if (row.state !== "CANDIDATE") { expected.isolated.push({ sourceId: row.sourceId, reason: row.reason }); continue; }
      const value = BigInt(row.input.proof.availableCents);
      expected.subjects++; expected.amountCents += value;
      if (value === 0n) expected.zero++; else expected.positive++;
      yield row;
    }
  }
    await ctx.runBatches("storedOpening", candidates(), async (rows) => {
        const module = ctx.mod("finance/personal-finance-maintenance");
        const inputs = rows.map(row => row.input);
        const reviews = rows.map(row => {
            const input = row.input, proof = input.proof;
            return { ...common, inputSha256: input.inputSha256, cutoff: input.cutoff, bodyDigest: hash(canonical(input)), subject: { userId: proof.userId, sourceId: proof.source.sourceId, identityDigest: proof.source.identityDigest, sourceDigest: proof.sourceDigest, availableCents: proof.availableCents, coveredDigest: proof.coveredDigest }, coveredCount: proof.coveredCount, observationCount: input.observations.length, admissionDigest: hash(canonical(input.admissions)), ...(input.sourceProof ? { sourceProofDigest: hash(canonical(input.sourceProof)) } : {}) };
        });
        try {
            const result=ctx.isNextMigration
              ? await ctx.systemOpening.importBatch(inputs,{ref:common.ref,attempt:common.attempt,notBefore:common.notBefore,expiresAt:common.expiresAt})
              : await module.importReviewedStoredOpeningBatchOn(ctx.client,ctx.actor,inputs,await module.bindReviewedStoredOpeningAdmissionBatch(ctx.client,ctx.actor,reviews));
            if(!Array.isArray(result.outcomes)||result.outcomes.length!==rows.length)throw new Error('OPENING_BATCH_OUTCOMES_INVALID');
            const outcomes=new Map(result.outcomes.map(item=>[item.subjectId,item.replayed]));
            if(outcomes.size!==rows.length||rows.some(row=>typeof outcomes.get(row.input.proof.userId)!=='boolean'))throw new Error('OPENING_BATCH_OUTCOMES_INVALID');
            return rows.map(row=>({replayed:outcomes.get(row.input.proof.userId)}));
        } catch (cause) {
            const error = new Error("TARGET_REVIEWED_OPENING_REJECTED");
            error.code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(cause.code)
              ? cause.code : "TARGET_REVIEWED_OPENING_REJECTED";
            throw error;
        }
    }, 200);
  const actual = (await ctx.client.query("SELECT count(*)::int subjects,count(*) FILTER(WHERE available_cents>0)::int positive,count(*) FILTER(WHERE available_cents=0)::int zero,COALESCE(sum(available_cents),0)::text amount FROM zzsh_order.finance_opening_basis WHERE source_system='legacy_mysql_restore'" + (ctx.openingSubjectIds ? " AND user_id=ANY($1::text[])" : ""), ctx.openingSubjectIds ? [ctx.openingSubjectIds] : [])).rows[0];
  const isolatedAmountsNotZeroed = expected.isolated.length === plan.stats.reviewRequired;
  const phase = ctx.state.phases.storedOpening;
  const report = { expected: { ...expected, amountCents: expected.amountCents.toString() }, actual, flowSum: "NOT_COMPUTED", sourceMoneySeparateNotAdded: true, isolatedAmountsNotZeroed, runtimeQuarantined: phase.quarantined, sourceCutoff: ctx.manifest.sourceCutoff, bankArrivalVerified: false };
  ctx.state.openingReconciliation = report;
  ctx.save();
  if (phase.quarantined || actual.subjects !== expected.subjects || actual.positive !== expected.positive || actual.zero !== expected.zero || actual.amount !== expected.amountCents.toString() || !isolatedAmountsNotZeroed) throw new Error("STORED_OPENING_RECONCILIATION_NOT_COMPLETE");
  // 硬闸门：账本加总必须等于 basis 加总，且 OPENING 条目数 = 2×有余额户数。
  // 这是唯一能挡住“为提速删分录”的自动机制；不满足直接 fail 整轮。
  const conservation = await module.assertOpeningConservation(ctx.client, { amountCents: expected.amountCents.toString(), entryRows: expected.positive * 2 });
  report.conservation = conservation;
  ctx.state.openingReconciliation = report;
  ctx.save();
}
