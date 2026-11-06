import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import time

fixture_root = Path('/var/lib/docker/volumes/zzsh-ecs-dump-fixture-20261105/_data')
volume = Path(os.environ['FIXTURE_VOLUME_PATH'])
if not volume.is_absolute() or volume.parent != fixture_root or not volume.name.startswith('run-') or volume.exists():
    raise RuntimeError('new dedicated synthetic fixture directory required')
label = subprocess.run(['docker','volume','inspect','zzsh-ecs-dump-fixture-20261105','--format','{{index .Labels "zzsh.task"}}'],
                       stdout=subprocess.PIPE,check=True).stdout.decode().strip()
if label != 'ecs-dump-orchestration-synthetic': raise RuntimeError('dedicated synthetic volume label required')
for project_name in ('zzsh-ecs-test-fixturesource','zzsh-ecs-test-fixture','zzsh-ecs-test-fixtureretry'):
    result = subprocess.run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project_name],stdout=subprocess.PIPE,check=True)
    if result.stdout.strip(): raise RuntimeError('fixture project is already in use')
if not volume.exists(): volume.mkdir(mode=0o700)
project = volume / 'project'
private = volume / 'restricted'
secrets = volume / 'secrets'
source_repo = Path('/source')
if project.exists() or private.exists() or secrets.exists(): raise RuntimeError('fixture paths already exist')
project.mkdir(); (project/'deploy').mkdir(); shutil.copytree(source_repo/'deploy/ecs-test',project/'deploy/ecs-test')
compose_file = project/'deploy/ecs-test/compose.yaml'
text = compose_file.read_text()
if text.count('      - postgres_data:/var/lib/postgresql/data') != 1 or text.count('      - redis_data:/data') != 1:
    raise RuntimeError('expected isolated tmpfs replacement is unavailable')
text = text.replace('      - postgres_data:/var/lib/postgresql/data', '      - type: tmpfs\n        target: /var/lib/postgresql/data\n        tmpfs:\n          size: 805306368')
text = text.replace('      - redis_data:/data', '      - type: tmpfs\n        target: /data\n        tmpfs:\n          size: 134217728')
compose_file.write_text(text)
subprocess.run(['bash',str(project/'deploy/ecs-test/create-internal-secrets.sh'),str(secrets)],check=True,stdout=subprocess.DEVNULL)
private.mkdir(mode=0o700)
api_env = private/'api.env'; env_file = private/'compose.env'
api = secrets/'api'
keys={}
for index,name in enumerate(['auth_user_secret','auth_admin_secret','user_identity_subject_hmac','order_confirmation_secret','listing_cursor_secret']):
    file=api/name; file.write_text(chr(65+index)*40);file.chmod(0o640)
    keys[name]=hashlib.sha256(file.read_bytes()).hexdigest()
for index,name in enumerate(['admin_altcha_hmac','user_auth_throttle_hmac']):
    file=api/name;file.write_text(chr(88+index)*40);file.chmod(0o640)
for name in ['yunxin_app_secret','sms_id','sms_secret','real_id','real_secret']:
    file=api/name;file.write_text('synthetic-provider-'+name);file.chmod(0o640)
api_env.write_text('\n'.join([
    'AUTH_USER_SECRET_FILE=.secrets/auth_user_secret','AUTH_ADMIN_SECRET_FILE=.secrets/auth_admin_secret',
    'ADMIN_ALTCHA_HMAC_KEY_FILE=.secrets/admin_altcha_hmac','USER_AUTH_THROTTLE_HMAC_KEY_FILE=.secrets/user_auth_throttle_hmac',
    'ORDER_CONFIRMATION_KEY_ID=fixture_order_v1','LISTING_CURSOR_KEY_ID=fixture_cursor_v1',
    'USER_IDENTITY_SUBJECT_HMAC_KEY_FILE=.secrets/user_identity_subject_hmac','ORDER_CONFIRMATION_SECRET_FILE=.secrets/order_confirmation_secret',
    'LISTING_CURSOR_SECRET_FILE=.secrets/listing_cursor_secret','USER_SMS_PROVIDER=aliyun','USER_REAL_NAME_PROVIDER=aliyun-id2meta',
    'YUNXIN_APP_KEY=fixture-app','YUNXIN_APP_SECRET_FILE=.secrets/yunxin_app_secret','ORDER_IM_EVENTS_ENABLED=true',
    'ORDER_IM_EVENTS_APP_KEY=fixture-app','ORDER_IM_EVENTS_APP_SECRET_FILE=.secrets/yunxin_app_secret','MEDIA_STORAGE=oss',
    'USER_SMS_ACCESS_KEY_ID_FILE=.secrets/sms_id','USER_SMS_ACCESS_KEY_SECRET_FILE=.secrets/sms_secret',
    'USER_REAL_NAME_ACCESS_KEY_ID_FILE=.secrets/real_id','USER_REAL_NAME_ACCESS_KEY_SECRET_FILE=.secrets/real_secret',
    'USER_SMS_SIGN_NAME=fixture','USER_SMS_TEMPLATE_CODE=SMS_FIXTURE','ALIBABA_CLOUD_ACCESS_KEY_ID=fixture','ALIBABA_CLOUD_ACCESS_KEY_SECRET=fixture',
    'OSS_BUCKET=fixture','OSS_REGION=oss-cn-hongkong','OSS_ENDPOINT=https://oss.invalid','OSS_OBJECT_PREFIX=fixture/',
    'USER_REAL_NAME_DAILY_LIMIT=10','USER_REAL_NAME_MIN_INTERVAL_SECONDS=10'])+'\n');api_env.chmod(0o600)
env_file.write_text('\n'.join([
    'ZZSH_TEST_IMAGE_TAG=dump-fixture-20261105','ZZSH_TEST_ACME_EMAIL=ops@example.invalid',f'ZZSH_TEST_SECRETS_DIR={secrets}',f'ZZSH_TEST_API_ENV_FILE={api_env}',
    'ZZSH_TEST_WEB_SUBNET=10.253.240.0/28','ZZSH_TEST_PROXY_WEB_IP=10.253.240.2','ZZSH_TEST_WEB_EDGE_IP=10.253.240.3',
    'ZZSH_TEST_APP_SUBNET=10.253.241.0/28','ZZSH_TEST_PROXY_APP_IP=10.253.241.2','ZZSH_TEST_WEB_APP_IP=10.253.241.3','ZZSH_TEST_API_APP_IP=10.253.241.4',
    'ZZSH_TEST_DATA_SUBNET=10.253.242.0/28','ZZSH_TEST_API_DATA_IP=10.253.242.2','ZZSH_TEST_PG_IP=10.253.242.3','ZZSH_TEST_REDIS_IP=10.253.242.4'])+'\n');env_file.chmod(0o600)
spec=importlib.util.spec_from_file_location('restore',project/'deploy/ecs-test/restore_approved_dump.py');restore=importlib.util.module_from_spec(spec);spec.loader.exec_module(restore)
def invoke(*args,check=True,env=None):
    run=subprocess.run([sys.executable,str(project/'deploy/ecs-test/restore_approved_dump.py'),*map(str,args)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
    if check and run.returncode: raise RuntimeError('CLI failed: '+run.stderr.decode()[-1000:])
    return run
def setup_source():
    c=restore.Compose('zzsh-ecs-test-fixturesource',compose_file,env_file)
    c.call('up','-d','--wait','--wait-timeout','120','postgres','redis',capture=False)
    c.call('--profile','tools','run','--rm','db-setup',capture=False)
    c.call('--profile','tools','run','--rm','migration','--initial','--baseline','release_production_0153',capture=False,timeout=3600)
    c.sql(restore.DATABASE,"INSERT INTO zzsh_auth_user.\"user\"(id,name,email,\"createdAt\",\"updatedAt\") VALUES('fixture_user','fixture','fixture@invalid',now(),now());",readonly=False)
    c.sql(restore.DATABASE,"""INSERT INTO zzsh_iam.membership_growth_policy
      (id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash)
      VALUES ('fixture-policy',1,'APPROVED','2026-11-01T00:00:00Z','fixture-rule','fixture-price','fixture','membership-growth-v1','{}'::jsonb,repeat('a',64));
      INSERT INTO zzsh_iam.membership_growth_contribution
      (id,user_id,game_id,source_key,source_type,source_id,settlement_version,revision,effective_at,recorded_at,amount_cents,state,eligible,source_digest)
      VALUES ('fixture-contribution','fixture_user','fixture-game','fixture-source','RENTAL_SETTLEMENT','fixture-order','1',0,
        '2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',123,'SETTLED',true,repeat('b',64));""",readonly=False)
    c.sql(restore.DATABASE,'SET ROLE zzsh_ecs_migration; CREATE SEQUENCE zzsh_iam.fixture_default_sequence; RESET ROLE;',readonly=False)
    acl_catalog=json.loads(c.sql(restore.DATABASE,(project/'deploy/ecs-test/acl-snapshot-catalog.sql').read_text()))
    assert acl_catalog['schema']=='zzsh.acl-snapshot-catalog.v1' and acl_catalog['transactionReadOnly']=='on'
    assert acl_catalog['transactionIsolation']=='repeatable read' and acl_catalog['transactionSnapshot']
    restricted=[o for o in acl_catalog['objects'] if o['kind']=='routine' and o['identity'].get('name')=='assert_personal_growth_order_v4']
    assert len(restricted)==1 and not any(g['grantee']=='PUBLIC' for g in restricted[0]['acl'])
    assert any(o['kind']=='column' and o['acl'] for o in acl_catalog['objects'])
    sequences=[o for o in acl_catalog['objects'] if o['kind']=='relation' and o['identity'].get('name')=='fixture_default_sequence']
    assert len(sequences)==1 and {'SELECT','UPDATE','USAGE'} <= {g['privilege'] for g in sequences[0]['acl'] if g['grantee']=='zzsh_ecs_migration'}
    args=[*c.prefix,'--profile','tools','run','--rm','-T','--no-deps','--entrypoint','node',
          '--volume',str(project/'deploy/ecs-test')+':/fixture:ro','migration','/fixture/tests/acl-snapshot-live-test.cjs']
    reader=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    changed=False
    try:
        if not select.select([reader.stdout],[],[],60)[0]: raise RuntimeError('synthetic snapshot reader did not become ready')
        line=reader.stdout.readline()
        if not line: raise RuntimeError('synthetic snapshot reader stopped before export')
        captured=json.loads(line);token=captured['snapshotToken'];assert re.fullmatch(r'[0-9A-Fa-f-]+',token)
        c.sql(restore.DATABASE,'GRANT EXECUTE ON FUNCTION zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order) TO PUBLIC;',readonly=False)
        changed=True
        shell='export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec pg_dump -w --format=custom --no-owner -h postgres -U zzsh_bootstrap -d zzsh_ecs_test --snapshot="$1"'
        proof_dump=private/'synthetic-snapshot-acl.dump'
        with proof_dump.open('wb') as output:
            dumped=subprocess.run([*c.prefix,'exec','-T','postgres','sh','-ceu',shell,'sh',token],stdout=output,stderr=subprocess.PIPE,timeout=180)
        assert dumped.returncode==0
        with proof_dump.open('rb') as input_stream:
            decoded=subprocess.run(['docker','run','--rm','--network','none','--read-only','-i','--entrypoint','pg_restore',
                'postgres:16-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50',
                '--schema-only','--no-owner','--file=-'],stdin=input_stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
        assert decoded.returncode==0 and re.search(rb'REVOKE ALL ON FUNCTION zzsh_order\.assert_personal_growth_order_v4\([^;]+ FROM PUBLIC;',decoded.stdout)
    finally:
        if changed: c.sql(restore.DATABASE,'REVOKE EXECUTE ON FUNCTION zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order) FROM PUBLIC;',readonly=False)
        if reader.poll() is None:
            reader.stdin.write('finish\n');reader.stdin.flush()
        out,err=reader.communicate(timeout=30)
        if reader.returncode!=0 or 'ROLLBACK_ACK' not in out: raise RuntimeError('synthetic snapshot reader rollback was not confirmed')
    print('ACL capture and pg_dump share exported snapshot despite later synthetic ACL change: PASS',flush=True)
    actual=restore.readback(c)
    c.sql('postgres','BEGIN; ALTER ROLE zzsh_ecs_migration RENAME TO zzsh_fixture_source_m; ALTER ROLE zzsh_ecs_runtime RENAME TO zzsh_fixture_source_r; COMMIT;',readonly=False)
    try:
        renamed_acl=json.loads(c.sql(restore.DATABASE,(project/'deploy/ecs-test/acl-snapshot-catalog.sql').read_text()))
        shell='export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec pg_dump -w --format=custom -h postgres -U zzsh_bootstrap -d zzsh_ecs_test'
        role_dump=private/'synthetic-source-roles.dump'
        with role_dump.open('wb') as out:
            result=subprocess.run([*c.prefix,'exec','-T','postgres','sh','-ceu',shell],stdout=out,stderr=subprocess.PIPE)
        if result.returncode: raise RuntimeError('synthetic owner-and-ACL pg_dump failed')
        role_dump.chmod(0o600)
    finally:
        c.sql('postgres','BEGIN; ALTER ROLE zzsh_fixture_source_m RENAME TO zzsh_ecs_migration; ALTER ROLE zzsh_fixture_source_r RENAME TO zzsh_ecs_runtime; COMMIT;',readonly=False)
    assert actual['tables']['rentalMembership']==1 and actual['tables']['membershipPolicy']==1 and actual['tables']['membershipContribution']==1
    shell='export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec pg_dump -w --format=custom --no-owner --no-acl -h postgres -U zzsh_bootstrap -d zzsh_ecs_test'
    dump=private/'source.dump'
    with dump.open('wb') as out:
        result=subprocess.run([*c.prefix,'exec','-T','postgres','sh','-ceu',shell],stdout=out,stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('fixture pg_dump failed')
    dump.chmod(0o600)
    tree=restore.migration_tree_hash(c)
    c.call('down','--remove-orphans',capture=False)
    return dump,actual,tree,acl_catalog,role_dump,renamed_acl
dump,actual,tree,source_acl,role_dump,renamed_acl=setup_source()
keynames={'AUTH_USER_SECRET_FILE':'auth_user_secret','AUTH_ADMIN_SECRET_FILE':'auth_admin_secret',
    'USER_IDENTITY_SUBJECT_HMAC_KEY_FILE':'user_identity_subject_hmac','ORDER_CONFIRMATION_SECRET_FILE':'order_confirmation_secret',
    'LISTING_CURSOR_SECRET_FILE':'listing_cursor_secret'}
base={'schema':'zzsh.ecs-test-approved-dump.v1','project':'zzsh-ecs-test-fixture',
      'dump':{'path':str(dump),'sha256':restore.digest_file(dump),'bytes':dump.stat().st_size},
      'source':{'postgresMajor':16,'cutoff':'2026-11-05T00:00:00Z','datasetSha256':'a'*64,'migrationTreeSha256':tree,
                'journalHashes':actual['journal'],'reviewedAuthArtifacts':'sanitized-approved'},
      'keys':{variable:keys[filename] for variable,filename in keynames.items()},'bankVersions':[],
      'expected':{'tables':actual['tables'],'ledgerDebitCents':actual['ledgerDebitCents'],'ledgerCreditCents':actual['ledgerCreditCents']},'startServices':False}
def put(path,value): path.write_text(json.dumps(value));path.chmod(0o600);return restore.digest_file(path)
def prepare(name,project_name):
    data=dict(base,project=project_name); manifest=private/(name+'-manifest.json'); msh=put(manifest,data);plan=private/(name+'-plan.json')
    result=invoke('plan','--manifest',manifest,'--manifest-sha256',msh,'--env-file',env_file,'--private-root',private,'--out',plan)
    assert json.loads(result.stdout)['status']=='PLAN_READY'; psh=restore.digest_file(plan)
    now=dt.datetime.now(dt.timezone.utc); stamp=lambda x:x.isoformat().replace('+00:00','Z')
    approval=private/(name+'-approval.json');ash=put(approval,{'schema':'zzsh.ecs-test-dump-approval.v1','decision':'APPROVED','planSha256':psh,
        'manifestSha256':msh,'notBefore':stamp(now-dt.timedelta(minutes=1)),'expiresAt':stamp(now+dt.timedelta(hours=1))})
    return data,manifest,msh,plan,psh,approval,ash,private/('restore-'+name)
def apply_args(x):
    _,_,_,plan,psh,approval,ash,run=x
    return ['apply','--plan',plan,'--plan-sha256',psh,'--approval',approval,'--approval-sha256',ash,'--run-dir',run]
def close_project(name):
    restore.Compose(name,compose_file,env_file).call('down','--remove-orphans',capture=False)

first=prepare('success','zzsh-ecs-test-fixture')
result=invoke(*apply_args(first));assert json.loads(result.stdout)['status']=='RESTORE_DATA_ONLY_ACL_UNVERIFIED'
checkpoint=json.loads((first[-1]/'checkpoint.json').read_text()); c=restore.Compose('zzsh-ecs-test-fixture',compose_file,env_file)
assert restore.admission_status(c,checkpoint)=='EXACT'
assert restore.readback_matches(restore.readback(c),first[0])
restored_acl=json.loads(c.sql(restore.DATABASE,(project/'deploy/ecs-test/acl-snapshot-catalog.sql').read_text()))
v4=[o for o in restored_acl['objects'] if o['kind']=='routine' and o['identity'].get('name')=='assert_personal_growth_order_v4']
assert len(v4)==1 and any(g['grantee']=='PUBLIC' and g['privilege']=='EXECUTE' for g in v4[0]['acl'])
sys.path.insert(0,str(project/'deploy/ecs-test'))
import acl_snapshot_compare
mapping={role['name']:role['name'] for role in source_acl['roles']}
assert not acl_snapshot_compare.compare(source_acl,restored_acl,mapping)['matches']
print('source/restore ACL discrepancy is detected and application startup remains disabled: PASS',flush=True)
for name in ('rentalMembership','membershipLegacyCoverage','membershipContribution','membershipPolicy','membershipLegacyReadAdmission'):
    altered=dict(first[0],expected=dict(first[0]['expected'],tables=dict(first[0]['expected']['tables'])))
    altered['expected']['tables'][name]+=1
    assert not restore.readback_matches(restore.readback(c),altered)
for column in ('resource_oid','database_name','runtime_role','resource_marker'):
    c.sql(restore.DATABASE,f'GRANT INSERT ({column}) ON zzsh_order.native_origin_resource_admission TO zzsh_ecs_runtime;',readonly=False)
    try:
        try: restore.admission_status(c,checkpoint)
        except restore.Refused as error: assert str(error)=='NATIVE_ADMISSION_ACL_OR_GUARD_INVALID'
        else: raise AssertionError('column INSERT grant accepted')
    finally:
        c.sql(restore.DATABASE,f'REVOKE INSERT ({column}) ON zzsh_order.native_origin_resource_admission FROM zzsh_ecs_runtime;',readonly=False)
for grantee,privilege in (('zzsh_ecs_runtime','UPDATE'),('PUBLIC','INSERT'),('PUBLIC','UPDATE')):
    c.sql(restore.DATABASE,f'GRANT {privilege} (resource_oid) ON zzsh_order.native_origin_resource_admission TO {grantee};',readonly=False)
    try:
        try: restore.admission_status(c,checkpoint)
        except restore.Refused as error: assert str(error)=='NATIVE_ADMISSION_ACL_OR_GUARD_INVALID'
        else: raise AssertionError('column/public grant accepted')
    finally:
        c.sql(restore.DATABASE,f'REVOKE {privilege} (resource_oid) ON zzsh_order.native_origin_resource_admission FROM {grantee};',readonly=False)
c.sql(restore.DATABASE,'CREATE ROLE zzsh_fixture_bank_parent NOLOGIN; GRANT INSERT (resource_oid) ON zzsh_order.native_origin_resource_admission TO zzsh_fixture_bank_parent; GRANT zzsh_fixture_bank_parent TO zzsh_ecs_runtime;',readonly=False)
try:
    try: restore.admission_status(c,checkpoint)
    except restore.Refused as error: assert str(error)=='NATIVE_ADMISSION_ACL_OR_GUARD_INVALID'
    else: raise AssertionError('inherited column grant accepted')
finally:
    c.sql(restore.DATABASE,'REVOKE zzsh_fixture_bank_parent FROM zzsh_ecs_runtime; REVOKE INSERT (resource_oid) ON zzsh_order.native_origin_resource_admission FROM zzsh_fixture_bank_parent; DROP ROLE zzsh_fixture_bank_parent;',readonly=False)
assert restore.admission_status(c,checkpoint)=='EXACT'
c.sql(restore.DATABASE,'ALTER TABLE zzsh_order.native_origin_resource_admission DISABLE TRIGGER native_origin_resource_admission_no_truncate;',readonly=False)
try:
    try: restore.admission_status(c,checkpoint)
    except restore.Refused as error: assert str(error)=='NATIVE_ADMISSION_ACL_OR_GUARD_INVALID'
    else: raise AssertionError('disabled native origin guard accepted')
finally:
    c.sql(restore.DATABASE,'ALTER TABLE zzsh_order.native_origin_resource_admission ENABLE TRIGGER native_origin_resource_admission_no_truncate;',readonly=False)
assert restore.admission_status(c,checkpoint)=='EXACT'
repeat=invoke(*apply_args(first),check=False);assert repeat.returncode!=0
conflict=invoke('plan','--manifest',first[1],'--manifest-sha256',first[2],'--env-file',env_file,'--private-root',private,'--out',private/'conflict-plan.json',check=False)
assert conflict.returncode!=0 and b'TARGET_ALREADY_EXISTS' in conflict.stderr
print('success, column/public/inherited ACL and disabled guard refusal, repeat and nonempty target conflict: PASS',flush=True)
close_project('zzsh-ecs-test-fixture')

retry=prepare('retry','zzsh-ecs-test-fixtureretry')
wrapper=volume/'bin';wrapper.mkdir();marker=volume/'interrupt-marker'; binary=wrapper/'docker'
binary.write_text('#!/bin/sh\ncase "$*" in *"pg_restore -w --single-transaction"*) touch "$FIXTURE_INTERRUPT_MARKER"; sleep 60;; esac\nexec /usr/local/bin/docker "$@"\n');binary.chmod(0o700)
env=dict(os.environ,PATH=str(wrapper)+':'+os.environ['PATH'],FIXTURE_INTERRUPT_MARKER=str(marker))
proc=subprocess.Popen([sys.executable,str(project/'deploy/ecs-test/restore_approved_dump.py'),*map(str,apply_args(retry))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,start_new_session=True)
for _ in range(600):
    if marker.exists() or proc.poll() is not None: break
    time.sleep(.1)
if not marker.exists():
    out,err=proc.communicate(timeout=5);raise RuntimeError('did not reach injected interruption: '+err.decode()[-500:])
os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
statefile=retry[-1]/'checkpoint.json';state=json.loads(statefile.read_text());assert state['phases']['restore']['status']=='INTENT'
result=invoke('recover','--plan',retry[3],'--plan-sha256',retry[4],'--run-dir',retry[-1]);assert json.loads(result.stdout)['status']=='RECOVERED_RESUMABLE'
result=invoke(*apply_args(retry),'--resume');assert json.loads(result.stdout)['status']=='RESTORE_DATA_ONLY_ACL_UNVERIFIED'
print('actual process interruption before restore, read-only recovery and same-plan resume: PASS',flush=True)

state=json.loads(statefile.read_text());state['status']='RECOVERY_REQUIRED';state['phases']['restore']['status']='UNKNOWN';put(statefile,state)
result=invoke('recover','--plan',retry[3],'--plan-sha256',retry[4],'--run-dir',retry[-1],check=False)
assert result.returncode!=0 and b'RESTORE_COMMIT_UNKNOWN_MANUAL_REVIEW_REQUIRED' in result.stderr
print('unknown committed restore is preserved and not replayed: PASS',flush=True)
close_project('zzsh-ecs-test-fixtureretry')

setup=prepare('dbsetup-interrupted','zzsh-ecs-test-fixtureretry')
setup_marker=volume/'dbsetup-interrupt-marker'
binary.write_text('#!/bin/sh\ncase "$*" in *"--profile tools run --rm db-setup"*) /usr/local/bin/docker "$@" || exit $?; touch "$FIXTURE_SETUP_MARKER"; sleep 60; exit 0;; esac\nexec /usr/local/bin/docker "$@"\n');binary.chmod(0o700)
setup_env=dict(os.environ,PATH=str(wrapper)+':'+os.environ['PATH'],FIXTURE_SETUP_MARKER=str(setup_marker))
proc=subprocess.Popen([sys.executable,str(project/'deploy/ecs-test/restore_approved_dump.py'),*map(str,apply_args(setup))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=setup_env,start_new_session=True)
for _ in range(600):
    if setup_marker.exists() or proc.poll() is not None: break
    time.sleep(.1)
if not setup_marker.exists():
    out,err=proc.communicate(timeout=5);raise RuntimeError('did not reach dbSetup interruption: '+err.decode()[-500:])
os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
setup_statefile=setup[-1]/'checkpoint.json';setup_state=json.loads(setup_statefile.read_text())
assert setup_state['phases']['dbSetup']['status']=='INTENT' and setup_state['targetOid'] is None
result=invoke('recover','--plan',setup[3],'--plan-sha256',setup[4],'--run-dir',setup[-1],check=False)
assert result.returncode!=0 and b'DB_SETUP_CREATION_PROOF_MISSING_MANUAL_REVIEW_REQUIRED' in result.stderr
assert json.loads(setup_statefile.read_text())['targetOid'] is None
print('actual dbSetup interruption refuses unproven target adoption: PASS',flush=True)
close_project('zzsh-ecs-test-fixtureretry')

# Use only a uniquely named synthetic tag. The approved image ID must survive a retag.
original_compose=compose_file.read_text()
tag='zzsh-ecs-restore-imageprobe:20261105'
if subprocess.run(['docker','image','inspect',tag],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
    raise RuntimeError('synthetic image tag already exists')
api_id=restore.image_id('zzsh-ecs-test/api:dump-fixture-20261105')
other_id=restore.image_id('zzsh-ecs-test/web:dump-fixture-20261105')
assert api_id!=other_id
subprocess.run(['docker','tag',api_id,tag],check=True)
try:
    image_text=original_compose.replace('zzsh-ecs-test/api:${ZZSH_TEST_IMAGE_TAG:?set ZZSH_TEST_IMAGE_TAG}',tag)
    assert image_text!=original_compose;compose_file.write_text(image_text)
    probe=restore.Compose('zzsh-ecs-test-fixtureretry',compose_file,env_file)
    pinned=restore.compose_images(probe.config());assert pinned['api']==api_id
    probe.pin_images(pinned)
    subprocess.run(['docker','tag',other_id,tag],check=True)
    assert restore.image_id(tag)==other_id and probe.config()['services']['migration']['image']==api_id
    assert restore.migration_tree_hash(probe)==tree
    probe.close()
    close_project('zzsh-ecs-test-fixtureretry')
finally:
    compose_file.write_text(original_compose)
    subprocess.run(['docker','image','rm',tag],check=True,stdout=subprocess.DEVNULL)
print('mutable synthetic tag cannot change pinned migration image: PASS',flush=True)

# A stopped service or an existing (even empty) PGDATA volume is not a new target.
volume_name='zzsh-ecs-restore-stopprobe-20261105'
if subprocess.run(['docker','volume','inspect',volume_name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
    raise RuntimeError('synthetic stop-probe volume already exists')
tmpfs_pg='      - type: tmpfs\n        target: /var/lib/postgresql/data\n        tmpfs:\n          size: 805306368'
assert original_compose.count(tmpfs_pg)==1 and original_compose.count('  postgres_data:\n')==1
persistent_compose=original_compose.replace(tmpfs_pg,'      - postgres_data:/var/lib/postgresql/data')
persistent_compose=persistent_compose.replace('  postgres_data:\n','  postgres_data:\n    name: '+volume_name+'\n')
subprocess.run(['docker','volume','create','--label','zzsh.task=ecs-dump-stopped-resource-probe',volume_name],check=True,stdout=subprocess.DEVNULL)
try:
    compose_file.write_text(persistent_compose)
    c=restore.Compose('zzsh-ecs-test-fixtureretry',compose_file,env_file)
    stopped=restore.inspect_target(c)
    assert stopped['postgresContainerExists'] is False and stopped['postgresDataVolumeExists'] is True
    probe_run=private/'restore-existing-volume';probe_run.mkdir(mode=0o700)
    try: restore.apply_plan({'manifestSha256':'a'*64},'b'*64,base,c,dump,probe_run,approval_check=lambda:None)
    except restore.Refused as error: assert str(error)=='STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW'
    else: raise AssertionError('existing data volume accepted')
    assert not c.call('ps','-aq','postgres').strip()
    data=dict(base,project='zzsh-ecs-test-fixtureretry');manifest=private/'volume-plan-manifest.json';msh=put(manifest,data)
    result=invoke('plan','--manifest',manifest,'--manifest-sha256',msh,'--env-file',env_file,'--private-root',private,'--out',private/'volume-plan.json',check=False)
    assert result.returncode!=0 and b'STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW' in result.stderr
    assert not c.call('ps','-aq','postgres').strip()
finally:
    label=subprocess.check_output(['docker','volume','inspect',volume_name,'--format','{{index .Labels "zzsh.task"}}']).decode().strip()
    if label!='ecs-dump-stopped-resource-probe': raise RuntimeError('synthetic volume label changed')
    subprocess.run(['docker','volume','rm',volume_name],check=True,stdout=subprocess.DEVNULL)
    compose_file.write_text(original_compose)

c=restore.Compose('zzsh-ecs-test-fixtureretry',compose_file,env_file)
c.call('create','--no-build','--pull','never','postgres',capture=False)
try:
    stopped=restore.inspect_target(c)
    assert stopped['postgresContainerExists'] is True and stopped['postgresDataVolumeExists'] is False
    probe_run=private/'restore-stopped-container';probe_run.mkdir(mode=0o700)
    try: restore.apply_plan({'manifestSha256':'a'*64},'b'*64,base,c,dump,probe_run,approval_check=lambda:None)
    except restore.Refused as error: assert str(error)=='STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW'
    else: raise AssertionError('stopped postgres container accepted')
    assert not c.running('postgres') and c.call('ps','-aq','postgres').strip()
finally:
    close_project('zzsh-ecs-test-fixtureretry')
print('existing synthetic PGDATA volume and stopped container refused without startup: PASS',flush=True)

# Prototype only: preserve ACL and owner with a bijective rename of fresh synthetic roles.
c=restore.Compose('zzsh-ecs-test-fixtureretry',compose_file,env_file)
try:
    c.call('up','-d','--wait','--wait-timeout','120','postgres','redis',capture=False)
    c.call('--profile','tools','run','--rm','db-setup',capture=False)
    before=json.loads(c.sql('postgres',"SELECT json_build_object('migration',(SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_migration'),'runtime',(SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_runtime'))"))
    c.sql('postgres','BEGIN; ALTER ROLE zzsh_ecs_migration RENAME TO zzsh_fixture_source_m; ALTER ROLE zzsh_ecs_runtime RENAME TO zzsh_fixture_source_r; COMMIT;',readonly=False)
    shell='export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec pg_restore -w --single-transaction --exit-on-error -h postgres -U zzsh_bootstrap -d zzsh_ecs_test'
    with role_dump.open('rb') as input_stream:
        result=subprocess.run([*c.prefix,'exec','-T','postgres','sh','-ceu',shell],stdin=input_stream,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=3600)
    if result.returncode: raise RuntimeError('synthetic ACL-preserving restore failed')
    c.sql('postgres','BEGIN; ALTER ROLE zzsh_fixture_source_m RENAME TO zzsh_ecs_migration; ALTER ROLE zzsh_fixture_source_r RENAME TO zzsh_ecs_runtime; COMMIT;',readonly=False)
    after=json.loads(c.sql('postgres',"SELECT json_build_object('migration',(SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_migration'),'runtime',(SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_runtime'))"))
    assert before==after
    c.call('--profile','tools','run','--rm','migration',capture=False,timeout=3600)
    restored=json.loads(c.sql(restore.DATABASE,(project/'deploy/ecs-test/acl-snapshot-catalog.sql').read_text()))
    roles={r['name']:{'zzsh_fixture_source_m':'zzsh_ecs_migration','zzsh_fixture_source_r':'zzsh_ecs_runtime'}.get(r['name'],r['name']) for r in renamed_acl['roles']}
    comparison=acl_snapshot_compare.compare(renamed_acl,restored,roles)
    if not comparison['matches']: raise RuntimeError('synthetic mapped ACL mismatch: '+json.dumps(comparison['differences']))
    import acl_restore_plan
    review=acl_restore_plan.plan(renamed_acl,restored,roles,source_runtime='zzsh_fixture_source_r',source_migration='zzsh_fixture_source_m')
    assert review['status']=='REVIEW_ONLY_NO_SQL_OR_WRITES' and not review['operations']
    assert restore.readback_matches(restore.readback(c),base)
    print('ACL-preserving synthetic role rename and formal convergence match mapped source catalog: PASS',flush=True)
finally:
    close_project('zzsh-ecs-test-fixtureretry')
put(private/'synthetic-test-result.json',{'schema':'zzsh.ecs-restore-synthetic-test.v1','status':'PASS',
    'postgres':'16','hostPortsPublished':False,'realSourceConnected':False,'applicationStarted':False,
    'cases':['same-exported-snapshot-acl','detect-no-acl-public-expansion','sealed-archive','stopped-resources',
             'immutable-image-id','unknown-restore','db-setup-interruption','membership-counts','column-public-inherited-acl',
             'synthetic-role-rename-preserve-acl','acl-mapped-catalog-readback']})
