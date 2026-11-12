import type { PoolClient } from "pg";

/** Scope the source to this bootstrap transaction; the owner-only insert trigger stores it. */
export async function setSystemInitialSource(client: PoolClient, sha256: string | null) {
  if (client.getTransactionStatus() !== "T") throw new Error("System initialization requires a transaction");
  await client.query("SELECT set_config('zzsh.system_initial_sha256',$1,true)", [sha256 ?? ""]);
}
