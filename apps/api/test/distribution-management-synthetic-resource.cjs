const assert=require('node:assert/strict');

/** Claim the pre-registered test-only resource; the owner connection holds the lock until release. */
exports.claim=async(client,env)=>{
 for(const key of ['DISTRIBUTION_SYNTH_OWNER_OID','DISTRIBUTION_SYNTH_RUNTIME_OID','DISTRIBUTION_SYNTH_LOCK'])assert.match(env[key]??'',/^[1-9]\d*$/);
 const roles=(await client.query('SELECT rolname,oid::text oid,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])',[[env.DISTRIBUTION_SYNTH_OWNER,env.DISTRIBUTION_SYNTH_RUNTIME]])).rows;
 assert.equal(roles.length,2);
 const owner=roles.find(row=>row.rolname===env.DISTRIBUTION_SYNTH_OWNER),runtime=roles.find(row=>row.rolname===env.DISTRIBUTION_SYNTH_RUNTIME);
 assert.equal(owner?.oid,env.DISTRIBUTION_SYNTH_OWNER_OID);assert.equal(runtime?.oid,env.DISTRIBUTION_SYNTH_RUNTIME_OID);
 assert.equal(owner?.rolsuper,false);assert.equal(runtime?.rolsuper,false);assert.equal(runtime?.rolbypassrls,false);
 const acquired=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired',[env.DISTRIBUTION_SYNTH_LOCK])).rows[0]?.acquired;
 assert.equal(acquired,true,'Synthetic resource is in use');
 return async()=>{const released=(await client.query('SELECT pg_advisory_unlock($1::bigint) AS released',[env.DISTRIBUTION_SYNTH_LOCK])).rows[0]?.released;assert.equal(released,true,'Synthetic lock release not acknowledged');};
};
