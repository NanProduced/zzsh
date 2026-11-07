const { Pool } = require('pg'), { randomBytes, createHmac } = require('node:crypto'), assert = require('node:assert/strict'), path = require('node:path');
assert.equal(process.env.R08_ADMIN_SYNTH_OPT_IN, '1');
assert(/^[0-9]+$/.test(process.env.R08_ADMIN_SYNTH_OID ?? '') && /^[0-9]+$/.test(process.env.R08_ADMIN_SYNTH_SYSTEM_ID ?? ''));
const Module = require('node:module'), load = Module._load;
const content = { '@zzsh/content': 'index.cjs', '@zzsh/content/api-markdown': 'api-markdown.cjs', '@zzsh/content/updates': 'updates.cjs' };
Module._load = function (id, ...args) { if (id === 'sharp')
    return () => { throw Error('SYNTHETIC_AUTH_FIXTURE_SHARP_DISABLED'); }; return load.call(this, content[id] ? path.resolve(__dirname, '../../../packages/content', content[id]) : id, ...args); };
const { createApp } = require('../dist/src/app.js');
const { loadAuthRuntimeConfig } = require('../dist/src/auth/auth-runtime.js');
function jar() { const m = new Map(); return { header: () => [...m].map(([k, v]) => `${k}=${v}`).join('; '), update: r => { for (const s of r.headers.getSetCookie()) {
        const [p, ...a] = s.split(';'), i = p.indexOf('=');
        if (i < 1)
            continue;
        const k = p.slice(0, i);
        if (a.some(x => x.trim().toLowerCase() === 'max-age=0'))
            m.delete(k);
        else
            m.set(k, p.slice(i + 1));
    } } }; }
function totp(secret) { let bits = ''; const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; for (const ch of secret.toUpperCase().replace(/=+$/, '')) {
    let i = a.indexOf(ch);
    if (i < 0)
        throw Error('INVALID_SYNTHETIC_TOTP');
    bits += i.toString(2).padStart(5, '0');
} const b = []; for (let i = 0; i + 8 <= bits.length; i += 8)
    b.push(parseInt(bits.slice(i, i + 8), 2)); const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = createHmac('sha1', Buffer.from(b)).update(counter).digest(), o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
(async () => {
    const owner = new Pool({ host: '127.0.0.1', port: 55432, user: 'r08_initial_owner', database: 'zzsh_test_r08_auth_handoff3' }), runtime = new Pool({ host: '127.0.0.1', port: 55432, user: 'r08_initial_runtime', database: 'zzsh_test_r08_auth_handoff3' });
    let app;
    try {
        const target = (await owner.query(`SELECT d.oid::text oid,shobj_description(d.oid,'pg_database') marker,(SELECT system_identifier::text FROM pg_control_system()) system FROM pg_database d WHERE datname=current_database()`)).rows[0];
        assert.deepEqual(target, { oid: process.env.R08_ADMIN_SYNTH_OID, marker: 'zzsh:r08-auth-handoff:v1', system: process.env.R08_ADMIN_SYNTH_SYSTEM_ID });
        const empty = await owner.query(`SELECT (SELECT count(*)::int FROM zzsh_auth_admin."user") users,(SELECT count(*)::int FROM zzsh_iam.admin_security) security`);
        assert.deepEqual(empty.rows[0], { users: 0, security: 0 });
        const bootSecret = randomBytes(32).toString('hex');
        app = await createApp({ health: { dependencies: { postgres: { check: async () => { }, close: async () => { } }, redis: { check: async () => { }, close: async () => { } } } }, database: { pool: runtime }, auth: { ...loadAuthRuntimeConfig({ AUTH_API_ORIGIN: 'http://127.0.0.1:3102', AUTH_USER_ORIGIN: 'http://127.0.0.1:3100', AUTH_ADMIN_ORIGIN: 'http://127.0.0.1:3101', AUTH_USER_SECRET: randomBytes(32).toString('hex'), AUTH_ADMIN_SECRET: randomBytes(32).toString('hex'), AUTH_ADMIN_BOOTSTRAP_SECRET: bootSecret }), pool: runtime } });
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        async function call(path, body, j = jar(), requestId) { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { origin: 'http://127.0.0.1:3101', ...(body ? { 'content-type': 'application/json' } : {}), ...(j.header() ? { cookie: j.header() } : {}), ...(requestId ? { 'x-request-id': requestId } : {}) }, body: body ? JSON.stringify(body) : undefined }); j.update(r); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null }; }
        const password = () => randomBytes(24).toString('base64url');
        async function boot(label) { const p = password(), id = 'r08-fixture-' + randomBytes(8).toString('hex'), r = await call('/api/v1/admin/security/bootstrap', { bootstrapSecret: bootSecret, name: label, password: p }, jar(), id); assert.equal(r.status, 200, 'bootstrap'); assert.equal(r.body.status, 'PENDING_ENROLLMENT'); const a = await owner.query(`SELECT id FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='admin.bootstrap.created' AND request_id=$2`, [r.body.adminUserId, id]); assert.equal(a.rows.length, 1); return { id: r.body.adminUserId, user: r.body.username, temp: p, audit: a.rows[0].id }; }
        async function enroll(x) { const j = jar(), newpass = password(); let r = await call('/api/auth/admin/sign-in/username', { username: x.user, password: x.temp }, j); assert.equal(r.status, 200, 'login'); r = await call('/api/auth/admin/two-factor/enable', { password: x.temp }, j); assert.equal(r.status, 403, 'force password change'); r = await call('/api/auth/admin/change-password', { currentPassword: x.temp, newPassword: newpass, revokeOtherSessions: true }, j); assert.equal(r.status, 200, 'change'); r = await call('/api/auth/admin/two-factor/enable', { password: newpass }, j); assert.equal(r.status, 200, 'enable totp'); const secret = new URL(r.body.totpURI).searchParams.get('secret'); assert(secret); r = await call('/api/auth/admin/two-factor/verify-totp', { code: totp(secret) }, j); assert.equal(r.status, 200, 'verify totp'); r = await call('/api/v1/admin/security/enrollment/activate', {}, j); assert.equal(r.status, 200, 'activate'); return { jar: j, password: newpass, secret }; }
        const a = await boot('Synthetic migration boss A'), b = await boot('Synthetic migration boss B');
        const aa = await enroll(a), bb = await enroll(b);
        await owner.query("INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES($1,'role_preset_ops')", [a.id]);
        await owner.query("INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,'admin.account.create','ALLOW')", [a.id]);
        await owner.query(`UPDATE zzsh_supply.profile_avatar_policy SET updated_by_admin_id=$1,revision=revision+1 WHERE singleton`, [a.id]);
        const before = (await owner.query(`SELECT count(*)::int accounts FROM zzsh_auth_admin.account`)).rows[0].accounts;
        assert.equal(before, 2);
        await owner.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES('synthetic-user','Synthetic','synthetic-user@example.invalid',now(),now());
          INSERT INTO zzsh_auth_user.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES('synthetic-user-account','synthetic-user','credential','synthetic-user','synthetic-password-hash',now(),now());
          INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('synthetic-user-session','synthetic-user','synthetic-user-token',clock_timestamp()+interval '1 hour',now(),now());
          INSERT INTO zzsh_auth_user.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES('synthetic-phone-challenge','phone-registration:+8613800000000','1234:0',clock_timestamp()-interval '1 minute',now(),now());`);
        const staff=[];
        for(let i=0;i<2;i++){
          const id='admin_'+randomBytes(16).toString('hex'),created='audit_'+randomBytes(16).toString('hex'),activated='audit_'+randomBytes(16).toString('hex');staff.push({id,creationAuditId:created,kind:'STAFF'});
          await owner.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,\'Synthetic staff\',$2,true,now(),now())',[id,id+'@example.invalid']);
          await owner.query("INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,password_change_required) VALUES($1,'PENDING_ENROLLMENT',false,false)",[id]);
          await owner.query("UPDATE zzsh_iam.admin_security SET status='ACTIVE',first_activated_at=now() WHERE admin_user_id=$1",[id]);
          await owner.query("INSERT INTO zzsh_auth_admin.account(id,\"accountId\",\"providerId\",\"userId\",password,\"createdAt\",\"updatedAt\") VALUES($1,$2,'credential',$2,'synthetic-only',now(),now())",['account_'+i,id]);
          await owner.query("INSERT INTO zzsh_auth_admin.\"twoFactor\"(id,\"userId\",secret,\"backupCodes\") VALUES($1,$2,'synthetic-only','[]')",['factor_'+i,id]);
          await owner.query("INSERT INTO zzsh_auth_admin.session(id,\"userId\",token,\"expiresAt\",\"createdAt\",\"updatedAt\") VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',now(),now())",['session_'+i,id,'synthetic-token-'+i]);
          await owner.query("INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,request_id,occurred_at,details) VALUES ($1,'system','admin.account.created','admin_user',$2,'SUCCESS',$1,now(),'{}'),($3,'system','admin.enrollment.activated','admin_security',$2,'SUCCESS',$3,now(),'{}')",[created,id,activated]);
        }
        await owner.query("INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES($1,'role_preset_ops')",[staff[0].id]);
        const allRetired=[a.id,b.id,...staff.map(x=>x.id)],firstActivation = new Map((await owner.query("SELECT admin_user_id,to_jsonb(first_activated_at)#>>'{}' AS original_time FROM zzsh_iam.admin_security WHERE admin_user_id=ANY($1::text[])", [allRetired])).rows.map(x => [x.admin_user_id, x.original_time]));
        const s = (await owner.query(`SELECT id FROM zzsh_auth_admin.session WHERE "userId"=$1 LIMIT 1`, [a.id])).rows[0];
        assert(s);
        await owner.query('CREATE SCHEMA r08_fixture');
        await owner.query('CREATE TABLE r08_fixture.reference_session(session_id text REFERENCES zzsh_auth_admin.session(id))');
        await owner.query('INSERT INTO r08_fixture.reference_session(session_id) VALUES($1)', [s.id]);
        await owner.query('CREATE TABLE r08_fixture.reference_security(admin_id text REFERENCES zzsh_iam.admin_security(admin_user_id))');
        await owner.query('INSERT INTO r08_fixture.reference_security(admin_id) VALUES($1)', [a.id]);
        const { retireStagingMigrationAdmins,snapshotDeliveryAuth,deliveryAuthSnapshotDigest,recoverDeliveryHandoff } = await import('../../../scripts/migration/admin-staging-handoff.mjs');
        const req = { schema: 'zzsh.admin-staging-handoff.v1', target: { database: 'zzsh_test_r08_auth_handoff3', oid: process.env.R08_ADMIN_SYNTH_OID, marker: 'zzsh:r08-auth-handoff:v1', role: 'r08_initial_owner', systemIdentifier: process.env.R08_ADMIN_SYNTH_SYSTEM_ID }, sourceDatasetSha256: 'a'.repeat(64), approvalRef: 'synthetic-fixture-only', actors: [...[a, b].map(x => ({ id: x.id, creationAuditId: x.audit, kind: 'BOOTSTRAP' })),...staff] };
        const c = await owner.connect();
        try {
            await c.query(`INSERT INTO zzsh_auth_admin.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES('unrelated-synthetic','unrelated','unrelated',clock_timestamp()+interval '1 hour',now(),now())`);
            await assert.rejects(() => retireStagingMigrationAdmins(c, req), /ADMIN_HANDOFF_UNSCOPED_ADMIN_VERIFICATION/);
            assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_auth_admin.verification WHERE id='unrelated-synthetic'")).rows[0].n,1);
            await c.query("DELETE FROM zzsh_auth_admin.verification WHERE id='unrelated-synthetic'");
            const snapshot=await snapshotDeliveryAuth(c);req.actors=snapshot.actors;req.snapshot=snapshot;req.snapshotDigest=deliveryAuthSnapshotDigest(snapshot);
            req.planSha256='d'.repeat(64);req.attempt='synthetic-once';req.notBefore=new Date(Date.now()-60000).toISOString();req.expiresAt=new Date(Date.now()+1200000).toISOString();
            await c.query('BEGIN READ ONLY');assert.equal((await recoverDeliveryHandoff(c,req)).knowledge,'UNKNOWN');await c.query('ROLLBACK');
            await c.query("UPDATE zzsh_auth_user.session SET \"userAgent\"='changed' WHERE id='synthetic-user-session'");
            await assert.rejects(() => retireStagingMigrationAdmins(c, req), /ADMIN_HANDOFF_PREIMAGE_CHANGED/);
            await c.query('UPDATE zzsh_auth_user.session SET "userAgent"=NULL WHERE id=\'synthetic-user-session\'');
            await assert.rejects(() => retireStagingMigrationAdmins(c, req), /ADMIN_HANDOFF_CREDENTIAL_REFERENCED/);
            const unchanged = (await c.query(`SELECT count(*)::int n FROM zzsh_iam.admin_security WHERE status='ACTIVE' AND is_boss`)).rows[0].n;
            assert.equal(unchanged, 2);
            await c.query('DROP TABLE r08_fixture.reference_session');
            await assert.rejects(() => retireStagingMigrationAdmins(c, req), /ADMIN_HANDOFF_SECURITY_REFERENCED/);
            assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_iam.admin_security WHERE status='ACTIVE' AND is_boss")).rows[0].n, 2);
            await c.query('DROP TABLE r08_fixture.reference_security');
            await c.query('CREATE TABLE r08_fixture.reference_user_session(session_id text REFERENCES zzsh_auth_user.session(id))');
            await c.query("INSERT INTO r08_fixture.reference_user_session VALUES('synthetic-user-session')");
            await assert.rejects(() => retireStagingMigrationAdmins(c, req), /ADMIN_HANDOFF_CREDENTIAL_REFERENCED/);
            await c.query('DROP TABLE r08_fixture.reference_user_session');
            await c.query('DROP SCHEMA r08_fixture');
            await assert.rejects(() => retireStagingMigrationAdmins(c, req,{beforeCommit:async()=>{throw Error('SYNTHETIC_COMMIT_GATE_REFUSED')}}), /SYNTHETIC_COMMIT_GATE_REFUSED/);
            assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_auth_user.session WHERE id='synthetic-user-session'")).rows[0].n,1);
            let commitGate=0;const out = await retireStagingMigrationAdmins(c, req,{beforeCommit:async()=>{commitGate++}});assert.equal(commitGate,1);
            assert.equal(out.status, 'STAGING_IDENTITIES_RETIRED');
            assert.equal(out.userSessions,1);assert.equal(out.userVerifications,1);
            await c.query('BEGIN READ ONLY');assert.equal((await recoverDeliveryHandoff(c,req)).knowledge,'KNOWN');await c.query('ROLLBACK');
        }
        finally {
            c.release();
        }
        const ref = (await owner.query('SELECT updated_by_admin_id,revision::text FROM zzsh_supply.profile_avatar_policy')).rows[0];
        assert.equal(ref.updated_by_admin_id, a.id);
        assert.equal(ref.revision, '2');
        const retired = (await owner.query(`SELECT count(*)::int n FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id WHERE u.id=ANY($1::text[]) AND u.suspended AND NOT u."twoFactorEnabled" AND s.admin_user_id IS NULL`, [allRetired])).rows[0].n;
        assert.equal(retired, 4);
        const handoff = (await owner.query("SELECT details FROM zzsh_iam.audit_event WHERE action='admin.migration_identity.retired'")).rows[0].details;
        assert.equal(handoff.activation.length, 4);
        assert(handoff.activation.every(x => x.firstActivatedAt === firstActivation.get(x.id) && x.securitySnapshot.firstActivatedAt === firstActivation.get(x.id) && x.activationAuditId && x.wasBoss === [a.id,b.id].includes(x.id)));
        assert.deepEqual(new Set(handoff.grants.roles.map(x=>x.admin_user_id)),new Set([a.id,staff[0].id]));
        assert.deepEqual(handoff.grants.permissions, [{ admin_user_id: a.id, permission_code: 'admin.account.create', effect: 'ALLOW' }]);
        assert.equal((await owner.query('SELECT count(*)::int n FROM zzsh_iam.admin_user_role')).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int n FROM zzsh_iam.admin_user_permission')).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int n FROM zzsh_auth_admin."twoFactor"')).rows[0].n, 0);
        assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_auth_user.session WHERE id='synthetic-user-session'")).rows[0].n,0);
        assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_auth_user.verification WHERE id='synthetic-phone-challenge'")).rows[0].n,0);
        assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_auth_user.account WHERE id='synthetic-user-account' AND password='synthetic-password-hash'")).rows[0].n,1);
        const old = await call('/api/auth/admin/sign-in/username', { username: a.user, password: aa.password }, jar());
        assert([401, 403].includes(old.status), 'retired cannot log in');
        assert(/^zz[0-9]+$/.test(a.user));await owner.query(`SELECT setval('zzsh_iam.admin_login_number_seq',$1,false)`,[Number(a.user.slice(2))]);
        const human = await boot('Synthetic human boss');
        assert(![a.user,b.user].includes(human.user),'bootstrap skips suspended usernames');
        const pending = (await owner.query(`SELECT s.status,s.password_change_required,u."twoFactorEnabled",s.bootstrap_expires_at>clock_timestamp() AS live FROM zzsh_iam.admin_security s JOIN zzsh_auth_admin."user" u ON u.id=s.admin_user_id WHERE u.id=$1`, [human.id])).rows[0];
        assert.deepEqual(pending, { status: 'PENDING_ENROLLMENT', password_change_required: true, twoFactorEnabled: false, live: true });
        const humanAuth = await enroll(human);
        const listed = await call('/api/v1/admin/security/admins', undefined, humanAuth.jar);
        assert.equal(listed.status, 200);
        assert(!listed.body.admins.some(x => allRetired.includes(x.id)));
        const detail = await call('/api/v1/admin/security/admins/detail?username=' + encodeURIComponent(a.user), undefined, humanAuth.jar);
        assert.equal(detail.status, 404);
        for (const route of ['/api/v1/admin/security/unfreeze', '/api/v1/admin/security/admins/reset-password']) {
            const denied = await call(route, { targetAdminId: a.id, reason: 'synthetic review', password: humanAuth.password, totpCode: totp(humanAuth.secret) }, humanAuth.jar);
            assert.equal(denied.status, 404, route);
        }
        const expired = await boot('Synthetic expired boss');
        await owner.query(`UPDATE zzsh_iam.admin_security SET bootstrap_expires_at=clock_timestamp()-interval '1 second' WHERE admin_user_id=$1`, [expired.id]);
        const replacement = await boot('Synthetic replacement boss');
        assert.notEqual(expired.id, replacement.id);
        assert.equal((await owner.query('SELECT count(*)::int n FROM zzsh_auth_admin."user" WHERE id=$1', [expired.id])).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE id=$1', [expired.audit])).rows[0].n, 1);
        console.log(JSON.stringify({ status: 'SYNTHETIC_AUTH_HANDOFF_PASSED', migrationBootstrap: 2, syntheticStaff:2, humanBootstrap: 3, formalEnrollment: 3, migrationActorsRetired: 4,
          referencedAdminSession: 'REJECTED_WITH_ROLLBACK', referencedUserSession: 'REJECTED_WITH_ROLLBACK', referencedSecurity: 'REJECTED_WITH_ROLLBACK',
          unscopedAdminVerification:'PRESERVED_AND_REJECTED',changedPreimage:'REJECTED_WITH_ROLLBACK',userSession:'EXACTLY_RETIRED',userChallenge:'EXACTLY_RETIRED',userPassword:'PRESERVED',
          unknownBeforeCommit:'UNKNOWN',originalAuditReadback:'KNOWN',creatorForeignKey: 'PRESERVED', activationAudit: 'EXACT_MICROSECONDS_AND_GRANTS_PRESERVED',
          retiredCredentials: 'REJECTED', adminDirectoryAndActions: 'NOT_FOUND', expiry: 'FRESH_BOOTSTRAP', realProviders: 0 }));
    }
    finally {
        if (app)
            await app.close();
        else
            await runtime.end();
        await owner.end();
    }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
