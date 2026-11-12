import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFundsWriterCoverage, createEmptyCoverageSink, EMPTY_COVERAGE_CHUNK_SIZE } from "./local-funds-plan.mjs";
import { importEmptyCoverageChunk, readEmptyCoverageInputs } from "./local-target-finance.mjs";

const entry = (index, domain = "earnings") => ({ sourceId: `subject-${index}:${domain}`, domain, input: { index } });

test("a frozen empty-coverage chunk is rechecked immediately before import", t => {
  const dir=mkdtempSync(join(tmpdir(),"zzsh-empty-coverage-"));t.after(()=>rmSync(dir,{recursive:true}));
  const file=join(dir,"chunk.json"), rows=[entry(1),entry(2)], bytes=JSON.stringify(rows);
  const digest=createHash("sha256").update(bytes).digest("hex"), descriptor={file,rows:rows.length};
  writeFileSync(file,bytes);assert.deepEqual(readEmptyCoverageInputs(descriptor,digest),rows.map(row=>row.input));
  rows[1].input.index=3;writeFileSync(file,JSON.stringify(rows));
  assert.throws(()=>readEmptyCoverageInputs(descriptor,digest),/PREPARED_CHUNK_SHA_CHANGED/);
  assert.throws(()=>readEmptyCoverageInputs(descriptor,undefined),/PREPARED_CHUNK_SHA_CHANGED/);
});

test("the sink chunks at the loader's existing size and keeps source order", () => {
  const seen = [];
  const sink = createEmptyCoverageSink({ onChunk: chunk => seen.push(chunk) });
  for (let i = 0; i < 950; i++) sink.push(entry(i));
  const { chunks, manifest, entries } = sink.finish();
  assert.deepEqual(chunks.map(chunk => chunk.rows), [400, 400, 150]);
  assert.equal(manifest.chunks, 3);
  assert.equal(manifest.rows, 950);
  assert.equal(manifest.chunkSize, EMPTY_COVERAGE_CHUNK_SIZE);
  assert.deepEqual(seen.map(chunk => chunk.rows), [400, 400, 150]);
  // A streamed run must not keep the entries: only the small chunk descriptors survive.
  assert.deepEqual(entries, []);
  assert.equal(seen[0].entries[0].sourceId, "subject-0:earnings");
  assert.equal(seen[2].entries[149].sourceId, "subject-949:earnings");
});

test("chunk digests are order sensitive and reproduce the same manifest", () => {
  const build = order => {
    const sink = createEmptyCoverageSink();
    for (const index of order) sink.push(entry(index));
    return sink.finish();
  };
  const forward = build([0, 1, 2, 3]), backward = build([3, 2, 1, 0]);
  assert.notEqual(forward.manifest.digest, backward.manifest.digest);
  assert.equal(build([0, 1, 2, 3]).manifest.digest, forward.manifest.digest);
});

test("domain counts are recorded per chunk so coverage can be checked without the entries", () => {
  const sink = createEmptyCoverageSink();
  sink.push(entry(0, "earnings"));
  sink.push(entry(1, "withdraws"));
  sink.push(entry(2, "withdraws"));
  const { chunks } = sink.finish();
  assert.deepEqual(chunks[0].domains, { earnings: 1, withdraws: 2 });
});

test("an empty sink produces an empty manifest rather than an undefined chunk", () => {
  const { chunks, manifest, entries } = createEmptyCoverageSink().finish();
  assert.deepEqual(chunks, []);
  assert.deepEqual(entries, []);
  assert.equal(manifest.rows, 0);
  assert.equal(manifest.chunks, 0);
});

test("the coverage assertion accepts the streamed manifest and rejects a changed one", () => {
  const sink = createEmptyCoverageSink();
  for (let i = 0; i < 5; i++) sink.push({ sourceId: `s-${i}:earnings`, domain: "earnings", input: { coverage: { legacyUserId: `s-${i}`, sourceKind: "HISTORICAL_EARNINGS_LOG" } } });
  const { manifest } = sink.finish();
  const plan = {
    history: [], guaranteeHistory: [],
    emptyHistory: [],
    emptyCoverage: manifest,
    summary: { earnings: { selected: 0, planned: 0, writer: 0, coverageSelected: 5, nonemptyCoverage: 0, emptyCoverage: 5, coveragePlanned: 5 }, guarantees: { selected: 0, planned: 0, writer: 0 } },
  };
  const coverage = assertFundsWriterCoverage(plan, [], [], manifest);
  assert.equal(coverage.earnings.coverageWriter, 5);
  assert.throws(() => assertFundsWriterCoverage(plan, [], [], { ...manifest, digest: "f".repeat(64) }), /EMPTY_COVERAGE_SOURCE_SET_CHANGED/);
  assert.throws(() => assertFundsWriterCoverage(plan, [], [], { ...manifest, rows: manifest.rows + 1 }), /EMPTY_COVERAGE_SOURCE_SET_CHANGED/);
});

test("only the next profile selects the compact batch writer",async()=>{
 const calls=[],scope={id:'fixture'};
 const module={bindReviewedEmptyFinanceObservationBatch:async()=>{calls.push('bind');return scope;},
  importReviewedEmptyFinanceObservationBatch:async(_c,_a,_i,s)=>{assert.equal(s,scope);calls.push('legacy');return{body:{created:1}};},
  importReviewedCompactEmptyFinanceObservationBatch:async(_c,_a,_i,s)=>{assert.equal(s,scope);calls.push('compact');return{body:{created:0}};}};
 assert.equal((await importEmptyCoverageChunk(module,{}, {}, [], [],false)).replayed,false);
 assert.equal((await importEmptyCoverageChunk(module,{}, {}, [], [],true)).replayed,true);
 assert.deepEqual(calls,['bind','legacy','bind','compact']);
 await assert.rejects(importEmptyCoverageChunk(module,{}, {}, [], [],undefined),/MIGRATION_PROFILE_FLAG_UNPROVEN/);
});
