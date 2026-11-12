/** Never replay a write whose COMMIT acknowledgement is unknown. */
export async function writeInitialization({client, initialize, acquireFence, checkBinding, record, errorType, project=result=>result}) {
  await record({status:'WRITE_INTENT'});
  let transaction=false,commitSent=false,commitAcknowledged=false;
  try {
    transaction=true;
    if ((await client.query('BEGIN')).command !== 'BEGIN') throw Error('BEGIN_UNCONFIRMED');
    await acquireFence(client);
    const result=await initialize(client);
    await record({status:'COMMIT_INTENT'});
    await checkBinding(client);
    commitSent=true;
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw Error('COMMIT_UNCONFIRMED');
    commitAcknowledged=true;transaction=false;
    await record({status:'COMMIT_ACK_READBACK_REQUIRED'});
    return project(result);
  } catch {
    let outcome=commitAcknowledged?'COMMITTED_READBACK_REQUIRED':commitSent?'COMMIT_UNKNOWN':'NOT_COMMITTED';
    let rollbackAcknowledged=false;
    if (!commitSent && transaction) {
      try { rollbackAcknowledged=(await client.query('ROLLBACK')).command === 'ROLLBACK'; } catch { /* original attempt remains unresolved */ }
      if (!rollbackAcknowledged) outcome='ROLLBACK_UNKNOWN';
    }
    try { await record({status:outcome,rollbackAcknowledged}); } catch { /* retain the last durable intent */ }
    throw new errorType(outcome,rollbackAcknowledged);
  }
}

/** Read back the original request in a separate, read-only transaction. */
export async function readInitialization({client, read, acquireFence, checkBinding, errorType}) {
  let transaction=false;
  try {
    transaction=true;
    if ((await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).command !== 'BEGIN') throw Error('BEGIN_UNCONFIRMED');
    await acquireFence(client);
    const result=await read(client);
    await checkBinding(client);
    if ((await client.query('ROLLBACK')).command !== 'ROLLBACK') throw Error('ROLLBACK_UNCONFIRMED');
    transaction=false;
    return result;
  } catch {
    if (transaction) try { await client.query('ROLLBACK'); } catch { /* readback remains unverified */ }
    throw new errorType('READBACK_UNCONFIRMED');
  }
}
