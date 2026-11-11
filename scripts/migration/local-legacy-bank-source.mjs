import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mysqlDumpTuples } from "./verify-legacy-listed-policy-dump.mjs";
import { assertCapturedSourceOrigin, readLfLines, readVerifiedSourceRows } from "./local-source-adapter.mjs";
import { verifyBoundMysqlSource } from "./prepare-local-mysql-source.mjs";

const sources = new WeakMap();
const selections = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw Error("LEGACY_BANK_SOURCE_VERIFICATION_FAILED"); };

function checkedPath(value, root) {
  if (typeof value !== "string" || !isAbsolute(value)) fail();
  const file = resolve(value), rel = relative(resolve(root), file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail();
  for (let p = file; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) fail();
  return file;
}
function document(path, expected) {
  if (!hex(expected)) fail();
  const bytes = readFileSync(path); if (sha(bytes) !== expected) fail();
  try { return JSON.parse(bytes); } catch { return fail(); }
}
async function fileHash(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
function rowDigest(row, salt) {
  const [userId, name, card, created, updated] = row, pad = (value, width) => String(value).padStart(width, "0");
  if (!/^[1-9][0-9]{0,23}$/.test(userId) || !/^[0-9]{1,12}$/.test(created) || !/^[0-9]{1,12}$/.test(updated)) fail();
  return sha(salt + pad(userId, 24) + pad(Buffer.byteLength(name), 6) + name + pad(Buffer.byteLength(card), 6) + card + pad(created, 16) + pad(updated, 16));
}
/** The salted aggregate is only a transient equality check; it is not stored as a public source fingerprint. */
export function legacyBankPrivateComparisonDigest(rows, salt) {
  if (!Array.isArray(rows) || !/^[a-f0-9]{64}$/.test(salt ?? "")) fail();
  const hashes = rows.map(row => ({ id: row.user_id, digest: rowDigest([row.user_id, row.name, row.card_no, row.create_time, row.update_time], salt) }));
  hashes.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  if (hashes.some((row, i) => i > 0 && hashes[i - 1].id === row.id)) fail();
  return sha(hashes.map(row => row.digest).join(""));
}

/** Only salted hashes cross the MySQL client boundary; every line is consumed before accepting the snapshot. */
export async function verifyLegacyBankSnapshotLines(lines, expectedCount, expectedDigest, origin=null) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || !hex(expectedDigest)) fail();
  const digest = createHash("sha256"); let phase = "identity", count = 0;
  for await (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (phase === "identity") {
      let identity; try { identity = JSON.parse(line); } catch { return fail(); }
      if (identity?.phase !== "identity" || identity.database !== "sg_zzsh_restore" || identity.principal !== "root@localhost"
        || identity.readOnly !== 1 || identity.isolation !== "REPEATABLE-READ" || identity.accessMode !== "READ ONLY" || identity.txState !== "ACTIVE") fail();
      if(origin&&(identity.serverUuid!==origin.serverUuid||identity.globalReadOnly!==1||identity.superReadOnly!==1||identity.eventScheduler!=="DISABLED"))fail();
      phase = "bank"; continue;
    }
    if (phase === "bank" && /^B:[a-f0-9]{64}$/.test(line)) {
      if (++count > expectedCount) fail(); digest.update(line.slice(2)); continue;
    }
    if (phase !== "bank") fail();
    let terminal; try { terminal = JSON.parse(line); } catch { return fail(); }
    if (terminal?.phase !== "rollback") fail(); phase = "closed";
  }
  if (phase !== "closed" || count !== expectedCount || digest.digest("hex") !== expectedDigest) fail();
}

export function legacyBankSnapshotQuery(salt, next=false) {
  if (!/^[a-f0-9]{64}$/.test(salt ?? "")) fail();
  return `SET SESSION transaction_read_only=1; SET SESSION transaction_isolation='REPEATABLE-READ'; SET SESSION max_execution_time=60000; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;
SELECT JSON_OBJECT('phase','identity','database',DATABASE(),'principal',CURRENT_USER(),'readOnly',@@transaction_read_only,'isolation',@@transaction_isolation,'accessMode',(SELECT ACCESS_MODE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID()),'txState',(SELECT STATE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID())${next?",'serverUuid',@@server_uuid,'globalReadOnly',@@global.read_only,'superReadOnly',@@global.super_read_only,'eventScheduler',@@global.event_scheduler":""});
SELECT CONCAT('B:',SHA2(CONCAT('${salt}',LPAD(CAST(user_id AS CHAR),24,'0'),LPAD(OCTET_LENGTH(name),6,'0'),name,LPAD(OCTET_LENGTH(card_no),6,'0'),card_no,LPAD(CAST(create_time AS CHAR),16,'0'),LPAD(CAST(update_time AS CHAR),16,'0')),256)) FROM la_user_bank ORDER BY user_id;
ROLLBACK; SELECT JSON_OBJECT('phase','rollback');`;
}

/** The caller must first bind this exact container ID to the sealed source receipt. */
export async function verifyLegacyBankMysqlSnapshot(containerId, salt, expectedCount, expectedDigest, origin=null) {
  if (!/^[a-f0-9]{64}$/.test(containerId ?? "")) fail();
  if(origin&&(origin.containerId!==containerId||origin.clientFile!=="/run/zzsh-source/client.cnf"||typeof origin.serverUuid!=="string"))fail();
  const sql = legacyBankSnapshotQuery(salt,Boolean(origin)), child = spawn("docker", ["exec", "-i", containerId, "mysql", "--defaults-extra-file="+(origin?.clientFile??"/root/.my.cnf"), "--user=root", "--protocol=SOCKET",
    "--skip-reconnect", "--local-infile=0", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names", "--unbuffered", "sg_zzsh_restore"],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolveClose => { child.once("error", error => resolveClose({ error: error.code })); child.once("close", (code, signal) => resolveClose({ code, signal })); });
  let inputError = false, verificationError = false, timedOut = false;
  child.stdin.once("error", () => { inputError = true; }); child.stderr.resume();
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 70000);
  try {
    child.stdin.end(sql);
    await verifyLegacyBankSnapshotLines(readLfLines(child.stdout), expectedCount, expectedDigest,origin);
  } catch { verificationError = true; child.kill(); }
  const result = await closed; clearTimeout(timeout);
  if (verificationError || inputError || timedOut || result.error || result.code !== 0 || result.signal) fail();
}

/** Read and compare the exact bound dump with one read-only restore snapshot. Private values remain in memory only. */
export async function captureBoundLegacyBankSource(input, canonicalize) {
  try {
    if (!input || typeof canonicalize !== "function") fail();
    const sourceRoot = "E:/zzsh-local-state/restricted", sourceDir = checkedPath(input.sourceDir, sourceRoot);
    const receiptFile = checkedPath(resolve(sourceDir, "receipt.json"), sourceRoot), receipt = document(receiptFile, input.sourceReceiptSha256);
    let bindingPath;try{bindingPath=checkedPath(input.sourceBinding,"D:/CodexWorktrees");}catch{bindingPath=checkedPath(input.sourceBinding,sourceRoot);}
    const binding = document(bindingPath, input.sourceBindingSha256);
    if (receipt.status !== "CAPTURED_READ_ONLY" || !receipt.rollbackConfirmed || !receipt.clientClosed || receipt.database !== "sg_zzsh_restore"
      || !/^[a-f0-9]{64}$/.test(receipt.containerId ?? "") || binding.container?.id !== receipt.containerId
      || !hex(binding.restoreRecord?.dumpSha256) || !Number.isFinite(Date.parse(binding.restoreRecord?.cutoff ?? ""))) fail();
    const next=binding.schema==="zzsh.local-source-origin.v2";if(next)assertCapturedSourceOrigin(receipt,binding,input.sourceBindingSha256);
    let dump;try{dump=checkedPath(binding.restoreRecord.dumpPath,"E:/zzsh/.archive");}catch{if(!next)fail();dump=checkedPath(binding.restoreRecord.dumpPath,sourceRoot);}
    const userFile = receipt.files?.users;
    if (!userFile || userFile.file !== basename(userFile.file) || !hex(userFile.sha256)) fail();
    const usersPath = checkedPath(resolve(sourceDir, userFile.file), sourceRoot);
    const userDigests = new Map();
    await readVerifiedSourceRows(usersPath, userFile, row => {
      if (!/^[1-9][0-9]{0,23}$/.test(row.id ?? "") || userDigests.has(row.id)) fail();
      userDigests.set(row.id, sha(canonicalize(row)));
    });
    if (userDigests.size !== userFile.rows) fail();
    let origin=null;
    if(next)origin=await verifyBoundMysqlSource(bindingPath,input.sourceBindingSha256,receipt.containerId);
    else {const inspected = spawnSync("docker", ["inspect", "--format", "{{.Id}}", "zzsh-mysql-restore"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (inspected.status !== 0 || inspected.stdout.trim() !== receipt.containerId) fail();}
    const salt = randomBytes(32).toString("hex"), rows = [];
    const stream = createReadStream(dump), consumed = createHash("sha256");
    for await (const line of readLfLines(stream, bytes => consumed.update(bytes))) if (line.startsWith("INSERT INTO `la_user_bank` ")) for (const row of mysqlDumpTuples(line)) {
      if (row.length !== 5) fail();
      rows.push({ user_id: row[0], name: row[1], card_no: row[2], create_time: row[3], update_time: row[4] });
    }
    if (consumed.digest("hex") !== binding.restoreRecord.dumpSha256 || await fileHash(dump) !== binding.restoreRecord.dumpSha256) fail();
    const expected = legacyBankPrivateComparisonDigest(rows, salt);
    await verifyLegacyBankMysqlSnapshot(receipt.containerId, salt, rows.length, expected,origin);
    if(next)await verifyBoundMysqlSource(bindingPath,input.sourceBindingSha256,receipt.containerId);
    const token = Object.freeze({ kind: "BOUND_LEGACY_BANK_SOURCE" });
    sources.set(token, { rows, userDigests, source: { sourceReceiptSha256: input.sourceReceiptSha256,
      sourceDumpSha256: binding.restoreRecord.dumpSha256, sourceCutoff: binding.restoreRecord.cutoff } });
    return token;
  } catch { return fail(); }
}

/** Internal transfer only; never serialize this value or include it in receipts. */
export function useBoundLegacyBankSource(token) { const value = sources.get(token); if (!value) fail(); return value; }
export function releaseBoundLegacyBankSource(token) { sources.delete(token); }

/** Only users in the sealed R06 dataset are eligible, even if other legacy users exist at the target. */
export async function captureBoundLegacyBankSelection(manifestPath, manifestSha256) {
  try {
    const root = "E:/zzsh-local-state/restricted", path = checkedPath(manifestPath, root), manifest = document(path, manifestSha256), users = manifest.files?.users;
    if (manifest.status !== "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN" || !hex(manifest.sourceReceiptSha256)
      || !users || users.file !== basename(users.file) || !hex(users.sha256) || !Number.isSafeInteger(users.rows)
      || users.rows !== manifest.domains?.users?.ready) fail();
    const userPath = checkedPath(resolve(dirname(path), users.file), root);
    const selected = new Map();
    await readVerifiedSourceRows(userPath, users, row => {
      if (!/^[1-9][0-9]{0,23}$/.test(row.sourceId ?? "") || !hex(row.sourceDigest) || selected.has(row.sourceId)
        || row.userId !== `user_${sha(JSON.stringify(["legacy-owner", "legacy_mysql_restore", "la_user", row.sourceId])).slice(0, 40)}`) fail();
      selected.set(row.sourceId, row.sourceDigest);
    });
    if (selected.size !== users.rows) fail();
    const token = Object.freeze({ kind: "BOUND_LEGACY_BANK_SELECTION" });
    selections.set(token, { selected, sourceReceiptSha256: manifest.sourceReceiptSha256, datasetSha256: manifestSha256 });
    return token;
  } catch { return fail(); }
}
export function useBoundLegacyBankSelection(token) { const value = selections.get(token); if (!value) fail(); return value; }
export function releaseBoundLegacyBankSelection(token) { selections.delete(token); }
