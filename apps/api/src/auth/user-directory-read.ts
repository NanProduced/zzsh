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
): Promise<T> {
  signal.throwIfAborted();
  let client: PoolClient;
  try { client = await pool.connect(); } // Existing pool acquisition budget remains 2s.
  catch (error) { throw Object.assign(failure(503, "User directory connection unavailable"), { cause: error }); }
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
    await client.query("BEGIN READ ONLY");
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
    if ((error as { code?: string })?.code === "57014") throw failure(504, "User directory SQL budget exceeded");
    throw error;
  } finally {
    client.off("error", onError);
    client.release(destroy || connectionError !== undefined);
  }
}
