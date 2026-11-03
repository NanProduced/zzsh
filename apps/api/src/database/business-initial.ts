import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type ChainEntry = { tag: string; when: number; sha256: string };
export type BusinessInitialManifest = {
  format: "zzsh.business-initial.v1";
  baseline: string;
  migrationTag: string;
  migrationHash: string;
  when: number;
  sourceCount: number;
  sourceChain: ChainEntry[];
  parts: { file: string; sha256: string }[];
};
const sha = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const reject = (): never => { throw new Error("BUSINESS_INITIAL_MANIFEST_INVALID"); };
const leaf = (name: string) => typeof name === "string" && name === basename(name) && /^[a-zA-Z0-9_-]+\.(sql|json)$/.test(name);
const docName = (name: string) => typeof name === "string" && name === basename(name) && /^[A-Za-z0-9._-]+\.(md|json)$/.test(name);

/** An installed baseline keeps its own tail. A name is used only for an empty database. */
export function resolveBusinessInitialSelection(registry: { active: string; supported: { name: string; manifest: { migrationHash: string } }[] }, input: { initialInstall: boolean; requestedBaseline?: string; installedHash?: string }) {
  if (!input.initialInstall && !input.installedHash) return { kind: "canonical" as const };
  if (input.installedHash) {
    const installed = registry.supported.find(entry => entry.manifest.migrationHash === input.installedHash);
    if (!installed) return { kind: "not-baseline" as const };
    if (input.requestedBaseline && input.requestedBaseline !== installed.name) return { kind: "conflict" as const, installed: installed.name };
    return { kind: "installed" as const, name: installed.name };
  }
  const name = input.requestedBaseline || registry.active;
  if (!registry.supported.some(entry => entry.name === name)) return { kind: "missing" as const, name };
  return { kind: "selected" as const, name };
}

/** A new default does not rewrite the hash of an already installed older baseline. */
export function readBusinessInitialRegistry(initialRoot: string) {
  const file = join(initialRoot, "registry.json");
  const registry = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { format: string; active: string; supported: string[] }
    : { format: "zzsh.business-initial-registry.v1", active: "release_0141", supported: existsSync(join(initialRoot, "release_0141/manifest.json")) ? ["release_0141"] : [] };
  if (registry.format !== "zzsh.business-initial-registry.v1" || typeof registry.active !== "string" || !Array.isArray(registry.supported)
    || registry.supported.some(name => typeof name !== "string" || !/^release_[a-zA-Z0-9_]{1,60}$/.test(name))
    || new Set(registry.supported).size !== registry.supported.length || registry.supported.length > 0 && !registry.supported.includes(registry.active)) reject();
  const hashes = new Set<string>();
  const supported = registry.supported.map(name => {
    const folder = join(initialRoot, name);
    if (lstatSync(folder).isSymbolicLink()) reject();
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as BusinessInitialManifest;
    if (manifest.format !== "zzsh.business-initial.v1" || manifest.baseline !== name || !/^[a-f0-9]{64}$/.test(manifest.migrationHash) || hashes.has(manifest.migrationHash)) reject();
    hashes.add(manifest.migrationHash);
    return { name, folder, manifest };
  });
  return { active: registry.active, supported };
}

/** A baseline is one honest migration entry, followed by the unchanged canonical tail. */
export function prepareBusinessInitial(canonicalFolder: string, initialFolder: string) {
  const manifest = JSON.parse(readFileSync(join(initialFolder, "manifest.json"), "utf8")) as BusinessInitialManifest;
  const journal = JSON.parse(readFileSync(join(canonicalFolder, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number; breakpoints: boolean; version: string }[] };
  if (manifest.format !== "zzsh.business-initial.v1" || !Number.isSafeInteger(manifest.sourceCount) || manifest.sourceCount < 1 || manifest.sourceCount > journal.entries.length || manifest.sourceChain.length !== manifest.sourceCount || !Array.isArray(manifest.parts) || manifest.parts.length !== 4 || !/^[a-zA-Z0-9_-]+$/.test(manifest.migrationTag)) reject();
  for (const [index, item] of manifest.sourceChain.entries()) {
    const actual = journal.entries[index];
    if (!actual || actual.tag !== item.tag || actual.when !== item.when || !leaf(item.tag + ".sql") || sha(readFileSync(join(canonicalFolder, item.tag + ".sql"))) !== item.sha256) reject();
  }
  if (manifest.when !== manifest.sourceChain.at(-1)?.when) reject();
  const journalSha = (manifest as { journalSha256?: string }).journalSha256;
  const prefixSha = (manifest as { journalPrefixSha256?: string }).journalPrefixSha256;
  if (prefixSha !== undefined && sha(JSON.stringify(journal.entries.slice(0, manifest.sourceCount))) !== prefixSha) reject();
  // Appended canonical entries change the journal bytes; the sealed sourceChain still verifies every covered SQL.
  if (journalSha !== undefined && (!/^[a-f0-9]{64}$/.test(journalSha) || journal.entries.length === manifest.sourceCount
    && sha(readFileSync(join(canonicalFolder, "meta/_journal.json"))) !== journalSha)) reject();
  const names = new Set<string>();
  const parts = manifest.parts.map((part) => {
    if (!leaf(part.file) || names.has(part.file)) reject();
    names.add(part.file);
    const file = join(initialFolder, part.file);
    if (lstatSync(file).isSymbolicLink()) reject();
    const bytes = readFileSync(file);
    if (sha(bytes) !== part.sha256) reject();
    return bytes.toString("utf8");
  });
  const sql = parts.join("\n--> statement-breakpoint\n");
  if (sha(sql) !== manifest.migrationHash) reject();
  const documents = (manifest as { documents?: { file: string; sha256: string }[] }).documents;
  if (documents !== undefined) {
    if (!Array.isArray(documents)) reject();
    const seen = new Set<string>();
    for (const doc of documents) {
      if (!docName(doc.file) || seen.has(doc.file) || !/^[a-f0-9]{64}$/.test(doc.sha256)) reject();
      seen.add(doc.file);
      const file = join(initialFolder, doc.file);
      if (lstatSync(file).isSymbolicLink() || sha(readFileSync(file)) !== doc.sha256) reject();
    }
  }
  const folder = mkdtempSync(join(tmpdir(), "zzsh-business-initial-"));
  const cleanup = () => {
    if (resolve(folder).startsWith(resolve(tmpdir()) + "\\") || resolve(folder).startsWith(resolve(tmpdir()) + "/")) rmSync(folder, { recursive: true, force: false });
  };
  try {
    mkdirSync(join(folder, "meta"));
    writeFileSync(join(folder, manifest.migrationTag + ".sql"), sql, { flag: "wx" });
    const tail = journal.entries.slice(manifest.sourceCount);
    for (const entry of tail) {
      if (!leaf(entry.tag + ".sql") || !Number.isSafeInteger(entry.when) || entry.when <= manifest.when) reject();
      copyFileSync(join(canonicalFolder, entry.tag + ".sql"), join(folder, entry.tag + ".sql"));
    }
    const entries = [{ idx: 0, tag: manifest.migrationTag, when: manifest.when, version: "7", breakpoints: true }, ...tail.map((entry, index) => ({ ...entry, idx: index + 1 }))];
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }), { flag: "wx" });
    return { folder, cleanup, manifest };
  } catch (error) {
    cleanup();
    throw error;
  }
}
