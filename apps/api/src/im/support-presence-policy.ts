/**
 * One server-side definition of "on reception" and "dispatchable".
 *
 * Reception is an explicit interval owned by one auth session. The IM connection
 * is only one input: a short disconnect stays dispatchable for the grace window,
 * a longer disconnect pauses new work but keeps the interval open, and only an
 * explicit stop, revocation/expiry, takeover or the 30-minute lost rule ends it.
 */
export const SUPPORT_GRACE_SECONDS = 120;
export const SUPPORT_LOST_SECONDS = 30 * 60;
export const SUPPORT_STRICT_ONLINE_SECONDS = 75;

export type SupportPresencePolicyRow = {
  availability: string;
  connectionState: string;
  lastConfirmedAt: Date | string | null;
  disconnectedSince: Date | string | null;
  dispatchPaused: boolean;
  hasOwnedSession: boolean;
};

function timeOf(value: Date | string | null): number | null {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * The SQL predicate and this function must stay in lockstep. LEAST ignores NULL,
 * so a connected row uses last_confirmed_at and a disconnected row uses the
 * earlier of the first detected break and the last confirmed liveness.
 */
export function isPresenceDispatchable(row: SupportPresencePolicyRow, now = Date.now()): boolean {
  if (row.availability !== "AVAILABLE" || row.dispatchPaused || !row.hasOwnedSession) return false;
  if (row.connectionState === "KICKED" || row.connectionState === "AUTH_FAILED") return false;
  const confirmed = timeOf(row.lastConfirmedAt);
  if (confirmed === null) return false;
  const disconnected = timeOf(row.disconnectedSince);
  const earliest = disconnected === null ? confirmed : Math.min(confirmed, disconnected);
  return earliest > now - SUPPORT_GRACE_SECONDS * 1000;
}

/** Manual claim needs a real current connection, not merely the 2-minute grace. */
export function isPresenceStrictOnline(row: SupportPresencePolicyRow, now = Date.now()): boolean {
  if (!isPresenceDispatchable(row, now)) return false;
  const confirmed = timeOf(row.lastConfirmedAt);
  return row.connectionState === "CONNECTED"
    && row.disconnectedSince === null
    && confirmed !== null
    && confirmed > now - SUPPORT_STRICT_ONLINE_SECONDS * 1000;
}

/** Shared SQL predicate. Caller supplies the presence alias and joins the owned auth session. */
export function supportDispatchablePresenceSql(alias = "p"): string {
  return `${alias}."availability" = 'AVAILABLE'
    AND ${alias}."dispatch_paused" = false
    AND ${alias}."connection_state" NOT IN ('KICKED', 'AUTH_FAILED')
    AND ${alias}."last_confirmed_at" IS NOT NULL
    AND LEAST(${alias}."disconnected_since", ${alias}."last_confirmed_at")
        > clock_timestamp() - interval '${SUPPORT_GRACE_SECONDS} seconds'
    AND EXISTS (
      SELECT 1 FROM "zzsh_iam"."im_support_presence_session" s
       WHERE s."app_id" = ${alias}."app_id" AND s."admin_user_id" = ${alias}."admin_user_id"
         AND s."ended_at" IS NULL
    )`;
}

export function supportStrictOnlinePresenceSql(alias = "p"): string {
  return `${supportDispatchablePresenceSql(alias)}
    AND ${alias}."connection_state" = 'CONNECTED'
    AND ${alias}."disconnected_since" IS NULL
    AND ${alias}."last_confirmed_at" > clock_timestamp() - interval '${SUPPORT_STRICT_ONLINE_SECONDS} seconds'`;
}
