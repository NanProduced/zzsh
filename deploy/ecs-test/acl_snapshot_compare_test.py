import copy
import unittest

import acl_snapshot_compare as acl


def sample(database='source', owner='source_owner', runtime='source_runtime'):
    attributes={'superuser':False,'inherit':True,'createRole':False,'createDb':False,'login':False,'replication':False,'bypassRls':False,
                'connectionLimit':-1,'validUntil':None,'configSha256':None}
    grant=lambda grantee,privilege: {'grantor':owner,'grantee':grantee,'privilege':privilege,'grantable':False}
    return {'schema':'zzsh.acl-snapshot-catalog.v1','database':database,'transactionReadOnly':'on',
        'transactionIsolation':'repeatable read','transactionSnapshot':'synthetic',
        'roles':[dict(attributes,name=owner),dict(attributes,name=runtime)],'memberships':[],'roleSettings':[],
        'objects':[
            {'kind':'database','identity':{'database':database},'owner':owner,'properties':{},'acl':[grant(owner,'CONNECT')]},
            {'kind':'relation','identity':{'schema':'zzsh_fixture','name':'entry','relkind':'r'},'owner':owner,'properties':{},'acl':[grant(runtime,'SELECT')]},
            {'kind':'column','identity':{'schema':'zzsh_fixture','relation':'entry','column':'amount'},'owner':owner,'properties':{},'acl':[grant(runtime,'UPDATE')]},
            {'kind':'routine','identity':{'schema':'zzsh_fixture','name':'check','arguments':'integer','kind':'f'},'owner':owner,
             'properties':{'securityDefiner':True,'config':['search_path=pg_catalog']},'acl':[grant(runtime,'EXECUTE')]},
            {'kind':'routine','identity':{'schema':'zzsh_fixture','name':'check','arguments':'text','kind':'f'},'owner':owner,
             'properties':{'securityDefiner':False,'config':None},'acl':[grant('PUBLIC','EXECUTE')]},
            {'kind':'defaultAcl','identity':{'schema':None,'objectType':'f'},'owner':owner,'properties':{},'acl':[grant(owner,'EXECUTE')]},
            {'kind':'defaultAcl','identity':{'schema':'zzsh_fixture','objectType':'r'},'owner':owner,'properties':{},'acl':[grant(runtime,'SELECT')]},
        ],'policies':[]}


class AclSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.source=sample();self.target=sample('target','target_owner','target_runtime')
        self.mapping={'source_owner':'target_owner','source_runtime':'target_runtime'}

    def test_bijective_mapping_normalizes_database_role_and_grant_order(self):
        self.target['objects'].reverse();self.target['roles'].reverse()
        self.assertEqual(acl.compare(self.source,self.target,self.mapping),{'matches':True,'differences':{}})

    def test_permissions_owner_routine_overload_defaults_and_roles_are_compared(self):
        for name,change in (
            ('public_function',lambda x:x['objects'][3]['acl'].append({'grantor':'target_owner','grantee':'PUBLIC','privilege':'EXECUTE','grantable':False})),
            ('column',lambda x:x['objects'][2]['acl'].clear()),
            ('overload',lambda x:x['objects'][4]['identity'].update(arguments='bigint')),
            ('default_global',lambda x:x['objects'][5]['acl'].clear()),
            ('default_schema',lambda x:x['objects'][6]['acl'].clear()),
            ('owner_merge',lambda x:x['objects'][1].update(owner='target_runtime')),
            ('definer',lambda x:x['objects'][3]['properties'].update(securityDefiner=False)),
            ('bypass',lambda x:x['roles'][1].update(bypassRls=True)),
            ('membership',lambda x:x['memberships'].append({'role':'target_owner','member':'target_runtime','grantor':'target_owner','admin':False,'inherit':True,'set':True})),
        ):
            with self.subTest(name=name):
                changed=copy.deepcopy(self.target);change(changed)
                self.assertFalse(acl.compare(self.source,changed,self.mapping)['matches'])

    def test_unknown_or_colliding_roles_and_bad_transaction_fail_closed(self):
        for mapping in ({'source_owner':'target_owner'}, {'source_owner':'target_owner','source_runtime':'target_owner'}):
            with self.assertRaises(acl.AclSnapshotError): acl.compare(self.source,self.target,mapping)
        bad=copy.deepcopy(self.source);bad['transactionReadOnly']='off'
        with self.assertRaises(acl.AclSnapshotError): acl.compare(bad,self.target,self.mapping)
        bad=copy.deepcopy(self.source);bad['objects'][1]['acl'][0]['grantee']='unknown'
        with self.assertRaises(acl.AclSnapshotError): acl.compare(bad,self.target,self.mapping)


if __name__ == '__main__': unittest.main()
