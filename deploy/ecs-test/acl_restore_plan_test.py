import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import acl_restore_plan as acl


def fixture(database='source_db', owner='source_owner', runtime='source_runtime'):
    attrs={'superuser':False,'inherit':True,'createRole':False,'createDb':False,'login':False,'replication':False,'bypassRls':False,
           'connectionLimit':-1,'validUntil':None,'configSha256':None}
    grant=lambda who,priv: {'grantor':owner,'grantee':who,'privilege':priv,'grantable':False}
    item=lambda kind,identity,acl=None,properties=None: {'kind':kind,'identity':identity,'owner':owner,'properties':properties or {},'acl':acl or []}
    return {'schema':'zzsh.acl-snapshot-catalog.v1','database':database,'transactionReadOnly':'on',
        'transactionIsolation':'repeatable read','transactionSnapshot':'fixture-snapshot','memberships':[],'roleSettings':[],'policies':[],
        'roles':[dict(attrs,name=owner),dict(attrs,name=runtime)],
        'objects':[
            item('database',{'database':database},[grant(owner,'CONNECT')]),
            item('schema',{'schema':'zzsh_fixture'},[grant(owner,'USAGE'),grant('PUBLIC','USAGE')]),
            item('relation',{'schema':'zzsh_fixture','name':'entry','relkind':'r'},[grant(runtime,'SELECT')],{'rowSecurity':False,'forceRowSecurity':False}),
            item('relation',{'schema':'zzsh_fixture','name':'entry_seq','relkind':'S'},[grant(runtime,'USAGE')],{'rowSecurity':False,'forceRowSecurity':False}),
            item('column',{'schema':'zzsh_fixture','relation':'entry','column':'amount'},[grant(runtime,'UPDATE')]),
            item('routine',{'schema':'zzsh_fixture','name':'check','arguments':'integer','kind':'f'},[grant(runtime,'EXECUTE')],{'securityDefiner':True,'config':['search_path=pg_catalog'],'definitionSha256':'a'*64}),
            item('routine',{'schema':'zzsh_fixture','name':'check','arguments':'text','kind':'f'},[grant('PUBLIC','EXECUTE')],{'securityDefiner':False,'config':None,'definitionSha256':'b'*64}),
            item('routine',{'schema':'zzsh_fixture','name':'work','arguments':'','kind':'p'},[grant(runtime,'EXECUTE')],{'securityDefiner':False,'config':None,'definitionSha256':'c'*64}),
            item('type',{'schema':'zzsh_fixture','name':'state','kind':'e'},[grant(runtime,'USAGE')]),
            item('defaultAcl',{'schema':None,'objectType':'f'},[grant(owner,'EXECUTE'),grant(runtime,'EXECUTE')]),
            item('defaultAcl',{'schema':'zzsh_fixture','objectType':'r'},[grant(owner,'SELECT'),grant(runtime,'SELECT')]),
            item('routine',{'schema':'zzsh_fixture','name':'aggregate','arguments':'integer','kind':'a'},[grant(runtime,'EXECUTE')],{'securityDefiner':False,'config':None,'definitionSha256':None}),
            item('schema',{'schema':'public'},[grant('PUBLIC','USAGE')]),
            item('routine',{'schema':'public','name':'fixture_extension','arguments':'','kind':'f'},[grant('PUBLIC','EXECUTE')],{'securityDefiner':False,'config':None,'definitionSha256':'e'*64}),
        ]}


def make_plan(source, target, mapping):
    return acl.plan(source,target,mapping,source_runtime='source_runtime',source_migration='source_owner')


class AclRestorePlanTests(unittest.TestCase):
    def setUp(self):
        self.source=fixture(); self.target=fixture('target_db','target_owner','target_runtime')
        self.mapping={'source_owner':'target_owner','source_runtime':'target_runtime'}

    def test_all_object_types_produce_deterministic_review_only_grants(self):
        target=copy.deepcopy(self.target)
        target['objects'][1]['acl'].pop()
        target['objects'][2]['acl'][0]['privilege']='UPDATE'
        target['objects'][3]['acl'].clear()
        target['objects'][4]['acl'].clear()
        target['objects'][5]['acl'].append({'grantor':'target_owner','grantee':'PUBLIC','privilege':'EXECUTE','grantable':False})
        target['objects'][7]['acl'].clear()
        target['objects'][8]['acl'].clear()
        target['objects'][9]['acl'].pop()
        target['objects'][10]['acl'].pop()
        result=make_plan(self.source,target,self.mapping)
        self.assertEqual(result['status'],'REVIEW_ONLY_NO_SQL_OR_WRITES')
        kinds={op['kind'] for op in result['operations']}
        self.assertEqual(kinds,{'schema','relation','column','routine','type','defaultAcl'})
        self.assertEqual({op['identity']['objectType'] for op in result['operations'] if op['kind']=='defaultAcl'},{'f','r'})
        self.assertTrue(any(op['kind']=='routine' and op['identity']['arguments']=='integer' and op['action']=='REVOKE' for op in result['operations']))
        self.assertFalse(any(op['kind']=='routine' and op['identity']['arguments']=='text' for op in result['operations']))
        self.assertTrue(any(op['kind']=='relation' and op['identity']['relkind']=='S' for op in result['operations']))
        self.assertEqual(result['operations'],make_plan(self.source,target,self.mapping)['operations'])
        actions=[op['action'] for op in result['operations']]
        self.assertEqual(actions,sorted(actions,key=lambda x:x!='REVOKE'))
        self.assertTrue(all(set(op)=={'action','kind','identity','owner','grant'} for op in result['operations']))

    def test_database_acl_also_requires_explicit_target_and_mapped_owner(self):
        target=copy.deepcopy(self.target);target['objects'][0]['acl'].clear()
        ops=make_plan(self.source,target,self.mapping)['operations']
        self.assertEqual(len(ops),1);self.assertEqual(ops[0]['kind'],'database')
        self.assertEqual(ops[0]['identity']['database'],'target_db')

    def test_sequence_default_privileges_are_not_reduced_to_usage(self):
        source=copy.deepcopy(self.source);target=copy.deepcopy(self.target)
        for value,owner in ((source,'source_owner'),(target,'target_owner')):
            value['objects'][3]['acl'] += [{'grantor':owner,'grantee':owner,'privilege':priv,'grantable':False}
                                           for priv in ('SELECT','UPDATE')]
        target['objects'][3]['acl'] = [g for g in target['objects'][3]['acl'] if g['privilege']!='UPDATE']
        operations=make_plan(source,target,self.mapping)['operations']
        self.assertEqual(len(operations),1);self.assertEqual(operations[0]['grant']['privilege'],'UPDATE')

    def test_incomplete_inventory_owner_definer_roles_and_membership_fail_closed(self):
        for name,mutate in (
            ('missing column',lambda x:x['objects'].pop(4)),
            ('missing schema',lambda x:x['objects'].pop(1)),
            ('column parent',lambda x:x['objects'][4]['identity'].update(relation='missing')),
            ('owner',lambda x:x['objects'][2].update(owner='target_runtime')),
            ('definer',lambda x:x['objects'][5]['properties'].update(securityDefiner=False)),
            ('definition mismatch',lambda x:x['objects'][5]['properties'].update(definitionSha256='d'*64)),
            ('role attribute',lambda x:x['roles'][1].update(bypassRls=True)),
            ('role database settings',lambda x:x['roleSettings'].append({'database':'target_db','role':'target_runtime','configSha256':'a'*64})),
            ('membership',lambda x:x['memberships'].append({'role':'target_owner','member':'target_runtime','grantor':'target_owner','admin':False,'inherit':True,'set':True})),
            ('policy',lambda x:x['policies'].append({'schema':'zzsh_fixture','relation':'entry','name':'tenant','command':'r','permissive':True,'roles':['PUBLIC'],'using':'true','check':None})),
        ):
            with self.subTest(name=name):
                changed=copy.deepcopy(self.target);mutate(changed)
                with self.assertRaises(acl.NotReady): make_plan(self.source,changed,self.mapping)
        for mapping in ({'source_owner':'target_owner'}, {'source_owner':'target_owner','source_runtime':'target_owner'}):
            with self.assertRaises(acl.NotReady): make_plan(self.source,self.target,mapping)

    def test_unresolved_grant_chains_invalid_types_and_unusual_names_refuse(self):
        for name,mutate in (
            ('grant option',lambda x:x['objects'][2]['acl'][0].update(grantable=True)),
            ('foreign grantor',lambda x:x['objects'][2]['acl'][0].update(grantor='target_runtime')),
            ('invalid privilege',lambda x:x['objects'][2]['acl'][0].update(privilege='DELETE; DROP SCHEMA')),
            ('identifier',lambda x:x['objects'][2]['identity'].update(name='entry;DROP')),
            ('unsupported schema',lambda x:x['objects'][12]['identity'].update(schema='other')),
            ('routine arguments',lambda x:x['objects'][5]['identity'].update(arguments='integer); SELECT 1')),
            ('missing function digest',lambda x:x['objects'][5]['properties'].pop('definitionSha256')),
            ('nonhex function digest',lambda x:x['objects'][5]['properties'].update(definitionSha256='z'*64)),
            ('uppercase function digest',lambda x:x['objects'][5]['properties'].update(definitionSha256='A'*64)),
            ('null function digest',lambda x:x['objects'][5]['properties'].update(definitionSha256=None)),
            ('aggregate digest',lambda x:x['objects'][11]['properties'].update(definitionSha256='a'*64)),
            ('unbound role',lambda x:x['objects'][2]['acl'][0].update(grantee='unmapped')),
        ):
            with self.subTest(name=name):
                changed=copy.deepcopy(self.target);mutate(changed)
                with self.assertRaises(acl.NotReady): make_plan(self.source,changed,self.mapping)
        source=copy.deepcopy(self.source);target=copy.deepcopy(self.target)
        source['objects'][8]['identity']['kind']='b';target['objects'][8]['identity']['kind']='b';target['objects'][8]['acl'].clear()
        with self.assertRaisesRegex(acl.NotReady,'ACL_TYPE_MUTATION_UNSUPPORTED'): make_plan(source,target,self.mapping)

    def test_runtime_cannot_be_owner_or_inherit_owner_even_if_both_catalogs_match(self):
        source=copy.deepcopy(self.source);target=copy.deepcopy(self.target)
        source['memberships'].append({'role':'source_owner','member':'source_runtime','grantor':'source_owner',
                                      'admin':False,'inherit':False,'set':True})
        target['memberships'].append({'role':'target_owner','member':'target_runtime','grantor':'target_owner',
                                      'admin':False,'inherit':False,'set':True})
        with self.assertRaisesRegex(acl.NotReady,'ACL_RUNTIME_OWNER_AUTHORITY_INVALID'): make_plan(source,target,self.mapping)
        source=copy.deepcopy(self.source);target=copy.deepcopy(self.target)
        source['roles'][1]['superuser']=True;target['roles'][1]['superuser']=True
        with self.assertRaisesRegex(acl.NotReady,'ACL_RUNTIME_PRIVILEGE_INVALID'): make_plan(source,target,self.mapping)

    def test_role_configuration_digest_is_well_formed(self):
        source=copy.deepcopy(self.source);target=copy.deepcopy(self.target)
        source['roleSettings']=[{'database':'source_db','role':'source_runtime','configSha256':'z'*64}]
        target['roleSettings']=[{'database':'target_db','role':'target_runtime','configSha256':'z'*64}]
        with self.assertRaisesRegex(acl.NotReady,'ACL_ROLE_SETTINGS_INVALID'): make_plan(source,target,self.mapping)

    def test_default_acl_missing_or_empty_state_is_not_inferred(self):
        target=copy.deepcopy(self.target);target['objects'].pop(9)
        with self.assertRaisesRegex(acl.NotReady,'ACL_OBJECT_INVENTORY_INCOMPLETE'): make_plan(self.source,target,self.mapping)
        target=copy.deepcopy(self.target);target['objects'][9]['acl'].clear()
        with self.assertRaisesRegex(acl.NotReady,'ACL_DEFAULT_EMPTY_STATE_UNSUPPORTED'): make_plan(self.source,target,self.mapping)

    def test_matching_catalog_is_noop(self):
        result=make_plan(self.source,self.target,self.mapping)
        self.assertEqual(result['operations'],[])
        self.assertIn('VERIFY_SOURCE_SNAPSHOT_AND_DUMP_BINDING',result['requires'])
        self.assertEqual(result['roleBinding']['targetRuntime'],'target_runtime')
        with self.assertRaisesRegex(acl.NotReady,'ACL_RUNTIME_ROLE_BINDING_INVALID'):
            acl.plan(self.source,self.target,self.mapping,source_runtime='source_owner',source_migration='source_owner')

    def test_cli_binds_exact_input_bytes_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);os.chmod(root,0o700)
            def write(name,obj):
                path=root/name;data=(json.dumps(obj)+'\n').encode();path.write_bytes(data);path.chmod(0o600)
                return path,hashlib.sha256(data).hexdigest()
            src,src_hash=write('source.json',self.source);dst,dst_hash=write('target.json',self.target)
            mapping={'schema':'zzsh.acl-restore-role-map.v1','sourceDatabase':'source_db','targetDatabase':'target_db',
                     'sourceCatalogSha256':src_hash,'targetCatalogSha256':dst_hash,'roles':self.mapping,
                     'sourceRuntimeRole':'source_runtime','targetRuntimeRole':'target_runtime',
                     'sourceMigrationRole':'source_owner','targetMigrationRole':'target_owner'}
            mapfile,map_hash=write('mapping.json',mapping);out=root/'plan.json'
            cmd=[sys.executable,str(Path(acl.__file__)), '--source',str(src),'--source-sha256',src_hash,
                 '--target',str(dst),'--target-sha256',dst_hash,'--mapping',str(mapfile),'--mapping-sha256',map_hash,'--out',str(out)]
            run=subprocess.run(cmd,capture_output=True);self.assertEqual(run.returncode,0,run.stderr)
            doc=json.loads(out.read_text());self.assertEqual(doc['inputSha256'],{'source':src_hash,'target':dst_hash,'mapping':map_hash})
            self.assertEqual(json.loads(run.stdout)['sha256'],hashlib.sha256(out.read_bytes()).hexdigest())
            self.assertNotEqual(subprocess.run(cmd,capture_output=True).returncode,0)
            src.write_text('{}');src.chmod(0o600);out2=root/'second.json';cmd[-1]=str(out2)
            changed=subprocess.run(cmd,capture_output=True)
            self.assertNotEqual(changed.returncode,0);self.assertEqual(json.loads(changed.stderr)['reason'],'ACL_INPUT_DIGEST_MISMATCH')
            self.assertFalse(out2.exists())

    def test_hash_and_parse_use_the_same_input_bytes(self):
        real_sha=hashlib.sha256
        for mutation in ('replace','inplace'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'catalog.json';original=b'{"value":"approved"}';path.write_bytes(original);path.chmod(0o600)
                expected=real_sha(original).hexdigest()
                def change_after_read(data):
                    if mutation=='replace': path.rename(Path(tmp)/'old.json')
                    path.write_bytes(b'{"value":"changed!"}');path.chmod(0o600)
                    return real_sha(data)
                with patch.object(acl.hashlib,'sha256',side_effect=change_after_read):
                    self.assertEqual(acl.read_sealed_json(path,expected),{'value':'approved'})


if __name__ == '__main__': unittest.main()
