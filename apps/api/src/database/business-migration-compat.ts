import { createHash } from "node:crypto";

const MIGRATION_0155 = {
  tag: "0155_legacy_rental_distribution_policy", when: "1793730640476",
  lf: "99de6809f28ad8fcc4e1fb16e1d80ed2b616d6085ff075cfcf2ee3fac9db0f61",
  crlf: "794c7f9f5680d1e9d925abb6a5693ab98954e21198cdd6ca0ec45ee4d92f33b0",
} as const;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Only the independently verified historical LF/CRLF pair is interchangeable. */
export function matchesKnown0155LineEndings(tag: string | undefined, when: string, bytes: Buffer, expectedHash: string): boolean {
  const allowed: readonly string[] = [MIGRATION_0155.lf, MIGRATION_0155.crlf];
  if (tag !== MIGRATION_0155.tag || when !== MIGRATION_0155.when || !allowed.includes(expectedHash) || !allowed.includes(sha(bytes))) return false;
  const normalized = bytes.toString("utf8").replace(/\r\n/g, "\n");
  return !normalized.includes("\r") && sha(normalized) === MIGRATION_0155.lf && sha(normalized.replace(/\n/g, "\r\n")) === MIGRATION_0155.crlf;
}
