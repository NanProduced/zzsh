import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const container=process.argv[2];
assert(/^[a-f0-9]{64}$/.test(container??''),'EXACT_SYNTHETIC_CONTAINER_ID_REQUIRED');
const inspect=spawnSync('docker',['inspect',container],{encoding:'utf8',windowsHide:true});assert.equal(inspect.status,0,'SYNTHETIC_CONTAINER_UNAVAILABLE');
const info=JSON.parse(inspect.stdout)[0];assert(info.Id===container&&info.Config.Labels?.['zzsh.task']==='round07-constraint-proof'&&info.HostConfig.NetworkMode==='none'
  &&Object.keys(info.HostConfig.PortBindings??{}).length===0&&info.HostConfig.Tmpfs?.['/var/lib/postgresql/data']&&info.Mounts.length===0,'SYNTHETIC_CONTAINER_IDENTITY_CHANGED');
const baseline=readFileSync(join(root,'apps/api/migrations/business/0061_distribution_policy_and_relations.sql'),'utf8');
const start=baseline.indexOf('CREATE FUNCTION zzsh_order.check_distribution_relation_knowledge()'),end=baseline.indexOf('END $$;',start);
assert(start>=0&&end>start,'ORIGINAL_GUARD_SOURCE_MISSING');const original=baseline.slice(start,end+'END $$;'.length);
const migration=readFileSync(join(root,'apps/api/migrations/business/0161_distribution_relation_guard_indexed.sql'),'utf8');
const functionStart=migration.indexOf('CREATE OR REPLACE FUNCTION');assert(functionStart>0,'MIGRATION_PREFLIGHT_MISSING');const preflight=migration.slice(0,functionStart);
const replicaChecks=[['distribution_participant','distribution_participant_knowledge_guard'],['invitation_relation','invitation_relation_knowledge_guard']].map(([table,trigger])=>String.raw`
BEGIN;
ALTER TABLE zzsh_order.${table} ENABLE REPLICA TRIGGER ${trigger};
DO $replica_proof$
BEGIN
 BEGIN
  EXECUTE $migration_preflight$${preflight}$migration_preflight$;
  RAISE EXCEPTION 'EXPECTED_REPLICA_ONLY_REJECTION';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'DISTRIBUTION_RELATION_KNOWLEDGE_GUARD_INCOMPLETE' THEN RAISE; END IF;
 END;
END $replica_proof$;
ROLLBACK;
`).join('\n');
const alteredTriggerChecks=String.raw`
BEGIN;
SET LOCAL session_replication_role='replica';
DO $role_proof$
BEGIN
 BEGIN EXECUTE $migration_preflight$${preflight}$migration_preflight$; RAISE EXCEPTION 'EXPECTED_REPLICA_SESSION_REJECTION';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'DISTRIBUTION_RELATION_KNOWLEDGE_GUARD_INCOMPLETE' THEN RAISE; END IF; END;
END $role_proof$;
ROLLBACK;
BEGIN;
DROP TRIGGER distribution_participant_knowledge_guard ON zzsh_order.distribution_participant;
CREATE CONSTRAINT TRIGGER distribution_participant_knowledge_guard AFTER INSERT ON zzsh_order.distribution_participant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();
DO $event_proof$
BEGIN
 BEGIN EXECUTE $migration_preflight$${preflight}$migration_preflight$; RAISE EXCEPTION 'EXPECTED_INCOMPLETE_EVENTS_REJECTION';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'DISTRIBUTION_RELATION_KNOWLEDGE_GUARD_INCOMPLETE' THEN RAISE; END IF; END;
END $event_proof$;
ROLLBACK;
`;
const sql=String.raw`
CREATE SCHEMA zzsh_order;
CREATE TABLE zzsh_order.distribution_participant(user_id text PRIMARY KEY,inviter_knowledge text NOT NULL,leader_knowledge text NOT NULL,revision int NOT NULL DEFAULT 1);
CREATE TABLE zzsh_order.invitation_relation(id bigserial PRIMARY KEY,type text NOT NULL CHECK(type IN('INVITER','DISTRIBUTION_LEADER')),
 child_user_id text NOT NULL REFERENCES zzsh_order.distribution_participant(user_id),UNIQUE(type,child_user_id));
INSERT INTO zzsh_order.distribution_participant(user_id,inviter_knowledge,leader_knowledge)
 SELECT 'u'||lpad(i::text,5,'0'),CASE WHEN i<=11450 OR i=20001 THEN 'KNOWN_PARENT' ELSE 'KNOWN_NONE' END,
 CASE WHEN i<=11450 OR i=20000 THEN 'KNOWN_PARENT' ELSE 'KNOWN_NONE' END FROM generate_series(1,25000) i;
INSERT INTO zzsh_order.invitation_relation(type,child_user_id)
 SELECT t.type,'u'||lpad(i::text,5,'0') FROM generate_series(1,11450) i CROSS JOIN (VALUES('INVITER'),('DISTRIBUTION_LEADER')) t(type);
INSERT INTO zzsh_order.invitation_relation(type,child_user_id) VALUES('DISTRIBUTION_LEADER','u20000'),('INVITER','u20001');
ANALYZE zzsh_order.distribution_participant;ANALYZE zzsh_order.invitation_relation;
${original}
CREATE CONSTRAINT TRIGGER distribution_participant_knowledge_guard AFTER INSERT OR UPDATE ON zzsh_order.distribution_participant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();
CREATE CONSTRAINT TRIGGER invitation_relation_knowledge_guard AFTER INSERT ON zzsh_order.invitation_relation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();
SET statement_timeout='30s';
BEGIN;
UPDATE zzsh_order.distribution_participant SET revision=revision+1 WHERE user_id BETWEEN 'u00001' AND 'u01000';
SELECT clock_timestamp() AS original_started \gset
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'ORIGINAL_1000_MS='||round(extract(epoch FROM (clock_timestamp()-:'original_started'::timestamptz))*1000)::text;
ROLLBACK;
${migration}
${migration}
${replicaChecks}
${alteredTriggerChecks}
DO $proof$
DECLARE differences integer;
BEGIN
 WITH cases(id) AS (VALUES(1),(2),(3),(4)), rows(id,type) AS (VALUES(1,'INVITER'),(1,'DISTRIBUTION_LEADER'),(1,'OTHER'),(2,'INVITER'),(2,NULL),(3,'DISTRIBUTION_LEADER'),(4,'OTHER')),
 old_counts AS (SELECT c.id,count(*) FILTER(WHERE r.type='INVITER') a,count(*) FILTER(WHERE r.type='DISTRIBUTION_LEADER') b FROM cases c LEFT JOIN rows r ON r.id=c.id GROUP BY c.id),
 new_counts AS (SELECT c.id,count(*) FILTER(WHERE r.type='INVITER') a,count(*) FILTER(WHERE r.type='DISTRIBUTION_LEADER') b FROM cases c LEFT JOIN rows r ON r.id=c.id AND r.type IN('INVITER','DISTRIBUTION_LEADER') GROUP BY c.id)
 SELECT count(*) INTO differences FROM old_counts o JOIN new_counts n USING(id) WHERE o.a<>n.a OR o.b<>n.b;
 IF differences<>0 THEN RAISE EXCEPTION 'PREDICATE_SEMANTICS_CHANGED';END IF;
 BEGIN
  UPDATE zzsh_order.distribution_participant SET inviter_knowledge='KNOWN_PARENT' WHERE user_id='u24000';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'EXPECTED_INVITER_CONSTRAINT_FAILURE';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'invitation relation and participant knowledge disagree' THEN RAISE; END IF;
 END;
 BEGIN
  UPDATE zzsh_order.distribution_participant SET leader_knowledge='KNOWN_NONE' WHERE user_id='u20000';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'EXPECTED_LEADER_CONSTRAINT_FAILURE';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'invitation relation and participant knowledge disagree' THEN RAISE; END IF;
 END;
 BEGIN
  INSERT INTO zzsh_order.invitation_relation(type,child_user_id) VALUES('OTHER','u24000');
  RAISE EXCEPTION 'EXPECTED_TYPE_CONSTRAINT_FAILURE';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $proof$;
BEGIN;
UPDATE zzsh_order.distribution_participant SET inviter_knowledge='KNOWN_PARENT' WHERE user_id='u24000';
INSERT INTO zzsh_order.invitation_relation(type,child_user_id) VALUES('INVITER','u24000');
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
BEGIN;
UPDATE zzsh_order.distribution_participant SET revision=revision+1 WHERE user_id BETWEEN 'u00001' AND 'u05000';
SELECT clock_timestamp() AS indexed_started \gset
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'INDEXED_5000_MS='||round(extract(epoch FROM (clock_timestamp()-:'indexed_started'::timestamptz))*1000)::text;
ROLLBACK;
SELECT 'SYNTHETIC_TRIGGER_PROOF_PASS';
`;
const run=spawnSync('docker',['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-tA'],{input:sql,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
if(run.status!==0||run.signal)throw Error('SYNTHETIC_GUARD_PROOF_FAILED:'+String(run.stderr).slice(0,1200));
const originalMs=Number(run.stdout.match(/ORIGINAL_1000_MS=(\d+)/)?.[1]),indexedMs=Number(run.stdout.match(/INDEXED_5000_MS=(\d+)/)?.[1]);
assert(Number.isFinite(originalMs)&&originalMs>0&&Number.isFinite(indexedMs)&&indexedMs>0&&run.stdout.includes('SYNTHETIC_TRIGGER_PROOF_PASS'),'SYNTHETIC_TIMING_REQUIRED');
console.log(JSON.stringify({status:'SYNTHETIC_TRIGGER_PROOF_PASS',originalSubjects:1000,originalMs,indexedSubjects:5000,indexedMs,migrationReplay:2,
  cases:['none','inviter-only','leader-only','both','other-and-null-predicate','mismatched-inviter','mismatched-leader','illegal-type','same-transaction-relation','replica-only-participant-guard','replica-only-relation-guard','replica-session','incomplete-trigger-events'],syntheticOnly:true,container}));
