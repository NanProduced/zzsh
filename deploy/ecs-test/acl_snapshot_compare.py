"""Compare captured PostgreSQL ACL catalogs after an explicit bijective role mapping.

This is a read-only comparison primitive, not permission to alter a database or
proof that either input was bound to a dump. The caller must verify the capture
receipts and content hashes before supplying them.
"""
import copy
import hashlib
import json
import re


class AclSnapshotError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise AclSnapshotError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))


def normalize(snapshot, mapping, target_database):
    require(isinstance(snapshot, dict) and snapshot.get('schema') == 'zzsh.acl-snapshot-catalog.v1', 'ACL_SNAPSHOT_INVALID')
    require(snapshot.get('transactionReadOnly') == 'on' and snapshot.get('transactionIsolation') == 'repeatable read'
            and isinstance(snapshot.get('transactionSnapshot'), str) and snapshot['transactionSnapshot'], 'ACL_SNAPSHOT_TRANSACTION_INVALID')
    require(isinstance(snapshot.get('database'), str) and snapshot['database'] and isinstance(target_database, str) and target_database,
            'ACL_DATABASE_INVALID')
    categories = ('objects', 'roles', 'memberships', 'roleSettings', 'policies')
    require(all(isinstance(snapshot.get(name), list) for name in categories), 'ACL_SNAPSHOT_INVALID')
    roles = snapshot['roles']
    role_fields = ('superuser','inherit','createRole','createDb','login','replication','bypassRls')
    require(all(isinstance(r, dict) and set(r) == {'name','connectionLimit','validUntil','configSha256',*role_fields} and isinstance(r.get('name'), str)
                and r['name'] and r['name'] != 'PUBLIC' and all(type(r[k]) is bool for k in role_fields)
                and type(r['connectionLimit']) is int and (r['validUntil'] is None or isinstance(r['validUntil'], str))
                and (r['configSha256'] is None or isinstance(r['configSha256'], str) and re.fullmatch(r'[a-f0-9]{64}',r['configSha256'])) for r in roles),
            'ACL_ROLE_INVALID')
    source_names = [r['name'] for r in roles]
    require(len(source_names) == len(set(source_names)) and isinstance(mapping, dict) and set(mapping) == set(source_names),
            'ACL_ROLE_MAPPING_INCOMPLETE')
    require(all(isinstance(v, str) and v and v != 'PUBLIC' for v in mapping.values())
            and len(set(mapping.values())) == len(mapping), 'ACL_ROLE_MAPPING_NOT_BIJECTIVE')

    def role(value, *, allow_public=False):
        require(isinstance(value, str) and (allow_public and value == 'PUBLIC' or value in mapping), 'ACL_ROLE_UNMAPPED')
        return value if value == 'PUBLIC' else mapping[value]

    result = {name: [] for name in categories}
    for entry in roles:
        item = copy.deepcopy(entry);item['name'] = role(item['name']);result['roles'].append(item)
    for entry in snapshot['objects']:
        require(isinstance(entry, dict) and set(entry) == {'kind','identity','owner','properties','acl'}
                and entry.get('kind') in ('database','schema','relation','column','routine','type','defaultAcl')
                and isinstance(entry.get('identity'), dict) and entry['identity']
                and isinstance(entry.get('properties'), dict) and isinstance(entry.get('acl'), list), 'ACL_OBJECT_INVALID')
        item = copy.deepcopy(entry);item['owner'] = role(item.get('owner'))
        if item['kind'] == 'database':
            require(item['identity'].get('database') == snapshot['database'], 'ACL_DATABASE_INVALID')
            item['identity']['database'] = target_database
        for grant in item['acl']:
            require(isinstance(grant, dict) and set(grant) == {'grantor','grantee','privilege','grantable'}
                    and isinstance(grant.get('privilege'), str) and type(grant.get('grantable')) is bool,
                    'ACL_GRANT_INVALID')
            grant['grantor'] = role(grant.get('grantor'));grant['grantee'] = role(grant.get('grantee'),allow_public=True)
        item['acl'].sort(key=canonical)
        require(len({canonical(g) for g in item['acl']}) == len(item['acl']), 'ACL_DUPLICATE_GRANT')
        result['objects'].append(item)
    identities = [(o['kind'], canonical(o['identity']), o['owner'] if o['kind']=='defaultAcl' else None) for o in result['objects']]
    require(len(set(identities)) == len(identities) and sum(o['kind']=='database' for o in result['objects']) == 1,
            'ACL_OBJECT_INVENTORY_INVALID')
    for entry in snapshot['memberships']:
        require(isinstance(entry, dict) and set(entry) == {'role','member','grantor','admin','inherit','set'}
                and all(type(entry.get(k)) is bool for k in ('admin','inherit','set')), 'ACL_MEMBERSHIP_INVALID')
        item=copy.deepcopy(entry)
        for key in ('role','member','grantor'): item[key]=role(item.get(key))
        result['memberships'].append(item)
    for entry in snapshot['roleSettings']:
        require(isinstance(entry, dict) and set(entry)=={'database','role','configSha256'}
                and isinstance(entry['configSha256'], str) and re.fullmatch(r'[a-f0-9]{64}',entry['configSha256']), 'ACL_ROLE_SETTINGS_INVALID')
        item=copy.deepcopy(entry)
        if item['database'] is not None:
            require(item['database']==snapshot['database'], 'ACL_DATABASE_INVALID')
            item['database']=target_database
        if item['role'] is not None: item['role']=role(item['role'])
        result['roleSettings'].append(item)
    for entry in snapshot['policies']:
        require(isinstance(entry, dict) and isinstance(entry.get('roles'), list), 'ACL_POLICY_INVALID')
        item=copy.deepcopy(entry);item['roles']=sorted(role(r,allow_public=True) for r in item['roles']);result['policies'].append(item)
    for category in categories:
        result[category].sort(key=canonical)
        require(len({canonical(item) for item in result[category]}) == len(result[category]), 'ACL_DUPLICATE_ENTRY')
    return result


def compare(source, target, source_to_target):
    require(isinstance(target, dict) and isinstance(target.get('roles'), list), 'ACL_SNAPSHOT_INVALID')
    target_names = [r.get('name') for r in target.get('roles', []) if isinstance(r, dict)]
    require(len(target_names) == len(target.get('roles', [])) and len(target_names) == len(set(target_names)), 'ACL_ROLE_INVALID')
    left = normalize(source, source_to_target, target.get('database'))
    right = normalize(target, {name:name for name in target_names}, target.get('database'))
    differences = {}
    for category in ('objects','roles','memberships','roleSettings','policies'):
        if left[category] != right[category]:
            differences[category] = {'sourceCount':len(left[category]),'targetCount':len(right[category]),
                'sourceSha256':hashlib.sha256(canonical(left[category]).encode()).hexdigest(),
                'targetSha256':hashlib.sha256(canonical(right[category]).encode()).hexdigest()}
    return {'matches':not differences,'differences':differences}
