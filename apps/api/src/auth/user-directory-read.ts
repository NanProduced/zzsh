import type { Pool, PoolClient } from "pg";
import { Client } from "pg";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "./security-core";
import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse } from "./auth-security";

const activeReads = new WeakMap<Pool, number>();
const failure = (status: number, message: string) => new SecurityApiError(status, API_V1_ERROR_CODES.INTERNAL_ERROR, message);
type Events = { once?: (event: string, listener: () => void) => unknown; off?: (event: string, listener: () => void) => unknown };

// Admission precedes SDK/session checks, so a burst cannot fill the shared max10 pool before BEGIN.
export async function withDirectoryRead(
  pool: Pool,
  request: AuthSecurityNodeRequest & Events & { aborted?: boolean },
  response: AuthSecurityNodeResponse & Events & { writableFinished?: boolean; destroyed?: boolean },
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const active = activeReads.get(pool) ?? 0;
  if (active >= 2) throw failure(503, "User directory is busy; retry later");
  activeReads.set(pool, active + 1);
  const controller = new AbortController();
  let disconnected = request.aborted === true || response.destroyed === true;
  const abort = () => { disconnected = true; controller.abort(failure(499, "Request closed")); };
  const close = () => { if (!response.writableFinished) abort(); };
  request.once?.("aborted", abort);
  response.once?.("close", close);
  const timer = setTimeout(() => controller.abort(failure(504, "User directory read deadline exceeded")), 8_000);
  timer.unref();
  try {
    if (disconnected) abort();
    controller.signal.throwIfAborted();
    await action(controller.signal);
  } catch (error) {
    if (!disconnected) throw error;
  } finally {
    clearTimeout(timer);
    request.off?.("aborted", abort);
    response.off?.("close", close);
    activeReads.set(pool, (activeReads.get(pool) ?? 1) - 1);
  }
}

/* Cancelling an in-flight read stops this request's SQL promptly instead of holding the pooled
   backend until the statement budget; a one-shot connection cancels only our own backend's query. */
async function cancelOwnBackendQuery(pool: Pool, backendPid: number): Promise<void> {
  const options = (pool as unknown as { options?: Record<string, unknown> }).options;
  if (typeof options?.host !== "string" || typeof options?.user !== "string") return;
  const killer = new Client({
    host: options.host as string,
    port: options.port as number,
    database: options.database as string,
    user: options.user as string,
    password: options.password as string,
    connectionTimeoutMillis: 2_000,
    application_name: "zzsh-api-directory-cancel",
  });
  try {
    await killer.connect();
    await killer.query("SELECT pg_cancel_backend($1)", [backendPid]);
  } finally {
    await killer.end().catch(() => undefined);
  }
}

// Dedicated to read-only directory routes; the shared writer/COMMIT UNKNOWN transaction stays intact.
export async function withDirectoryReadTransaction<T>(
  pool: Pool,
  signal: AbortSignal,
  action: (client: PoolClient) => Promise<T>,
  retireAfterRead = false,
): Promise<T> {
  signal.throwIfAborted();
  /* Abort while waiting for a lease: the waiter rejects at once; a lease that arrives late is
     retired without ever running this request's work. */
  let waitAborted = false;
  let onAbortWait: () => void = () => undefined;
  const waitAbort = new Promise<never>((_, reject) => {
    onAbortWait = () => { waitAborted = true; reject(signal.reason ?? failure(499, "Request closed")); };
  });
  if (signal.aborted) onAbortWait(); else signal.addEventListener("abort", onAbortWait, { once: true });
  const connect = pool.connect();
  connect.then(late => { if (waitAborted) late.release(true); }, () => undefined);
  let client: PoolClient;
  try { client = await Promise.race([connect, waitAbort]); } // Existing pool acquisition budget remains 2s.
  catch (error) {
    if (waitAborted) throw signal.reason ?? failure(499, "Request closed");
    throw Object.assign(failure(503, "User directory connection unavailable"), { cause: error });
  } finally {
    signal.removeEventListener("abort", onAbortWait);
  }
  let started = false;
  let rollbackAttempted = false;
  let destroy = false;
  let connectionError: Error | undefined;
  let inFlight = 0;
  let cancelIssued = false;
  const onError = (error: Error) => { connectionError ??= error; };
  client.on("error", onError);
  const backendPid = (client as unknown as { processID?: number }).processID ?? null;
  /* A request abort while a statement is in flight cancels that statement on its own backend;
     the cancelled query then rejects with 57014 and the read rolls back on a live connection.
     If the cancel path itself is unavailable, the in-tx statement_timeout still bounds the SQL. */
  const onAbortQuery = () => {
    if (inFlight > 0 && backendPid !== null && !cancelIssued) {
      cancelIssued = true;
      void cancelOwnBackendQuery(pool, backendPid).catch(() => undefined);
    }
  };
  signal.addEventListener("abort", onAbortQuery);
  const guarded = new Proxy(client, { get(target, key) {
    if (key === "query") return (...args: unknown[]) => {
      signal.throwIfAborted();
      if (connectionError) throw connectionError;
      inFlight++;
      try { return Promise.resolve(Reflect.apply(target.query, target, args)).finally(() => { inFlight--; }); }
      catch (error) { inFlight--; throw error; }
    };
    return Reflect.get(target, key, target);
  } });
  try {
    signal.throwIfAborted();
    // Never join or roll back a previous borrower's uncertain transaction.
    if (client.getTransactionStatus() !== "I") throw failure(503, "User directory connection state unavailable");
    // Counts and page/domain projections must describe the same snapshot.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    started = true;
    await client.query("SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','500',true)");
    signal.throwIfAborted();
    const result = await action(guarded);
    signal.throwIfAborted();
    if (connectionError) throw connectionError;
    rollbackAttempted = true;
    await client.query("ROLLBACK");
    started = false;
    return result;
  } catch (error) {
    if (started && !rollbackAttempted) {
      rollbackAttempted = true;
      try { await client.query("ROLLBACK"); }
      catch { destroy = true; }
    } else destroy = true;
    /* An aborted request keeps its own 499/504 reason; the cancelled statement's 57014 is the
       cancellation evidence, not a budget failure. */
    if (signal.aborted) throw signal.reason ?? error;
    if ((error as { code?: string })?.code === "57014") throw failure(504, "User directory SQL budget exceeded");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbortQuery);
    client.off("error", onError);
    // Retire the lease after the heavy transient-allocation ORIGINAL-mode reads: the enlarged backend
    // arena is not resettable by DISCARD/RESET (H evidence), so a reused backend would run the next
    // identical read measurably slower and can cross the 3s statement budget.
    client.release(destroy || connectionError !== undefined || retireAfterRead);
  }
}
