import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readLfLines } from './local-source-adapter.mjs';

const PACK_SIZE = 1000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packName = index => 'packages/' + String(index + 1).padStart(5, '0') + '.bin';

/** A copied database can retain its OID and nonce on a different PostgreSQL instance. */
export function sameGrowthInstance(a, b) {
  return Boolean(a && b && a.host === '127.0.0.1' && a.host === b.host
    && Number.isInteger(a.port) && a.port > 0 && a.port < 65536 && a.port === b.port
    && /^[0-9]+$/.test(a.systemIdentifier ?? '') && a.systemIdentifier === b.systemIdentifier);
}

/** Preserve the prior execution key and target when checking a stopped attempt. */
export function assertGrowthPriorAttempt(prior, { mode, plan, target, actorId, manifestSha256, index, packed }) {
  assert(mode === 'CONTINUE' || mode === 'RECOVER', 'GROWTH_PRIOR_MODE_INVALID');
  const fail = mode === 'CONTINUE' ? 'KNOWN_ORIGINAL_ROLLBACK_REQUIRED_TO_CONTINUE' : 'ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED';
  assert(Array.isArray(plan?.packages) && prior?.actorId === actorId && prior.manifestSha256 === manifestSha256
    && prior.oid === target.oid && prior.nonce === target.nonce && (prior.migrationProfile ?? null) === (target.migrationProfile ?? null)
    && (!packed || sameGrowthInstance(prior.instance, target.instance)
      && prior.poolClosed === true && prior.unlockAck === true && prior.lockClosed === true), fail);
  if (mode === 'CONTINUE') {
    assert(prior.status === 'NOT_COMMITTED_STOPPED' && prior.error?.rollbackAcknowledged === true
      && Number.isSafeInteger(prior.completed) && prior.completed >= 0 && prior.completed < plan.packages.length, fail);
    const original = plan.packages[prior.completed];
    assert(prior.pending?.index === prior.completed + 1 && prior.pending.executionKey === original.executionKey
      && prior.pending.businessPackageSha256 === original.sha256, 'CONTINUATION_ORIGINAL_PACKAGE_CHANGED');
    return;
  }
  assert(Number.isSafeInteger(index) && index >= 1 && index <= plan.packages.length
    && (prior.status === 'COMMIT_UNKNOWN_STOPPED' || prior.status === 'COMMIT_ACK_READBACK_REQUIRED' && prior.pending?.commitAck === true)
    && prior.pending?.index === index && prior.pending.executionKey === plan.packages[index - 1].executionKey
    && (!packed || prior.pending.businessPackageSha256 === plan.packages[index - 1].sha256
      && /^[a-f0-9]{64}$/.test(prior.pending.businessFingerprint ?? '')), fail);
}

/** The intent must be durable before a user transaction can be attempted. */
export async function executeGrowthEntry({ pending, recovery, writeIntent, execute, writeResult }) {
  await writeIntent();
  const reply = await execute();
  if (!recovery) pending.commitAck = true;
  await writeResult(reply);
  return reply;
}

/** Every pending subject must remain UNKNOWN through the official batch reader. */
export async function verifyPendingGrowthReadback(client, userIds, asOf, readBatch) {
  assert(Array.isArray(userIds) && userIds.length > 0 && userIds.length <= 500 && new Set(userIds).size === userIds.length
    && userIds.every(id => typeof id === "string" && id) && typeof readBatch === "function", "GROWTH_PENDING_BATCH_INVALID");
  const responses = await readBatch(client, userIds, asOf);
  assert(responses instanceof Map && responses.size === userIds.length, "GROWTH_PENDING_READER_INCOMPLETE");
  for (const id of userIds) {
    const response = responses.get(id);
    assert(response?.subjectId === id && response.growth?.knowledge === "UNKNOWN" && response.growth.rollingPoints === null, "GROWTH_PENDING_READER_MISMATCH");
  }
}

/** The original approval bytes live in the same flushed intent as their execution key. */
export function inlineGrowthIntent(pending, approvalBytes) {
  assert(Buffer.isBuffer(approvalBytes) && sha(approvalBytes) === pending?.approvalSha256, 'GROWTH_INLINE_APPROVAL_CHANGED');
  return { event: 'INTENT', ...pending, approvalBytesBase64: approvalBytes.toString('base64') };
}

export function syncInlineGrowthLog(file) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'GROWTH_INLINE_LOG_INVALID');
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export async function digestInlineGrowthLog(file) {
  const before = lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink(), 'GROWTH_INLINE_LOG_INVALID');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  const after = lstatSync(file);
  assert(after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'GROWTH_INLINE_LOG_CHANGED');
  return digest.digest('hex');
}

/** Verify the complete private log without treating an unfinished intent as a committed write. */
export async function verifyInlineGrowthLog(file, { packages, startIndex, approvalBytesFor }) {
  assert(Array.isArray(packages) && Number.isSafeInteger(startIndex) && startIndex >= 0 && startIndex <= packages.length
    && typeof approvalBytesFor === 'function', 'GROWTH_INLINE_LOG_INVALID');
  const before = lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink(), 'GROWTH_INLINE_LOG_INVALID');
  const digest = createHash('sha256'); let lastByte = -1, index = startIndex, pending = null, lines = 0;
  for await (const line of readLfLines(createReadStream(file), bytes => { digest.update(bytes); if (bytes.length) lastByte = bytes[bytes.length - 1]; })) {
    let event; try { event = JSON.parse(line); } catch { throw new Error('GROWTH_INLINE_LOG_INVALID'); }
    const item = packages[index]; assert(item && event?.index === index + 1 && event.executionKey === item.executionKey
      && event.businessPackageSha256 === item.sha256 && /^[a-f0-9]{64}$/.test(event.businessFingerprint ?? '')
      && /^[a-f0-9]{64}$/.test(event.approvalSha256 ?? ''), 'GROWTH_INLINE_LOG_INVALID');
    if (!pending) {
      assert(event.event === 'INTENT' && typeof event.approvalBytesBase64 === 'string' && event.commitAck === undefined, 'GROWTH_INLINE_LOG_INVALID');
      const bytes = Buffer.from(event.approvalBytesBase64, 'base64'), expected = approvalBytesFor(item);
      assert(Buffer.isBuffer(expected) && bytes.toString('base64') === event.approvalBytesBase64
        && bytes.equals(expected) && sha(bytes) === event.approvalSha256, 'GROWTH_INLINE_APPROVAL_CHANGED');
      let approval; try { approval = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('GROWTH_INLINE_APPROVAL_CHANGED'); }
      pending = { event, approval };
    } else {
      const receipt = event.reply?.receipt;
      assert(event.event === 'COMMIT_ACK' && event.commitAck === true && event.approvalBytesBase64 === undefined
        && event.approvalSha256 === pending.event.approvalSha256 && event.businessFingerprint === pending.event.businessFingerprint
        && receipt?.coverageFingerprint === item.coverageFingerprint && receipt.coverageState === item.coverageState
        && receipt.subjectUserId === item.userId && receipt.executionKey === item.executionKey
        && receipt.businessFingerprint === pending.event.businessFingerprint && receipt.businessPackageSha256 === item.sha256
        && receipt.execution?.approvalRef === pending.approval.approvalRef && receipt.execution?.attempt === pending.approval.attempt
        && receipt.inserted === item.contributionCount && receipt.replayed === 0 && event.reply.replayed === false, 'GROWTH_INLINE_LOG_INVALID');
      pending = null; index++;
    }
    lines++;
  }
  assert(pending === null && index === packages.length && lines === (packages.length - startIndex) * 2
    && (lines ? lastByte === 10 : before.size === 0), 'GROWTH_INLINE_LOG_INCOMPLETE');
  const firstHash = digest.digest('hex'), second = createHash('sha256');
  for await (const bytes of createReadStream(file)) second.update(bytes);
  const after = lstatSync(file);
  assert(after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && second.digest('hex') === firstHash, 'GROWTH_INLINE_LOG_CHANGED');
  return { status: 'INLINE_INTENTS_AND_ACKS_VERIFIED', startIndex, completed: index - startIndex, lines, sha256: firstHash };
}

export function growthFailureStatus(error, pending, allCommitsAcknowledged = false) {
  if (allCommitsAcknowledged) return 'ALL_COMMITS_ACK_LOG_REVIEW_REQUIRED';
  if (error?.outcome === 'COMMIT_UNKNOWN') return 'COMMIT_UNKNOWN_STOPPED';
  if (pending?.commitAck === true) return 'COMMIT_ACK_READBACK_REQUIRED';
  if (error?.outcome === 'NOT_COMMITTED') return 'NOT_COMMITTED_STOPPED';
  return 'STOPPED_PRESERVE_ORIGINAL_EVIDENCE';
}

export function growthRecoveryStatus(state) {
  return state === 'FOUND' ? 'RECOVERED_READ_ONLY' : 'RECOVERY_READBACK_REVIEW_REQUIRED';
}

/** Aggregate query purposes without recording SQL, parameters or user identifiers. */
export function growthQueryCategory(query) {
  const sql = typeof query === 'string' ? query : query?.text;
  if (typeof sql !== 'string') return 'OTHER';
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)(\s|;|$)/i.test(sql)) return 'TRANSACTION';
  if (/idempotency_record|pg_advisory_xact_lock/i.test(sql)) return 'IDEMPOTENCY';
  if (/credit-init-window|credit-init-resource|legacy-growth-maintenance-owner|zzsh_auth_admin|admin_security|admin_user_role|admin_role_permission/i.test(sql)) return 'AUTHORIZATION';
  if (/membership_growth_legacy_coverage/i.test(sql)) return 'COVERAGE';
  if (/membership_growth_contribution/i.test(sql)) return 'CONTRIBUTION';
  if (/audit_event|audit_context|set_config/i.test(sql)) return 'AUDIT';
  if (/pg_control_system|current_database\s*\(|zzsh\.regression_run/i.test(sql)) return 'TARGET_CHECK';
  return 'OTHER';
}

/** Keep each original package byte-for-byte while reducing filesystem entries. */
export function writeGrowthPackagePacks(directory, items) {
  assert(Array.isArray(items), 'GROWTH_PACK_INPUT_INVALID');
  mkdirSync(join(directory, 'packages'));
  const packs = [], packages = [];
  for (let start = 0; start < items.length; start += PACK_SIZE) {
    const file = packName(packs.length), fd = openSync(join(directory, file), 'wx', 0o600), digest = createHash('sha256');
    let offset = 0;
    try {
      for (const item of items.slice(start, start + PACK_SIZE)) {
        const bytes = Buffer.from(item.bytes, 'utf8');
        assert(bytes.length > 0 && sha(bytes) === item.sha256, 'GROWTH_PACK_PACKAGE_CHANGED');
        let written = 0;
        while (written < bytes.length) {
          const count = writeSync(fd, bytes, written, bytes.length - written);
          assert(count > 0, 'GROWTH_PACK_WRITE_FAILED'); written += count;
        }
        digest.update(bytes);
        packages.push({ file, offset, length: bytes.length, userId: item.userId, sha256: item.sha256, executionKey: item.executionKey,
          coverageState: item.prepared.coverageState, coverageFingerprint: item.prepared.fingerprint,
          contributionCount: item.prepared.rows.length, projection: item.projection });
        offset += bytes.length; assert(Number.isSafeInteger(offset), 'GROWTH_PACK_TOO_LARGE');
      }
      fsyncSync(fd);
      assert.equal(fstatSync(fd).size, offset, 'GROWTH_PACK_SIZE_CHANGED');
    } finally { closeSync(fd); }
    packs.push({ file, bytes: offset, count: Math.min(PACK_SIZE, items.length - start), sha256: digest.digest('hex') });
  }
  return { packs, packages };
}

/** A pack may contain neither gaps, overlaps, hidden bytes nor unreferenced records. */
export function validateGrowthPackageLayout(plan) {
  assert(plan?.schema === 'zzsh.local-growth-round-plan.v2' && Array.isArray(plan.packages) && Array.isArray(plan.packs)
    && plan.packs.length === Math.ceil(plan.packages.length / PACK_SIZE), 'GROWTH_PACK_LAYOUT_INVALID');
  for (let index = 0; index < plan.packs.length; index++) {
    const pack = plan.packs[index], items = plan.packages.slice(index * PACK_SIZE, (index + 1) * PACK_SIZE);
    assert(pack?.file === packName(index) && pack.count === items.length && Number.isSafeInteger(pack.bytes) && pack.bytes > 0
      && /^[a-f0-9]{64}$/.test(pack.sha256 ?? ''), 'GROWTH_PACK_LAYOUT_INVALID');
    let offset = 0;
    for (const item of items) {
      assert(item?.file === pack.file && item.offset === offset && Number.isSafeInteger(item.length) && item.length > 0
        && /^[a-f0-9]{64}$/.test(item.sha256 ?? ''), 'GROWTH_PACK_LAYOUT_INVALID');
      offset += item.length; assert(Number.isSafeInteger(offset), 'GROWTH_PACK_LAYOUT_INVALID');
    }
    assert.equal(offset, pack.bytes, 'GROWTH_PACK_LAYOUT_INVALID');
  }
  return true;
}

/** A direct apply has the same per-user uniqueness and digest checks as the round runner. */
export function validateGrowthPackageEntries(plan) {
  assert(['zzsh.local-growth-round-plan.v1','zzsh.local-growth-round-plan.v2'].includes(plan?.schema)&&Array.isArray(plan.packages),'GROWTH_PACKAGE_ENTRIES_INVALID');
  if(plan.schema==='zzsh.local-growth-round-plan.v2')validateGrowthPackageLayout(plan);
  const users=new Set(),keys=new Set();
  for(const [index,item] of plan.packages.entries()){
    assert(item&&(plan.schema!=='zzsh.local-growth-round-plan.v1'||item.file==='packages/'+String(index+1).padStart(5,'0')+'.json')
      &&typeof item.userId==='string'&&item.userId&&typeof item.executionKey==='string'&&item.executionKey
      &&/^[a-f0-9]{64}$/.test(item.sha256??'')&&/^[a-f0-9]{64}$/.test(item.coverageFingerprint??'')
      &&['COMPLETE','BACKFILL_PENDING'].includes(item.coverageState)&&Number.isSafeInteger(item.contributionCount)&&item.contributionCount>=0
      &&!users.has(item.userId)&&!keys.has(item.executionKey),'GROWTH_PACKAGE_ENTRIES_INVALID');
    users.add(item.userId);keys.add(item.executionKey);
  }
  return true;
}

/** Reuse a file handle within each pack; the caller supplies its existing private-path guard. */
export function openGrowthPackageReader(plan, safePath) {
  assert(['zzsh.local-growth-round-plan.v1', 'zzsh.local-growth-round-plan.v2'].includes(plan?.schema), 'GROWTH_PACK_SCHEMA_INVALID');
  if (plan.schema === 'zzsh.local-growth-round-plan.v2') validateGrowthPackageLayout(plan);
  assert(typeof safePath === 'function', 'GROWTH_PACK_PATH_GUARD_REQUIRED');
  const packs = new Map((plan.packs ?? []).map(row => [row.file, row]));
  let openFile, fd;
  function close() { if (fd !== undefined) { closeSync(fd); fd = undefined; openFile = undefined; } }
  function read(file, offset, length) {
    if (plan.schema !== 'zzsh.local-growth-round-plan.v2') return readFileSync(safePath(file));
    const pack = packs.get(file);
    assert(pack && Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0 && offset + length <= pack.bytes, 'GROWTH_PACK_READ_INVALID');
    if (openFile !== file) {
      close(); const path = safePath(file), stat = lstatSync(path);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'GROWTH_PACK_FILE_UNSAFE');
      const opened = openSync(path, 'r');
      try { assert.equal(fstatSync(opened).size, pack.bytes, 'GROWTH_PACK_SIZE_CHANGED'); }
      catch (error) { closeSync(opened); throw error; }
      fd = opened; openFile = file;
    }
    const bytes = Buffer.alloc(length); let readBytes = 0;
    while (readBytes < length) {
      const count = readSync(fd, bytes, readBytes, length - readBytes, offset + readBytes);
      assert(count > 0, 'GROWTH_PACK_TRUNCATED'); readBytes += count;
    }
    return bytes;
  }
  return { read, close };
}

/** Check every original package and each complete pack before any write begins. */
export function verifyGrowthPackageBytes(plan, read) {
  const packed = plan.schema === 'zzsh.local-growth-round-plan.v2';
  if (packed) validateGrowthPackageLayout(plan);
  let digest, file, index = 0;
  for (const item of plan.packages) {
    if (packed && file !== item.file) {
      if (digest) assert.equal(digest.digest('hex'), plan.packs[index++].sha256, 'GROWTH_PACK_SHA_MISMATCH');
      file = item.file; digest = createHash('sha256');
    }
    const bytes = read(item.file, item.offset, item.length);
    assert.equal(sha(bytes), item.sha256, 'ROUND_GROWTH_PACKAGE_SHA_MISMATCH');
    if (packed) digest.update(bytes);
  }
  if (digest) assert.equal(digest.digest('hex'), plan.packs[index].sha256, 'GROWTH_PACK_SHA_MISMATCH');
}
