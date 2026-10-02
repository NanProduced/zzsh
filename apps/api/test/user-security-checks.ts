import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { UserSecurityDelivery } from "../src/auth/user-security";

type Jar = { values: Map<string, string>; update(response: Response): void; header(): string };
type Request = (base: string, path: string, body: Record<string, unknown> | undefined, jar: Jar, origin: string) => Promise<{ response: Response; body: Record<string, any> | null }>;

/** Real HTTP -> Better Auth -> least-privilege PG assertions; called in the existing isolated suite. */
export async function runUserSecurityChecks(o: {
  base: string; runtime: Pool; migration: Pool; runtimeRole: string; request: Request; jar: () => Jar;
  sms: Map<string, { code: string }>; security: Map<string, UserSecurityDelivery>; origin: string;
}) {
  const call = (route: string, body?: Record<string, unknown>, jar = o.jar()) => o.request(o.base, "/api/auth/user" + route, body, jar, o.origin);
  const checked: string[] = [];
  const pass = (label: string) => { checked.push(label); };
  const phone = "+8613900010001";
  const jar = o.jar();
  assert.equal((await call("/phone-registration/send-otp", { phoneNumber: phone })).response.status, 200);
  const code = o.sms.get("phone-registration:" + phone)?.code;
  assert.ok(code);
  assert.equal((await call("/phone-registration/complete", { phoneNumber: phone, code, loginOrRegister: true }, jar)).response.status, 400);
  const registered = await call("/phone-registration/complete", { phoneNumber: phone, code, acceptedTerms: true, loginOrRegister: true }, jar);
  assert.equal(registered.response.status, 200);
  assert.equal(registered.body?.passwordSet, false);
  const current = await call("/get-session", undefined, jar);
  const userId = current.body?.user?.id as string;
  assert.ok(userId);
  const originalExpiry = new Date(current.body?.session?.expiresAt).getTime();
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_auth_user.account WHERE "userId"=$1`, [userId])).rows[0].n, 0);
  assert.equal((await call("/phone-registration/complete", { phoneNumber: phone, code, acceptedTerms: true, loginOrRegister: true })).response.status, 400);
  assert.equal((await call("/phone-registration/send-otp", { phoneNumber: phone })).response.status, 429);
  pass("T01:no-password registration, terms, one consumption and cooldown");

  for (const [route, body] of [
    ["/sign-up/email", { email: "fixture@example.invalid", password: "secret", name: "fixture" }],
    ["/sign-in/username", { username: phone, password: "secret" }],
    ["/sign-in/email", { email: "fixture@example.invalid", password: "secret" }],
    ["/phone-number/verify", { phoneNumber: phone, code }],
  ] as const) assert.equal((await call(route, body)).response.status, 404);
  assert.equal((await call("/sign-in/identifier", { identifier: phone, password: "secret", kind: "username" })).response.status, 400);
  pass("T06:public registration/login and SDK change bypasses closed");

  const proof = async (purpose: string, channel = "phone", target?: string, sessionJar = jar, stage = "current", parentProofId?: string, contact?: string) => {
    const sent = await call("/security/challenge/send", { purpose, channel, stage, ...(target ? { target } : {}), ...(parentProofId ? { proofId: parentProofId } : {}), ...(contact ? { contact } : {}) }, sessionJar);
    assert.equal(sent.response.status, 200, "challenge should be sent");
    const id = sent.body?.challengeId as string;
    const delivery = o.security.get(id);
    assert.ok(delivery, "test delivery remains in the restricted test outbox");
    const verified = await call("/security/challenge/verify", { challengeId: id, code: delivery.code }, sessionJar);
    assert.equal(verified.response.status, 200, "challenge should verify");
    return id;
  };
  const newPassword = randomBytes(18).toString("base64url");
  const passwordProof = await proof("password");
  assert.equal((await call("/security/password", { proofId: passwordProof, newPassword: "short" }, jar)).response.status, 400);
  assert.equal((await call("/security/password", { proofId: passwordProof, newPassword: newPassword + "x".repeat(129) }, jar)).response.status, 400);
  assert.equal((await call("/security/password", { proofId: passwordProof, newPassword }, jar)).response.status, 200);
  const afterPassword = await call("/get-session", undefined, jar);
  assert.equal(afterPassword.body?.user?.id, userId);
  assert.equal(new Date(afterPassword.body?.session?.expiresAt).getTime(), originalExpiry);
  assert.equal((await call("/security/operation", { operationId: passwordProof }, jar)).body?.status, "completed");
  const second = o.jar();
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: phone, password: newPassword }, second)).response.status, 200);
  assert.equal((await call("/security/sessions", undefined, jar)).body?.sessions.length, 2);
  pass("T05/T08/T14:voluntary password, 12-128, atomic rotation, absolute expiry and multi-device");

  const email = "auth-compat@example.invalid";
  const emailProof = await proof("email", "phone", email);
  assert.equal((await call("/security/email", { proofId: emailProof }, jar)).response.status, 400);
  assert.equal((await call("/security/overview", undefined, jar)).body?.email, null);
  const targetProof = await proof("email", "email", email, jar, "target", emailProof);
  assert.equal((await call("/security/phone", { proofId: emailProof, targetProofId: targetProof }, jar)).response.status, 409);
  assert.equal((await call("/security/email", { proofId: emailProof, targetProofId: targetProof }, jar)).response.status, 200);
  assert.equal((await call("/security/overview", undefined, jar)).body?.email, email);
  assert.equal((await call("/get-session", undefined, second)).body, null);
  assert.equal((await call("/security/challenge/send", { purpose: "email", channel: "phone", target: "phone-a@phone.zzsh.invalid" }, jar)).response.status, 400);
  pass("T09/T10/T14:purpose isolation, double email proof, placeholder rejection and other-session revoke");

  const nextPhone = "+8613900010002";
  const phoneProof = await proof("phone", "email", nextPhone);
  const newPhoneProof = await proof("phone", "phone", nextPhone, jar, "target", phoneProof);
  assert.equal((await call("/security/phone", { proofId: phoneProof, targetProofId: newPhoneProof }, jar)).response.status, 200);
  assert.equal((await call("/get-session", undefined, jar)).body?.user?.id, userId);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: phone, password: newPassword })).response.status, 401);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: nextPhone, password: newPassword }, second)).response.status, 200);
  const thirdPhone = "+8613900010003";
  const oldPhoneProof = await proof("phone", "phone", thirdPhone);
  const thirdProof = await proof("phone", "phone", thirdPhone, jar, "target", oldPhoneProof);
  assert.equal((await call("/security/phone", { proofId: oldPhoneProof, targetProofId: thirdProof }, jar)).response.status, 200);
  assert.equal((await call("/get-session", undefined, second)).body, null);
  pass("T12/T13:both phone-change paths preserve subject and reject old number");

  assert.equal((await call("/profile/nickname", { nickname: "同名😀" }, jar)).response.status, 200);
  assert.equal((await call("/profile/nickname", { nickname: "x".repeat(65) }, jar)).response.status, 400);
  assert.equal((await call("/profile/nickname", { nickname: "Name", role: "boss" }, jar)).response.status, 400);
  assert.equal((await call("/get-session", undefined, jar)).body?.user?.id, userId);
  pass("T07:nickname is presentation, Unicode boundary and protected-field rejection");

  const restoredPassword = randomBytes(18).toString("base64url");
  const recoveryProof = await proof("recovery", "email", undefined, o.jar(), "current", undefined, email);
  assert.equal((await call("/security/recovery/complete", { proofId: recoveryProof, newPassword: restoredPassword })).response.status, 200);
  assert.equal((await call("/get-session", undefined, jar)).body, null);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: thirdPhone, password: newPassword })).response.status, 401);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: thirdPhone, password: restoredPassword }, jar)).response.status, 200);
  const phoneRecovery = await proof("recovery", "phone", undefined, o.jar(), "current", undefined, thirdPhone);
  assert.equal((await call("/security/recovery/complete", { proofId: phoneRecovery, newPassword: restoredPassword })).response.status, 200);
  const unknown = await call("/security/challenge/send", { purpose: "recovery", channel: "email", contact: "unknown-auth@example.invalid" });
  assert.equal(unknown.response.status, 200);
  assert.equal(Object.keys(unknown.body!).sort().join(","), "challengeId,cooldownUntil,expiresAt,status");
  pass("T11:independent email/phone recovery, neutral unknown send and full revocation");

  const legacyId = "user_" + randomUUID().replaceAll("-", "");
  const legacyPhone = "+8613900010004";
  const legacyPassword = " aB3 ";
  const salt = randomBytes(4).toString("hex");
  const digest = createHash("md5").update(legacyPassword + salt).digest("hex");
  await o.migration.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt",suspended) VALUES ($1,'Long legacy nickname',$2,false,$3,false,clock_timestamp(),clock_timestamp(),false)`, [legacyId, legacyId + "@phone.zzsh.invalid", legacyPhone]);
  await o.migration.query(`INSERT INTO zzsh_iam.user_identity_state (user_id,account_status,identity_status,age_status,provider,version,updated_at) VALUES ($1,'ACTIVE','UNVERIFIED','UNKNOWN','legacy_mysql_restore',1,clock_timestamp())`, [legacyId]);
  await o.migration.query(`INSERT INTO zzsh_auth_user.account (id,"accountId","providerId","userId",password,"legacyPasswordMd5","legacyPasswordVersion","legacyPasswordSalt","createdAt","updatedAt") VALUES ($1,$2,'credential',$2,NULL,$3,'legacy-md5-v1',$4,clock_timestamp(),clock_timestamp())`, ["account_" + randomUUID().replaceAll("-", ""), legacyId, digest, salt]);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: legacyPhone, password: legacyPassword.trim() })).response.status, 401);
  const [first, parallel] = await Promise.all([call("/sign-in/phone-number", { phoneNumber: legacyPhone, password: legacyPassword }), call("/sign-in/phone-number", { phoneNumber: legacyPhone, password: legacyPassword })]);
  assert.equal(first.response.status, 200); assert.equal(parallel.response.status, 200);
  const upgraded = (await o.runtime.query(`SELECT password IS NOT NULL AS modern,"legacyPasswordMd5" IS NULL AS cleared FROM zzsh_auth_user.account WHERE "userId"=$1`, [legacyId])).rows[0];
  assert.ok(upgraded.modern && upgraded.cleared);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: legacyPhone, password: legacyPassword })).response.status, 200);
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='user.legacy_password.upgraded' AND actor_id=$1`, [legacyId])).rows[0].n, 1);
  pass("T03/T04:short exact legacy v1 password, concurrent first upgrade, same-password repeat");

  let fixtureSequence = 10;
  const legacyFixture = async (version = "legacy-md5-v1") => {
    const id = "user_" + randomUUID().replaceAll("-", "");
    const number = "+861390001" + String(++fixtureSequence).padStart(4, "0");
    const value = " oldP9 "; const fixtureSalt = randomBytes(4).toString("hex");
    const md5 = createHash("md5").update(version === "legacy-md5-v0" ? value : value + fixtureSalt).digest("hex");
    await o.migration.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt",suspended) VALUES ($1,'技术兼容样本',$2,false,$3,false,clock_timestamp(),clock_timestamp(),false)`, [id, id + "@phone.zzsh.invalid", number]);
    await o.migration.query(`INSERT INTO zzsh_iam.user_identity_state (user_id,account_status,identity_status,age_status,provider,version,updated_at) VALUES ($1,'ACTIVE','UNVERIFIED','UNKNOWN','legacy_mysql_restore',1,clock_timestamp())`, [id]);
    await o.migration.query(`INSERT INTO zzsh_auth_user.account (id,"accountId","providerId","userId",password,"legacyPasswordMd5","legacyPasswordVersion","legacyPasswordSalt","createdAt","updatedAt") VALUES ($1,$2,'credential',$2,NULL,$3,$4,$5,clock_timestamp(),clock_timestamp())`, ["account_" + randomUUID().replaceAll("-", ""), id, md5, version, fixtureSalt]);
    return { id, number, value };
  };
  const opaquePasswordState = async (id: string) => (await o.runtime.query(`SELECT password IS NOT NULL AS modern,"legacyPasswordMd5" IS NOT NULL AS legacy FROM zzsh_auth_user.account WHERE "userId"=$1`, [id])).rows[0];
  const v0 = await legacyFixture("legacy-md5-v0");
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: v0.number, password: v0.value })).response.status, 200);
  const unknownVersion = await legacyFixture("legacy-unknown");
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: unknownVersion.number, password: unknownVersion.value })).response.status, 401);
  assert.ok((await opaquePasswordState(unknownVersion.id)).legacy && !(await opaquePasswordState(unknownVersion.id)).modern);
  pass("T04:v0 compatibility and unknown version fail closed without discarding material");

  const rollbackLegacy = await legacyFixture();
  await o.migration.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeRole}"`);
  try { assert.equal((await call("/sign-in/phone-number", { phoneNumber: rollbackLegacy.number, password: rollbackLegacy.value })).response.status, 500); }
  finally { await o.migration.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeRole}"`); }
  assert.ok((await opaquePasswordState(rollbackLegacy.id)).legacy && !(await opaquePasswordState(rollbackLegacy.id)).modern);
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_auth_user.session WHERE "userId"=$1`, [rollbackLegacy.id])).rows[0].n, 0);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: rollbackLegacy.number, password: rollbackLegacy.value })).response.status, 200);
  pass("T04:upgrade audit failure rolls back credential and session, retry remains legal");

  const sessionFailurePhone = "+8613900020001";
  await call("/phone-registration/send-otp", { phoneNumber: sessionFailurePhone });
  const sessionFailureCode = o.sms.get("phone-registration:" + sessionFailurePhone)!.code;
  await o.migration.query(`REVOKE INSERT ON zzsh_auth_user.session FROM "${o.runtimeRole}"`);
  try { assert.equal((await call("/phone-registration/complete", { phoneNumber: sessionFailurePhone, code: sessionFailureCode, acceptedTerms: true, loginOrRegister: true })).response.status, 500); }
  finally { await o.migration.query(`GRANT INSERT ON zzsh_auth_user.session TO "${o.runtimeRole}"`); }
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1`, [sessionFailurePhone])).rows[0].n, 0);
  assert.equal((await call("/phone-registration/complete", { phoneNumber: sessionFailurePhone, code: sessionFailureCode, acceptedTerms: true, loginOrRegister: true })).response.status, 200);
  pass("T01/T09:session failure rolls back registration and challenge consumption atomically");

  const proofFixture = await legacyFixture(); const proofJar = o.jar();
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: proofFixture.number, password: proofFixture.value }, proofJar)).response.status, 200);
  const challengeResponse = await call("/security/challenge/send", { purpose: "password", channel: "phone" }, proofJar);
  const challengeId = challengeResponse.body?.challengeId as string;
  const delivery = o.security.get(challengeId)!;
  const wrongCode = delivery.code === "000000" ? "000001" : "000000";
  for (let n = 0; n < 3; n++) assert.equal((await call("/security/challenge/verify", { challengeId, code: wrongCode }, proofJar)).response.status, 400);
  assert.equal((await call("/security/challenge/verify", { challengeId, code: delivery.code }, proofJar)).response.status, 400);
  assert.equal((await call("/security/challenge/send", { purpose: "password", channel: "phone" }, proofJar)).response.status, 429);
  const sendKey = (await o.runtime.query(`SELECT value::jsonb->>'sendKey' AS key FROM zzsh_auth_user.verification WHERE id=$1`, [challengeId])).rows[0].key;
  await o.migration.query(`UPDATE zzsh_auth_user.verification SET "createdAt"=clock_timestamp()-interval '61 seconds' WHERE identifier=$1`, [sendKey]);
  const replacement = await call("/security/challenge/send", { purpose: "password", channel: "phone" }, proofJar);
  assert.equal(replacement.response.status, 200);
  assert.notEqual(replacement.body?.challengeId, challengeId);
  const replacementId = replacement.body?.challengeId as string;
  assert.equal((await call("/security/challenge/verify", { challengeId, code: o.security.get(replacementId)!.code }, proofJar)).response.status, 400);
  await o.migration.query(`UPDATE zzsh_auth_user.verification SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [replacementId]);
  assert.equal((await call("/security/challenge/verify", { challengeId: replacementId, code: o.security.get(replacementId)!.code }, proofJar)).response.status, 400);
  pass("T09:three errors, retained cooldown, newest challenge identity and expiry in real PG");

  const race = await legacyFixture(); const racePassword = randomBytes(18).toString("base64url");
  const resetProof = await proof("recovery", "phone", undefined, o.jar(), "current", undefined, race.number);
  const raceResults = await Promise.all([call("/sign-in/phone-number", { phoneNumber: race.number, password: race.value }), call("/security/recovery/complete", { proofId: resetProof, newPassword: racePassword })]);
  assert.equal(raceResults[1].response.status, 200);
  assert.ok([200, 401].includes(raceResults[0].response.status));
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: race.number, password: race.value })).response.status, 401);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: race.number, password: racePassword })).response.status, 200);
  assert.ok(!(await opaquePasswordState(race.id)).legacy);
  assert.equal((await call("/security/recovery/complete", { proofId: resetProof, newPassword: racePassword })).response.status, 200);
  assert.equal((await call("/security/recovery/complete", { proofId: resetProof, newPassword: racePassword + "different" })).response.status, 409);
  pass("T04/T09:reset versus first upgrade cannot resurrect old password; exact replay is bound");

  const parallelReset = await legacyFixture();
  const resetA = await proof("recovery", "phone", undefined, o.jar(), "current", undefined, parallelReset.number);
  // A second legitimately issued recovery challenge through a separate bound channel.
  await o.migration.query(`UPDATE zzsh_auth_user."user" SET email='parallel-reset@example.invalid',"emailVerified"=true WHERE id=$1`, [parallelReset.id]);
  // Reissue the phone proof against the current security facts instead of replaying one from before binding.
  const firstSendKey = (await o.runtime.query(`SELECT value::jsonb->>'sendKey' AS key FROM zzsh_auth_user.verification WHERE id=$1`, [resetA])).rows[0].key;
  await o.migration.query(`UPDATE zzsh_auth_user.verification SET "createdAt"=clock_timestamp()-interval '61 seconds' WHERE identifier=$1`, [firstSendKey]);
  const resetPhone = await proof("recovery", "phone", undefined, o.jar(), "current", undefined, parallelReset.number);
  const resetEmail = await proof("recovery", "email", undefined, o.jar(), "current", undefined, "parallel-reset@example.invalid");
  const passwordA = randomBytes(18).toString("base64url"), passwordB = randomBytes(18).toString("base64url");
  const resets = await Promise.all([call("/security/recovery/complete", { proofId: resetPhone, newPassword: passwordA }), call("/security/recovery/complete", { proofId: resetEmail, newPassword: passwordB })]);
  assert.equal(resets.filter(item => item.response.status === 200).length, 1);
  assert.ok(resets.every(item => [200, 400, 409].includes(item.response.status)));
  const winner = resets[0].response.status === 200 ? passwordA : passwordB;
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: parallelReset.number, password: winner })).response.status, 200);
  pass("T04/T11:two concurrent independent resets consume only one current security version");

  const sessionsFixture = await legacyFixture();
  const sessionA = o.jar(), sessionB = o.jar(), sessionC = o.jar(), foreignJar = o.jar();
  for (const device of [sessionA, sessionB, sessionC]) assert.equal((await call("/sign-in/phone-number", { phoneNumber: sessionsFixture.number, password: sessionsFixture.value }, device)).response.status, 200);
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: legacyPhone, password: legacyPassword }, foreignJar)).response.status, 200);
  const ownSessions = (await call("/security/sessions", undefined, sessionA)).body?.sessions as Array<Record<string, unknown>>;
  assert.equal(ownSessions.length, 3); assert.equal(ownSessions.filter(item => item.isCurrent).length, 1);
  assert.ok(ownSessions.every(item => !["token", "pinHash", "userId", "ipAddress"].some(key => key in item)));
  const foreignId = (await call("/security/sessions", undefined, foreignJar)).body?.sessions[0].id;
  assert.equal((await call("/security/sessions/revoke", { sessionId: foreignId }, sessionA)).response.status, 403);
  const deviceBId = (await call("/security/sessions", undefined, sessionB)).body?.sessions.find((item: { isCurrent: boolean }) => item.isCurrent).id;
  assert.equal((await call("/security/sessions/revoke", { sessionId: deviceBId }, sessionA)).response.status, 200);
  assert.equal((await call("/get-session", undefined, sessionB)).body, null);
  assert.equal((await call("/security/sessions/revoke-others", {}, sessionA)).response.status, 200);
  assert.equal((await call("/get-session", undefined, sessionC)).body, null);
  assert.ok((await call("/get-session", undefined, sessionA)).body?.user);
  assert.equal((await call("/security/sessions/revoke-all", {}, sessionA)).response.status, 200);
  assert.equal((await call("/get-session", undefined, sessionA)).body, null);
  pass("T15:opaque session projection, cross-user rejection, specified/other/all revocation");

  const contactA = await legacyFixture(), contactB = await legacyFixture();
  const contactJarA = o.jar(), contactJarB = o.jar();
  for (const [f, j] of [[contactA, contactJarA], [contactB, contactJarB]] as const) assert.equal((await call("/sign-in/phone-number", { phoneNumber: f.number, password: f.value }, j)).response.status, 200);
  const sharedPhone = "+8613900090001";
  const currentA = await proof("phone", "phone", sharedPhone, contactJarA), currentB = await proof("phone", "phone", sharedPhone, contactJarB);
  const targetA = await proof("phone", "phone", sharedPhone, contactJarA, "target", currentA), targetB = await proof("phone", "phone", sharedPhone, contactJarB, "target", currentB);
  const contacts = await Promise.all([call("/security/phone", { proofId: currentA, targetProofId: targetA }, contactJarA), call("/security/phone", { proofId: currentB, targetProofId: targetB }, contactJarB)]);
  assert.deepEqual(contacts.map(r => r.response.status).sort(), [200, 409]);
  const loser = contacts[0].response.status === 409 ? contactA : contactB;
  assert.equal((await o.runtime.query(`SELECT "phoneNumber" FROM zzsh_auth_user."user" WHERE id=$1`, [loser.id])).rows[0].phoneNumber, loser.number);
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1`, [sharedPhone])).rows[0].n, 1);
  const loserJar = contacts[0].response.status === 409 ? contactJarA : contactJarB;
  const occupiedEmail = await proof("email", "phone", email, loserJar);
  const occupiedEmailTarget = await proof("email", "email", email, loserJar, "target", occupiedEmail);
  assert.equal((await call("/security/email", { proofId: occupiedEmail, targetProofId: occupiedEmailTarget }, loserJar)).response.status, 409);
  assert.equal((await call("/security/overview", undefined, loserJar)).body?.email, null);
  pass("T10/T13:concurrent phone ownership has one winner; occupied email leaves old contact unchanged");

  const rollback = await legacyFixture(), rollbackJar = o.jar();
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: rollback.number, password: rollback.value }, rollbackJar)).response.status, 200);
  const rollbackProof = await proof("password", "phone", undefined, rollbackJar);
  const credentialBefore = (await o.runtime.query(`SELECT md5(password) AS digest FROM zzsh_auth_user.account WHERE "userId"=$1`, [rollback.id])).rows[0].digest;
  await o.migration.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeRole}"`);
  try { assert.equal((await call("/security/password", { proofId: rollbackProof, newPassword }, rollbackJar)).response.status, 500); }
  finally { await o.migration.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeRole}"`); }
  assert.equal((await o.runtime.query(`SELECT md5(password) AS digest FROM zzsh_auth_user.account WHERE "userId"=$1`, [rollback.id])).rows[0].digest, credentialBefore);
  assert.ok((await call("/get-session", undefined, rollbackJar)).body?.user);
  assert.equal((await call("/security/operation", { operationId: rollbackProof }, rollbackJar)).body?.status, "unconfirmed");
  assert.equal((await call("/security/operation", { operationId: rollbackProof }, foreignJar)).response.status, 403);
  await o.migration.query(`UPDATE zzsh_auth_user.verification SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [rollbackProof]);
  const receiptRace = await Promise.all([call("/security/operation", { operationId: rollbackProof }, rollbackJar), call("/security/password", { proofId: rollbackProof, newPassword }, rollbackJar)]);
  assert.equal(receiptRace[0].body?.status, "expired"); assert.equal(receiptRace[1].response.status, 400);
  await o.migration.query(`UPDATE zzsh_auth_user.verification SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [resetProof]);
  assert.equal((await call("/security/operation", { operationId: resetProof })).body?.status, "completed");
  pass("T14/T17:audit failure rolls back all sensitive facts; locked receipt expiry forbids late commit, completed receipt survives expiry");

  const held = await legacyFixture(), heldJar = o.jar();
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: held.number, password: held.value }, heldJar)).response.status, 200);
  const heldProof = await proof("password", "phone", undefined, heldJar);
  const blocker = await o.migration.connect(); await blocker.query("BEGIN"); await blocker.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [held.id]);
  let commitSettled = false, receiptSettled = false;
  const delayedCommit = call("/security/password", { proofId: heldProof, newPassword }, heldJar).then(r => { commitSettled = true; return r; });
  const delayedReceipt = call("/security/operation", { operationId: heldProof }, heldJar).then(r => { receiptSettled = true; return r; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(commitSettled, false); assert.equal(receiptSettled, false); }
  finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const [commitOutcome, receiptOutcome] = await Promise.all([delayedCommit, delayedReceipt]);
  assert.equal(commitOutcome.response.status, 200); assert.ok(["unconfirmed", "completed"].includes(receiptOutcome.body?.status));
  assert.equal((await call("/security/operation", { operationId: heldProof }, heldJar)).body?.status, "completed");
  pass("T17:actual PG lock blocks both late commit and receipt; serialized receipt never falsely reports unused expiry");

  const oneTimePhone = "+8613900090002";
  assert.equal((await call("/phone-registration/send-otp", { phoneNumber: oneTimePhone })).response.status, 200);
  const oneTimeCode = o.sms.get("phone-registration:" + oneTimePhone)!.code;
  const consumption = await Promise.all([call("/phone-registration/complete", { phoneNumber: oneTimePhone, code: oneTimeCode, acceptedTerms: true, loginOrRegister: true }), call("/phone-registration/complete", { phoneNumber: oneTimePhone, code: oneTimeCode, acceptedTerms: true, loginOrRegister: true })]);
  assert.deepEqual(consumption.map(r => r.response.status).sort(), [200, 400]);
  assert.equal((await o.runtime.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1`, [oneTimePhone])).rows[0].n, 1);
  pass("T09:two simultaneous OTP consumers create exactly one subject and consume once");

  const expiring = await legacyFixture(), expiringJar = o.jar();
  assert.equal((await call("/sign-in/phone-number", { phoneNumber: expiring.number, password: expiring.value }, expiringJar)).response.status, 200);
  const expiringProof = await proof("password", "phone", undefined, expiringJar);
  const expirationCredential = (await o.runtime.query(`SELECT md5(password) AS digest FROM zzsh_auth_user.account WHERE "userId"=$1`, [expiring.id])).rows[0].digest;
  await o.migration.query(`UPDATE zzsh_auth_user.session SET "expiresAt"=clock_timestamp()+interval '200 milliseconds' WHERE "userId"=$1`, [expiring.id]);
  const expiryBlocker = await o.migration.connect(); await expiryBlocker.query("BEGIN"); await expiryBlocker.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [expiring.id]);
  const expiringWrite = call("/security/password", { proofId: expiringProof, newPassword }, expiringJar);
  try { await new Promise(resolve => setTimeout(resolve, 300)); } finally { await expiryBlocker.query("ROLLBACK"); expiryBlocker.release(); }
  assert.equal((await expiringWrite).response.status, 401);
  assert.equal((await o.runtime.query(`SELECT md5(password) AS digest FROM zzsh_auth_user.account WHERE "userId"=$1`, [expiring.id])).rows[0].digest, expirationCredential);
  assert.equal((await call("/get-session", undefined, expiringJar)).body, null);
  pass("T14:session expiry while waiting for the subject lock cannot commit sensitive change or extend lifetime");

  console.log("AUTH_FULL_PG_CHECKS " + JSON.stringify(checked));
}
