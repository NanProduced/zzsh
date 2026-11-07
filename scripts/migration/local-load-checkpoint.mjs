import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

export const strictRoundReservation = "ROUND04_BOOTSTRAP_RESERVED";
// One list for every entry point: a round is strict only if it was registered under one of these.
export const strictRoundReservations = Object.freeze([strictRoundReservation, "ROUND05_BOOTSTRAP_RESERVED", "ROUND06_BOOTSTRAP_RESERVED", "ROUND07_BOOTSTRAP_RESERVED"]);
export const isStrictRoundReservation = status => strictRoundReservations.includes(status);

export function matchesLoadReservation(reservation, { datasetSha256, oid, nonce }) {
  return reservation?.manifestSha256 === datasetSha256 && reservation.epoch?.oid === oid && reservation.epoch?.nonce === nonce;
}

const attemptName = sequence => "round-attempt-" + String(sequence).padStart(6, "0");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Only a round's original receipt or one of its uniquely numbered attempts can be its receipt. */
export function isRoundReceiptPath(out, file) {
  const root = resolve(out).toLowerCase(), candidate = resolve(file).toLowerCase();
  if (candidate === join(root, "round-receipt.json").toLowerCase()) return true;
  const remainder = relative(root, candidate).replaceAll("\\", "/");
  return !isAbsolute(remainder) && /^round-attempt-\d{6}\/round-receipt\.json$/.test(remainder)
    && !remainder.startsWith("round-attempt-000000/");
}

/** Recover only the most recent stopped attempt, while leaving all older receipts untouched. */
export function inspectRoundResumeOutput(out, inputSha256, { allowGrowthContinuation = false } = {}) {
  if (!fs.existsSync(out)) return null;
  const fail = () => { throw new Error("PRESERVE_ORIGINAL_ROUND_OUTPUT"); };
  const root = fs.lstatSync(out);
  if (root.isSymbolicLink() || !root.isDirectory()) fail();
  const names = fs.readdirSync(out).filter(name => name.startsWith("round-attempt-"));
  if (names.some(name => !/^round-attempt-\d{6}$/.test(name))) fail();
  names.sort();
  let previous;
  const stageNames = [];
  const readReceipt = file => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail();
    const bytes = fs.readFileSync(file), value = JSON.parse(bytes);
    if (value?.schema !== "zzsh.local-round-receipt.v1" || value.inputSha256 !== inputSha256
      || !Array.isArray(value.stages) || value.stages.some(stage => !stage || typeof stage.name !== "string" || !stage.name)) fail();
    stageNames.push(...value.stages.map(stage => stage.name));
    return { path: file, sha256: digest(bytes), value };
  };
  try {
    previous = readReceipt(join(out, "round-receipt.json"));
    for (let index = 0; index < names.length; index++) {
      if (names[index] !== attemptName(index + 1)) fail();
      if (previous.value.status !== "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS") fail();
      const directory = join(out, names[index]), stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
      const current = readReceipt(join(directory, "round-receipt.json"));
      const prior = current.value.sameDirectoryResume;
      if (prior?.sequence !== index + 1 || prior.previousReceipt?.path !== previous.path
        || prior.previousReceipt?.sha256 !== previous.sha256) fail();
      previous = current;
    }
    if (previous.value.status !== "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS"
      && !(allowGrowthContinuation && previous.value.status === "INCOMPLETE_GROWTH_NOT_PLANNED")) fail();
    const checkpoint = fs.lstatSync(join(out, "loader", "checkpoint.json"));
    if (checkpoint.isSymbolicLink() || !checkpoint.isFile()) fail();
  } catch { fail(); }
  return { sequence: names.length + 1, previousReceipt: { path: previous.path, sha256: previous.sha256 }, stageNames };
}

/** Later steps own fresh-only output paths and cannot safely be replayed into the same directory. */
export function assertSameDirectoryResumeSafe(resume, artifactPresent) {
  const resumableStages = new Set(["core-and-funds", "display", "opening", "holdings"]);
  if (!Array.isArray(resume?.stageNames) || resume.stageNames.some(name => !resumableStages.has(name))) {
    throw new Error("ROUND_SAME_OUTPUT_STAGE_REQUIRES_SEPARATE_RECOVERY");
  }
  for (const name of ["path-execution", "readback.json", "growth-plan", "growth-execution", "growth-readback", "readback-final.json"]) {
    if (artifactPresent(name)) throw new Error("ROUND_SAME_OUTPUT_ARTIFACT_REQUIRES_SEPARATE_RECOVERY:" + name);
  }
}

/** mkdir is the attempt claim: a race or incomplete prior attempt cannot be silently reused. */
export function reserveRoundResumeOutput(out, resume) {
  if (!Number.isSafeInteger(resume?.sequence) || resume.sequence < 1 || resume.sequence > 999999) throw new Error("ROUND_ATTEMPT_INVALID");
  const directory = join(out, attemptName(resume.sequence));
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}

// A stale staging file must not hide the original write error or block recovery.
export function writeLoadCheckpoint(file, value) {
  const temporary = file + "." + randomUUID() + ".new";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (error) {
      if (attempt < 3 && ["EACCES", "EPERM", "EBUSY"].includes(error.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        continue;
      }
      error.checkpointTemporaryFile = temporary;
      throw error;
    }
  }
}
