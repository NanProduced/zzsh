import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('restore_approved_dump', HERE / 'restore_approved_dump.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def manifest():
    return {'schema':'zzsh.ecs-test-approved-dump.v1','project':'zzsh-ecs-test-fixture',
            'dump':{'path':'/fixture/input.dump','sha256':'a'*64,'bytes':100},
            'source':{'postgresMajor':16,'cutoff':'2026-11-05T00:00:00Z','datasetSha256':'b'*64,
                      'migrationTreeSha256':'c'*64,'journalHashes':['d'*64],'reviewedAuthArtifacts':'sanitized-approved'},
            'keys':{name:'e'*64 for name in restore.REQUIRED_KEYS},'bankVersions':[],
            'expected':{'tables':{name:0 for name in restore.TABLES},'ledgerDebitCents':'0','ledgerCreditCents':'0'},
            'startServices':False}


class ContractTests(unittest.TestCase):
    def test_compose_accepts_only_the_two_explicit_real_identity_providers(self):
        env={'APP_PROFILE':'ecs-test','DB_TARGET':'ecs-test','DB_NAME':restore.DATABASE,'DB_USER':restore.RUNTIME,
             'DB_TLS_MODE':'verify-full','REDIS_TLS_MODE':'verify-full','USER_SMS_PROVIDER':'aliyun',
             'MEDIA_STORAGE':'oss','ORDER_IM_EVENTS_ENABLED':'true','YUNXIN_APP_KEY':'fixture','ORDER_IM_EVENTS_APP_KEY':'fixture'}
        env.update({name:'false' for name in ('JOINPAY_COLLECTION_ENABLED','JOINPAY_REFUND_ENABLED','JOINPAY_PAYOUT_ENABLED','JOINPAY_ACCOUNTS_ENABLED')})
        services={name:{} for name in ('api','web','proxy','postgres','redis','db-setup','migration')}
        services['api']={'environment':env,'volumes':[{'type':'bind','source':'/fixture/secrets','target':'/workspace/apps/api/.secrets','read_only':True}]}
        services['proxy']={'ports':[{'published':'80'},{'published':'443'}]}
        config={'services':services,'networks':{'data_private':{'internal':True}}}
        for provider in ('aliyun-id2meta','aliyun-market-id2'):
            env['USER_REAL_NAME_PROVIDER']=provider
            self.assertEqual(restore.validate_compose(config)[0]['USER_REAL_NAME_PROVIDER'],provider)
        env['USER_REAL_NAME_PROVIDER']='other'
        with self.assertRaisesRegex(restore.Refused,'COMPOSE_RUNTIME_GATES_INVALID'): restore.validate_compose(config)

    def test_pg_restore_header_accepts_real_spacing_and_rejects_missing_source(self):
        self.assertEqual(restore.dump_source_major(';     Dumped from database version: 16.13\n'), 16)
        self.assertEqual(restore.dump_source_major('; Dumped from database version: 16\n'), 16)
        with self.assertRaisesRegex(restore.Refused,'DUMP_POSTGRES_VERSION_MISMATCH'):
            restore.dump_source_major('; Dumped by pg_dump version: 16.13\n')

    def test_manifest_rejects_missing_scope_unknown_keys_and_invalid_amounts(self):
        self.assertEqual(restore.parse_manifest(manifest())['source']['postgresMajor'], 16)
        for mutate in (
            lambda m:m.update(project='other'), lambda m:m['dump'].update(sha256='x'),
            lambda m:m['source'].update(postgresMajor=15), lambda m:m['source'].update(journalHashes=[]),
            lambda m:m['keys'].pop('AUTH_USER_SECRET_FILE'), lambda m:m['expected']['tables'].pop('orders'),
            lambda m:m['expected'].update(ledgerDebitCents='-1'), lambda m:m.update(startServices='false'),
            lambda m:m.update(startServices=True), lambda m:m['expected']['tables'].update(banks=1), lambda m:m.update(unexpected=True),
        ):
            data = manifest(); mutate(data)
            with self.assertRaises(restore.Refused): restore.parse_manifest(data)

    def test_source_key_fingerprints_bank_versions_and_provider_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); os.chmod(root,0o700); data = manifest(); env = {'USER_REAL_NAME_PROVIDER':'aliyun-id2meta'}
            for index, name in enumerate(sorted(restore.REQUIRED_KEYS)):
                file = root / ('key'+str(index)); file.write_text(chr(65+index)*40); file.chmod(0o600)
                env[name] = '.secrets/'+file.name; data['keys'][name] = hashlib.sha256(file.read_bytes()).hexdigest()
            for index, name in enumerate(('ADMIN_ALTCHA_HMAC_KEY_FILE','USER_AUTH_THROTTLE_HMAC_KEY_FILE')):
                file=root/('runtime'+str(index));file.write_text(chr(88+index)*40);file.chmod(0o600);env[name]='.secrets/'+file.name
            env.update(ORDER_CONFIRMATION_KEY_ID='confirmation_v1',LISTING_CURSOR_KEY_ID='cursor_v1')
            provider = root/'provider'; provider.write_text('fixture-provider'); provider.chmod(0o600)
            for name in ('YUNXIN_APP_SECRET_FILE','ORDER_IM_EVENTS_APP_SECRET_FILE','USER_SMS_ACCESS_KEY_ID_FILE',
                         'USER_SMS_ACCESS_KEY_SECRET_FILE','USER_REAL_NAME_ACCESS_KEY_ID_FILE','USER_REAL_NAME_ACCESS_KEY_SECRET_FILE'):
                env[name] = '.secrets/provider'
            for name in ('USER_SMS_SIGN_NAME','USER_SMS_TEMPLATE_CODE','ALIBABA_CLOUD_ACCESS_KEY_ID','ALIBABA_CLOUD_ACCESS_KEY_SECRET',
                         'OSS_BUCKET','OSS_REGION','OSS_ENDPOINT','OSS_OBJECT_PREFIX','USER_REAL_NAME_DAILY_LIMIT','USER_REAL_NAME_MIN_INTERVAL_SECONDS'):
                env[name] = 'fixture'
            bank = root/'bank'; bank.write_text(base64.urlsafe_b64encode(bytes([7])*32).decode().rstrip('=')); bank.chmod(0o600)
            keyname='WITHDRAWAL_BANK_KEY_R06_V1_FILE'; env[keyname]='.secrets/bank'
            data['keys'][keyname]=hashlib.sha256(bank.read_bytes()).hexdigest(); data['bankVersions']=['fixture-v1']
            bankcfg = root/'bank.json'; bankcfg.write_text(json.dumps({'database':restore.DATABASE,'runtimeUser':restore.RUNTIME,'writeEnabled':True,
                'currentKeyVersion':'fixture-v1','keyVariables':{'fixture-v1':'WITHDRAWAL_BANK_KEY_R06_V1'}})); bankcfg.chmod(0o600)
            env.update(WITHDRAWAL_BANK_BINDING_ENABLED='true',WITHDRAWAL_BANK_BINDING_CONFIG_FILE='.secrets/bank.json')
            restore.verify_source_keys(env,root,data)
            newbank=root/'newbank';newbank.write_text(base64.urlsafe_b64encode(bytes([8])*32).decode().rstrip('='));newbank.chmod(0o600)
            env['WITHDRAWAL_BANK_KEY_TEST_V1_FILE']='.secrets/newbank'
            data['keys']['WITHDRAWAL_BANK_KEY_TEST_V1_FILE']=hashlib.sha256(newbank.read_bytes()).hexdigest()
            cfg={'database':restore.DATABASE,'runtimeUser':restore.RUNTIME,'writeEnabled':True,'currentKeyVersion':'test-v1',
                 'keyVariables':{'fixture-v1':'WITHDRAWAL_BANK_KEY_R06_V1','test-v1':'WITHDRAWAL_BANK_KEY_TEST_V1'}}
            bankcfg.write_text(json.dumps(cfg));restore.verify_source_keys(env,root,data)
            market=dict(env, USER_REAL_NAME_PROVIDER='aliyun-market-id2', USER_REAL_NAME_APPCODE_FILE='.secrets/provider')
            market.pop('USER_REAL_NAME_ACCESS_KEY_ID_FILE');market.pop('USER_REAL_NAME_ACCESS_KEY_SECRET_FILE')
            restore.verify_source_keys(market,root,data)
            missing_market=dict(market);missing_market.pop('USER_REAL_NAME_APPCODE_FILE')
            with self.assertRaises(restore.Refused): restore.verify_source_keys(missing_market,root,data)
            no_old=copy.deepcopy(cfg);del no_old['keyVariables']['fixture-v1'];bankcfg.write_text(json.dumps(no_old))
            with self.assertRaisesRegex(restore.Refused,'BANK_KEYRING_VERSIONS_MISMATCH'): restore.verify_source_keys(env,root,data)
            bankcfg.write_text(json.dumps(cfg))
            no_new_proof=copy.deepcopy(data);del no_new_proof['keys']['WITHDRAWAL_BANK_KEY_TEST_V1_FILE']
            with self.assertRaisesRegex(restore.Refused,'SOURCE_BANK_KEY_FINGERPRINT_MISSING'): restore.verify_source_keys(env,root,no_new_proof)
            bad=copy.deepcopy(data);bad['keys'][keyname]='0'*64
            with self.assertRaisesRegex(restore.Refused,'SOURCE_KEY_FINGERPRINT_MISMATCH'): restore.verify_source_keys(env,root,bad)
            bad=copy.deepcopy(data);bad['bankVersions']=['wrong']
            with self.assertRaisesRegex(restore.Refused,'BANK_KEYRING_VERSIONS_MISMATCH'): restore.verify_source_keys(env,root,bad)
            with self.assertRaises(restore.Refused): restore.secret_path(root,'.secrets/../outside')
            with self.assertRaises(restore.Refused): restore.secret_path(root,str(bank))
            for name in ('ADMIN_ALTCHA_HMAC_KEY_FILE','USER_AUTH_THROTTLE_HMAC_KEY_FILE'):
                changed=dict(env);changed.pop(name)
                with self.assertRaises(restore.Refused): restore.verify_source_keys(changed,root,data)
            for name in ('ORDER_CONFIRMATION_KEY_ID','LISTING_CURSOR_KEY_ID'):
                for value in ('', 'REPLACE_WITH_KEY_ID', 'invalid id', 'x'*65):
                    changed=dict(env);changed[name]=value
                    with self.assertRaisesRegex(restore.Refused,'SIGNING_KEY_ID_INVALID'): restore.verify_source_keys(changed,root,data)
            runtime=root/'runtime1';saved=runtime.read_text();runtime.write_text('short')
            with self.assertRaisesRegex(restore.Refused,'RUNTIME_KEY_FORMAT_INVALID'): restore.verify_source_keys(env,root,data)
            runtime.write_text(saved)
            changed=dict(env);changed['USER_AUTH_THROTTLE_HMAC_KEY_FILE']=env['AUTH_USER_SECRET_FILE']
            with self.assertRaisesRegex(restore.Refused,'RUNTIME_KEYS_NOT_INDEPENDENT'): restore.verify_source_keys(changed,root,data)

    def test_verified_documents_never_parse_a_replaced_or_modified_file(self):
        real_loads=json.loads
        for kind in ('MANIFEST','PLAN','APPROVAL'):
            for change in ('replace','inplace'):
                with self.subTest(kind=kind,change=change),tempfile.TemporaryDirectory() as tmp:
                    path=Path(tmp)/'document.json'; original=b'{"value":"approved"}';path.write_bytes(original);path.chmod(0o600)
                    digest=hashlib.sha256(original).hexdigest()
                    def replace_before_parse(blob):
                        if change=='replace': path.rename(Path(tmp)/'old.json')
                        path.write_bytes(b'{"value":"changed!"}');path.chmod(0o600)
                        return real_loads(blob)
                    with patch.object(restore.json,'loads',side_effect=replace_before_parse):
                        self.assertEqual(restore.read_verified_json(path,digest,kind+'_DIGEST_MISMATCH'),{'value':'approved'})
                    with self.assertRaisesRegex(restore.Refused,kind+'_DIGEST_MISMATCH'):
                        restore.read_verified_json(path,digest,kind+'_DIGEST_MISMATCH')

    def test_compose_images_are_pinned_by_sealed_image_ids(self):
        images={name:'sha256:'+format(index,'064x') for index,name in enumerate(('api','web','proxy','postgres','redis'),1)}
        compose=restore.Compose('zzsh-ecs-test-fixture','/synthetic/compose.yaml','/synthetic/env')
        try:
            compose.pin_images(images)
            override=json.loads(Path(compose.prefix[-1]).read_bytes())['services']
            self.assertEqual(override['migration']['image'],images['api'])
            self.assertEqual(override['db-setup']['image'],images['postgres'])
            for name,image in images.items(): self.assertEqual(override[name]['image'],image)
            with self.assertRaises(OSError): os.write(compose._pin_fd,b'bad')
        finally:
            compose.close()

    def test_stopped_postgres_container_or_volume_are_never_started(self):
        class FakeCompose:
            def __init__(self,container,volume): self.container=container;self.volume=volume;self.calls=[]
            def running(self,name): self.calls.append(('running',name));return False
            def stopped_postgres_resources(self):
                return {'postgresContainerExists':self.container,'postgresDataVolumeExists':self.volume}
            def call(self,*args,**_kwargs): self.calls.append(('call',*args));raise AssertionError('unexpected compose call')
        for container,volume in ((True,False),(False,True),(True,True)):
            compose=FakeCompose(container,volume)
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(restore.Refused,'STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW'):
                    restore.apply_plan({'manifestSha256':'a'*64},'b'*64,manifest(),compose,Path(tmp)/'dump',tmp,approval_check=lambda:None)
            self.assertFalse(any(call[0]=='call' and 'up' in call for call in compose.calls))
            with self.assertRaisesRegex(restore.Refused,'STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW'):
                restore.require_no_stopped_postgres_resources(restore.inspect_target(compose))
        compose=FakeCompose(False,False)
        with tempfile.TemporaryDirectory() as tmp,patch.object(restore,'inspect_target',return_value={'target':None,'roles':[]}):
            with self.assertRaisesRegex(restore.Refused,'RUNNING_POSTGRES_RESOURCE_REQUIRES_REVIEW'):
                restore.apply_plan({'manifestSha256':'a'*64},'b'*64,manifest(),compose,Path(tmp)/'dump',tmp,approval_check=lambda:None)
        self.assertFalse(any(call[0]=='call' and 'up' in call for call in compose.calls))

    def test_target_roles_and_source_readback_fail_closed(self):
        roles=[{'name':name,'oid':str(i+1),'login':name!=restore.OWNER,'inherit':name==restore.OWNER,'super':False,'createdb':False,
                'createrole':False,'replicate':False,'bypass':False,'member':False} for i,name in enumerate((restore.OWNER,restore.MIGRATION,restore.RUNTIME))]
        observed={'target':{'oid':'99','owner':restore.OWNER,'marker':restore.MARKER,'publicPrivileges':False,
                            'migrationConnect':True,'migrationCreate':True,'runtimeConnect':True,'runtimeCreate':False},'roles':roles}
        self.assertTrue(restore.target_roles_complete(observed))
        for field,value in [('owner','other'),('marker','other'),('runtimeCreate',True),('publicPrivileges',True)]:
            changed=copy.deepcopy(observed); changed['target'][field]=value
            with self.assertRaises(restore.Refused): restore.target_roles_complete(changed)
        changed=copy.deepcopy(observed);changed['roles'][2]['super']=True
        with self.assertRaises(restore.Refused): restore.target_roles_complete(changed)
        changed=copy.deepcopy(observed);changed['roles'][1]['inherit']=True
        with self.assertRaises(restore.Refused): restore.target_roles_complete(changed)
        data=manifest();actual={'journal':data['source']['journalHashes'],'tables':data['expected']['tables'],
            'ledgerDebitCents':'0','ledgerCreditCents':'0','bankVersions':[]}
        self.assertTrue(restore.readback_matches(actual,data))
        for field,value in [('journal',['0'*64]),('ledgerDebitCents','1'),('bankVersions',['unknown'])]:
            changed=copy.deepcopy(actual);changed[field]=value;self.assertFalse(restore.readback_matches(changed,data))
        for name in ('rentalMembership','membershipLegacyCoverage','membershipContribution','membershipPolicy','membershipLegacyReadAdmission'):
            changed=copy.deepcopy(actual);changed['tables'][name]=1
            self.assertFalse(restore.readback_matches(changed,data),name)
            missing=copy.deepcopy(data);missing['expected']['tables'].pop(name)
            with self.assertRaisesRegex(restore.Refused,'EXPECTED_READBACK_INVALID'): restore.parse_manifest(missing)

    def test_native_admission_requires_immutable_guards_and_no_public_writes(self):
        class FakeCompose:
            def __init__(self, record): self.record=record
            def sql(self, *_args, **_kwargs): return json.dumps(self.record)
        data={'owner':restore.MIGRATION,'runtimeCanWrite':False,'runtimeCanWriteColumns':False,'publicCanWrite':False,
              'publicCanWriteColumns':False,'guardsActive':True,'row':None}
        self.assertEqual(restore.admission_status(FakeCompose(data),{'targetOid':'9'}),'ABSENT')
        for key in ('runtimeCanWrite','runtimeCanWriteColumns','publicCanWrite','publicCanWriteColumns','guardsActive'):
            changed=copy.deepcopy(data);changed[key]=not changed[key]
            with self.assertRaisesRegex(restore.Refused,'NATIVE_ADMISSION_ACL_OR_GUARD_INVALID'):
                restore.admission_status(FakeCompose(changed),{'targetOid':'9'})

    def test_step_records_intent_then_unknown_and_requires_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'checkpoint.json';state={'status':'STARTED','phases':{}}
            with self.assertRaises(RuntimeError): restore.run_step(state,file,'restore',lambda:(_ for _ in ()).throw(RuntimeError('fixture')))
            recorded=json.loads(file.read_text());self.assertEqual(recorded['status'],'RECOVERY_REQUIRED')
            self.assertEqual(recorded['phases']['restore']['status'],'UNKNOWN')
            with self.assertRaisesRegex(restore.Refused,'ORIGINAL_STAGE_REQUIRES_RECOVERY'): restore.run_step(state,file,'restore',lambda:None)

    def test_approval_expiry_stops_before_new_side_effect_and_allows_reapproval(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'checkpoint.json';state={'status':'STARTED','phases':{}};effects=[]
            def expire(): raise restore.Refused('APPROVAL_WINDOW_INACTIVE')
            with self.assertRaisesRegex(restore.Refused,'APPROVAL_WINDOW_INACTIVE'):
                restore.run_step(state,file,'migration',lambda:effects.append('write'),approval_check=expire)
            recorded=json.loads(file.read_text())
            self.assertEqual(effects,[]);self.assertEqual(recorded['status'],'RECOVERED_RESUMABLE')
            self.assertEqual(recorded['phases']['migration']['status'],'RETRYABLE_NOT_APPLIED')
            restore.run_step(state,file,'migration',lambda:effects.append('write'),approval_check=lambda:None)
            self.assertEqual(effects,['write']);self.assertEqual(state['phases']['migration']['status'],'ACK')

    def test_inflight_stage_can_ack_after_expiry_but_next_stage_cannot_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'checkpoint.json';state={'status':'STARTED','phases':{}};active=[True];effects=[]
            def check():
                if not active[0]: raise restore.Refused('APPROVAL_WINDOW_INACTIVE')
            def restore_inflight(): effects.append('restore');active[0]=False
            restore.run_step(state,file,'restore',restore_inflight,approval_check=check)
            self.assertEqual(state['phases']['restore']['status'],'ACK')
            with self.assertRaisesRegex(restore.Refused,'APPROVAL_WINDOW_INACTIVE'):
                restore.run_step(state,file,'migration',lambda:effects.append('migration'),approval_check=check)
            self.assertEqual(effects,['restore']);self.assertEqual(state['phases']['restore']['status'],'ACK')
            self.assertEqual(state['phases']['migration']['status'],'RETRYABLE_NOT_APPLIED')

    def test_host_lock_rejects_concurrent_same_target(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(restore,'LOCK_PATH',Path(tmp)/'lock'):
            with restore.target_lock(tmp):
                with self.assertRaisesRegex(restore.Refused,'RESTORE_ALREADY_RUNNING'):
                    with restore.target_lock(tmp): pass

    def test_unknown_restore_with_nonempty_target_never_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan=Path(tmp)/'plan.json';plan.write_text('{}');statefile=Path(tmp)/'checkpoint.json'
            state={'planSha256':restore.digest_file(plan),'status':'RECOVERY_REQUIRED','phases':{'restore':{'status':'UNKNOWN'}}}
            with patch.object(restore,'inspect_target',return_value={'target':{'oid':'9'}}), \
                 patch.object(restore,'assert_no_orphaned_jobs'), patch.object(restore,'exact_target'), \
                 patch.object(restore,'empty_database',return_value=False):
                with self.assertRaisesRegex(restore.Refused,'RESTORE_COMMIT_UNKNOWN_MANUAL_REVIEW_REQUIRED'):
                    restore.recover_run({'_path':str(plan)},state,manifest(),object(),statefile)
            self.assertEqual(state['phases']['restore']['status'],'UNKNOWN');self.assertFalse(statefile.exists())

    def test_application_is_checked_before_absent_postgres_or_any_up(self):
        class FakeCompose:
            def __init__(self): self.calls=[]
            def running(self,name): self.calls.append(('running',name)); return name=='api'
            def call(self,*args,**_kwargs): self.calls.append(('call',*args)); raise AssertionError('unexpected compose call')
        compose=FakeCompose()
        with self.assertRaisesRegex(restore.Refused,'APPLICATION_ALREADY_RUNNING'):
            restore.inspect_target(compose)
        self.assertNotIn(('running','postgres'),compose.calls)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(restore.Refused,'APPLICATION_ALREADY_RUNNING'):
                restore.apply_plan({'manifestSha256':'a'*64},'b'*64,manifest(),compose,Path(tmp)/'dump',tmp,approval_check=lambda:None)
        self.assertFalse(any(call[0]=='call' and 'up' in call for call in compose.calls))

    def test_approved_dump_is_sealed_against_path_and_same_inode_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'approved.dump';approved=b'APPROVED_SYNTHETIC_BYTES';path.write_bytes(approved);path.chmod(0o600)
            digest=hashlib.sha256(approved).hexdigest()
            with patch.object(restore,'immutable_staging_capacity',return_value=10**9):
                with restore.immutable_approved_dump(path,digest,len(approved)) as stream:
                    old=Path(tmp)/'old-inode';path.rename(old);old.write_bytes(b'X'*len(approved));path.write_bytes(b'Y'*len(approved));path.chmod(0o600)
                    self.assertEqual(stream.read(),approved)
                    with self.assertRaises(OSError): os.write(stream.fileno(),b'bad')
                with self.assertRaisesRegex(restore.Refused,'DUMP_CONTENT_MISMATCH'):
                    with restore.immutable_approved_dump(path,digest,len(approved)): pass
            with patch.object(restore,'immutable_staging_capacity',return_value=len(approved)-1):
                with self.assertRaisesRegex(restore.Refused,'IMMUTABLE_STAGING_INSUFFICIENT_MEMORY'):
                    with restore.immutable_approved_dump(path,digest,len(approved)): pass

    def test_dump_validation_and_restore_use_verified_immutable_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'approved.dump';body=b'SYNTHETIC_ARCHIVE';path.write_bytes(body);path.chmod(0o600)
            data=manifest();data['dump'].update(path=str(path),bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
            observed=[]
            def fake_command(args,*,stdin=None,**_kwargs):
                observed.append((os.fstat(stdin.fileno()).st_ino,stdin.read()))
                return b'; Dumped from database version: 16.13\n' if '--list' in args else b''
            class FakeCompose:
                def call(self,*_args,stdin=None,**_kwargs):
                    path.write_bytes(b'X'*len(body)); observed.append((os.fstat(stdin.fileno()).st_ino,stdin.read()))
            with patch.object(restore,'immutable_staging_capacity',return_value=10**9),patch.object(restore,'command',side_effect=fake_command):
                restore.verify_dump(path,data,'synthetic-image')
                self.assertEqual(observed[0],observed[1])
                restore.restore_dump(FakeCompose(),path,data['dump']['sha256'],len(body))
            self.assertEqual([entry[1] for entry in observed],[body,body,body])

    def test_db_setup_without_exact_creation_proof_is_never_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan=Path(tmp)/'plan.json';plan.write_text('{}');statefile=Path(tmp)/'checkpoint.json'
            state={'planSha256':restore.digest_file(plan),'status':'RECOVERY_REQUIRED','targetOid':None,'roleOids':None,
                   'phases':{'dbSetup':{'status':'INTENT'}}}
            with patch.object(restore,'inspect_target',return_value={'target':{'oid':'9'}}),patch.object(restore,'assert_no_orphaned_jobs'):
                with self.assertRaisesRegex(restore.Refused,'DB_SETUP_CREATION_PROOF_MISSING_MANUAL_REVIEW_REQUIRED'):
                    restore.recover_run({'_path':str(plan)},state,manifest(),object(),statefile)
            self.assertIsNone(state['targetOid']);self.assertEqual(state['phases']['dbSetup']['status'],'INTENT');self.assertFalse(statefile.exists())


if __name__ == '__main__':
    unittest.main()
