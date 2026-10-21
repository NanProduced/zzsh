import type { Pool, PoolClient } from "pg";
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

// Dedicated to read-only directory routes; the shared writer/COMMIT UNKNOWN transaction stays intact.
export async function withDirectoryReadTransaction<T>(
  pool: Pool,
  signal: AbortSignal,
  action: (client: PoolClient) => Promise<T>,
  retireAfterRead = false,
): Promise<T> {
  signal.throwIfAborted();
  /* Abort while waiting for a lease: the waiter rejects at once. Whether the lease actually
     arrived is decided only by the raced connect promise — a boolean flag cannot stand in for
     the race outcome. A lease that arrives after this request lost the race is retired by the
     side branch; a lease the race delivered is released exactly once by the main finally below. */
  let onAbortWait: () => void = () => undefined;
  const waitAbort = new Promise<never>((_, reject) => {
    onAbortWait = () => reject(signal.reason ?? failure(499, "Request closed"));
  });
  if (signal.aborted) onAbortWait(); else signal.addEventListener("abort", onAbortWait, { once: true });
  const connect = pool.connect();
  let client: PoolClient;
  try {
    /* The race result alone decides lease ownership: a lease the race delivered is released exactly
       once by the main finally below; only when the abort branch won do we retire a late lease. */
    client = await Promise.race([connect, waitAbort]);
  } catch (error) {
    /* The race lost: no lease is held here. If the aborted rejection did not win the race, the
       connect failure keeps its own 503 with the cause attached; the abort reason wins otherwise. */
    connect.then(late => late.release(true), () => undefined);
    const aborted = (signal as { aborted?: boolean }).aborted === true;
    if (aborted) throw signal.reason ?? failure(499, "Request closed");
    throw Object.assign(failure(503, "User directory connection unavailable"), { cause: error });
  } finally {
    signal.removeEventListener("abort", onAbortWait);
  }
  let started = false;
  let rollbackAttempted = false;
  let destroy = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError ??= error; };
  client.on("error", onError);
  const guarded = new Proxy(client, { get(target, key) {
    if (key === "query") return (...args: unknown[]) => {
      signal.throwIfAborted();
      if (connectionError) throw connectionError;
      return Reflect.apply(target.query, target, args);
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
    /* An aborted request keeps its own 499/504 reason; a statement the server stopped mid-flight
       under the in-transaction 3s budget maps to the budget 504 only when the request is still live. */
    if (signal.aborted) throw signal.reason ?? error;
    if ((error as { code?: string })?.code === "57014") throw failure(504, "User directory SQL budget exceeded");
    throw error;
  } finally {
    client.off("error", onError);
    /* ORIGINAL-mode reads retire their lease on purpose: the observed slowdown on a reused backend
       after the heavy first read is real evidence, while the mechanism behind it is NOT proven
       (see results/H/repair-r1 brief); retirement is the bounded, measured mitigation. */
    client.release(destroy || connectionError !== undefined || retireAfterRead);
  }
}
