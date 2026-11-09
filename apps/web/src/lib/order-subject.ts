/**
 * The subject this browser document was rendered for.
 *
 * `UserSessionProvider` registers the server-confirmed user synchronously during render, before
 * any child effect can issue an order request. Every `/api/orders` request from `order-client.ts`
 * sends it as `x-zzsh-expected-user-id`; the Web BFF compares that value with the Cookie session
 * captured for the same request. A stale tab that still displays user A therefore cannot read or
 * write orders after the Cookie has switched to user B.
 *
 * This is per-document client state, not a cache of private data. React effects are not used for
 * registration because child effects run before parent effects on the first authenticated commit;
 * a document that has not confirmed a session registers no subject, and the BFF rejects the
 * request rather than guessing an identity.
 */
const subjectId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let registeredUserId: string | null = null;

export function registerOrderExpectedUserId(userId: string | null): void {
  registeredUserId = userId && subjectId.test(userId) ? userId : null;
}

export function currentOrderExpectedUserId(): string | null {
  return registeredUserId;
}
