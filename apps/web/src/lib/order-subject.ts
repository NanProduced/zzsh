/**
 * Frozen order subjects.
 *
 * An order request must carry the subject that owned the operation when it was created or
 * recovered. This module deliberately holds **no mutable "current user" state**: a delayed
 * original intent belonging to A must never pick up a later registration for B. The BFF compares
 * the subject with the Cookie session captured for the same request, and the API still owns
 * authentication and per-object authorization.
 */
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OrderSubject = Readonly<{
  /** Server-confirmed user id captured when the operation was created or recovered. */
  userId: string;
  /** Identity generation captured at the same moment; A→B→A must not reuse an older scope. */
  identityVersion: number;
}>;

type SessionSnapshot = { status: string; userId: string | null; identityVersion: number };

/** Pure value constructor. Nothing is stored, and no later call can change a captured subject. */
export function captureOrderSubject(userId: string | null | undefined, identityVersion: number | null | undefined): OrderSubject | null {
  if (!userId || !SUBJECT_ID.test(userId) || typeof identityVersion !== "number" || !Number.isInteger(identityVersion) || identityVersion < 0) return null;
  return Object.freeze({ userId, identityVersion });
}

/** Normalizes a frozen subject (or an explicit string) into the exact BFF header value. */
export function orderSubjectUserId(subject: OrderSubject | string | null | undefined): string | null {
  const value = typeof subject === "string" ? subject : subject?.userId ?? null;
  return value && SUBJECT_ID.test(value) ? value : null;
}

/** A delayed operation may only run while its captured subject is still the live session. */
export function isOrderSubjectCurrent(subject: OrderSubject | null, session: SessionSnapshot): boolean {
  return Boolean(subject && session.status === "authenticated" && session.userId === subject.userId && session.identityVersion === subject.identityVersion);
}

/**
 * @deprecated The mutable page-level registry was removed. This is now a pure helper that returns
 * a frozen subject for the given id and never stores anything; requests must carry their own
 * captured subject and nothing reads a later registration.
 */
export function registerOrderExpectedUserId(userId: string | null): OrderSubject | null {
  return captureOrderSubject(userId, 0);
}
