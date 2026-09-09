export const DATABASE_CLEANUP_TIMEOUT_MS = 2_000;

export type ReleasableClient = {
  release: (destroy?: boolean) => void;
};

export async function closeResource(
  authorized: boolean,
  client: ReleasableClient,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (!authorized) {
    client.release(true);
    return;
  }
  try {
    await cleanup();
  } finally {
    client.release();
  }
}

export async function settlesWithin(
  pending: Promise<unknown> | undefined,
  timeoutMs = DATABASE_CLEANUP_TIMEOUT_MS,
): Promise<boolean> {
  if (!pending) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function finishDatabaseTest(
  primaryError: unknown,
  cleanup: () => Promise<void>,
  closeTestPool: () => Promise<void>,
  closeAdminPool: () => Promise<void>,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await closeTestPool();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await closeAdminPool();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}
