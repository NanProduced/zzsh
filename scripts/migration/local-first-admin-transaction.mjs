/** Transaction outcome is separate from the local receipt: never replay an unacknowledged commit. */
export class FirstAdminTransactionError extends Error {
  constructor(outcome, rollbackAcknowledged = false) {
    super(`FIRST_ADMIN_${outcome}`);
    this.outcome = outcome;
    this.rollbackAcknowledged = rollbackAcknowledged;
  }
}

/** The caller owns the registered target, exclusive attempt claim, client and durable receipt. */
export async function writeFirstAdministrators({client, input, requestId, hashPassword, initialize, acquireFence, checkBinding, record}) {
  await record({status:'WRITE_INTENT'});
  let transaction = false, commitSent = false, commitAcknowledged = false;
  try {
    transaction = true;
    if ((await client.query('BEGIN')).command !== 'BEGIN') throw Error('BEGIN_UNCONFIRMED');
    await acquireFence(client);
    const accounts = await initialize(client, input, hashPassword, requestId);
    await record({status:'COMMIT_INTENT'});
    await checkBinding(client);
    commitSent = true;
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw Error('COMMIT_UNCONFIRMED');
    commitAcknowledged = true; transaction = false;
    await record({status:'COMMIT_ACK_READBACK_REQUIRED'});
    return accounts.map(({username, role}) => ({username, role}));
  } catch {
    let outcome = commitAcknowledged ? 'COMMITTED_READBACK_REQUIRED' : commitSent ? 'COMMIT_UNKNOWN' : 'NOT_COMMITTED';
    let rollbackAcknowledged = false;
    if (!commitSent && transaction) {
      try { rollbackAcknowledged = (await client.query('ROLLBACK')).command === 'ROLLBACK'; } catch { /* original attempt remains unresolved */ }
      if (!rollbackAcknowledged) outcome = 'ROLLBACK_UNKNOWN';
    }
    try { await record({status:outcome, rollbackAcknowledged}); } catch { /* retain the last durable intent */ }
    throw new FirstAdminTransactionError(outcome, rollbackAcknowledged);
  }
}

/** The readback uses a separate read-only snapshot and never creates replacement accounts. */
export async function readFirstAdministratorsSnapshot({client, input, requestId, verifyPassword, read, acquireFence, checkBinding}) {
  let transaction = false;
  try {
    transaction = true;
    if ((await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).command !== 'BEGIN') throw Error('BEGIN_UNCONFIRMED');
    await acquireFence(client);
    const result = await read(client, input, verifyPassword, requestId);
    await checkBinding(client);
    if ((await client.query('ROLLBACK')).command !== 'ROLLBACK') throw Error('ROLLBACK_UNCONFIRMED');
    transaction = false;
    return result;
  } catch {
    if (transaction) try { await client.query('ROLLBACK'); } catch { /* readback remains unverified */ }
    throw new FirstAdminTransactionError('READBACK_UNCONFIRMED');
  }
}
