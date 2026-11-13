import {readInitialization,writeInitialization} from './local-initialization-transaction.mjs';

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
  return writeInitialization({client,initialize:held=>initialize(held,input,hashPassword,requestId),
    acquireFence,checkBinding,record,errorType:FirstAdminTransactionError,
    project:accounts=>accounts.map(({username,role})=>({username,role}))});
}

/** The readback uses a separate read-only snapshot and never creates replacement accounts. */
export async function readFirstAdministratorsSnapshot({client, input, requestId, verifyPassword, read, acquireFence, checkBinding}) {
  return readInitialization({client,read:held=>read(held,input,verifyPassword,requestId),
    acquireFence,checkBinding,errorType:FirstAdminTransactionError});
}
