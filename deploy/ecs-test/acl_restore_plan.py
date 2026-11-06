"""Produce a review-only ACL diff. This module never connects to PostgreSQL or executes SQL."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from acl_snapshot_compare import AclSnapshotError, canonical, normalize


class NotReady(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise NotReady(code)


IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,62}\Z')
ARGUMENTS = re.compile(r'[A-Za-z0-9_,. "\[\]]{0,4096}\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
TABLE = frozenset(('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'))
SEQUENCE = frozenset(('USAGE', 'SELECT', 'UPDATE'))
PERMISSIONS = {
    'database': frozenset(('CREATE', 'CONNECT', 'TEMPORARY')),
    'schema': frozenset(('CREATE', 'USAGE')),
    'relation': TABLE,
    'column': frozenset(('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')),
    'routine': frozenset(('EXECUTE',)),
    'type': frozenset(('USAGE',)),
}
DEFAULT_PERMISSIONS = {'r': TABLE, 'S': SEQUENCE, 'f': frozenset(('EXECUTE',)),
                       'T': frozenset(('USAGE',)), 'n': frozenset(('CREATE', 'USAGE'))}


def identifier(value):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None, 'ACL_IDENTIFIER_UNSUPPORTED')


def object_key(obj):
    return (obj['kind'], canonical(obj['identity']), obj['owner'] if obj['kind'] == 'defaultAcl' else '')


def validate_inventory(snapshot):
    schemas = set()
    relations = {}
    routine_keys, type_keys = set(), set()
    for role in snapshot['roles']:
        identifier(role['name'])
        require(role['configSha256'] is None or SHA256.fullmatch(role['configSha256']) is not None, 'ACL_ROLE_INVALID')
    for settings in snapshot['roleSettings']:
        require(SHA256.fullmatch(settings['configSha256']) is not None, 'ACL_ROLE_SETTINGS_INVALID')
    for item in snapshot['objects']:
        kind, identity, properties = item['kind'], item['identity'], item['properties']
        identifier(item['owner'])
        if kind == 'database':
            require(set(identity) == {'database'} and properties == {}, 'ACL_OBJECT_SHAPE_INVALID')
            identifier(identity['database'])
        elif kind == 'schema':
            require(set(identity) == {'schema'} and properties == {}, 'ACL_OBJECT_SHAPE_INVALID')
            identifier(identity['schema'])
            require((identity['schema'] == 'public' or identity['schema'].startswith('zzsh_'))
                    and identity['schema'] not in schemas, 'ACL_SCHEMA_INVALID')
            schemas.add(identity['schema'])
        elif kind == 'relation':
            require(set(identity) == {'schema', 'name', 'relkind'} and identity['relkind'] in ('r','p','v','m','S','f')
                    and set(properties) == {'rowSecurity','forceRowSecurity'}
                    and all(type(properties[k]) is bool for k in properties), 'ACL_OBJECT_SHAPE_INVALID')
            identifier(identity['schema']); identifier(identity['name'])
            pair = (identity['schema'], identity['name'])
            require(pair not in relations, 'ACL_OBJECT_INVENTORY_INVALID')
            relations[pair] = identity['relkind']
        elif kind == 'column':
            require(set(identity) == {'schema','relation','column'} and properties == {}, 'ACL_OBJECT_SHAPE_INVALID')
            for field in ('schema','relation','column'): identifier(identity[field])
        elif kind == 'routine':
            require(set(identity) == {'schema','name','arguments','kind'} and identity['kind'] in ('f','p','a','w')
                    and isinstance(identity['arguments'], str) and ARGUMENTS.fullmatch(identity['arguments']) is not None
                    and set(properties) == {'securityDefiner','config','definitionSha256'} and type(properties['securityDefiner']) is bool
                    and (properties['definitionSha256'] is None if identity['kind'] == 'a' else
                         isinstance(properties['definitionSha256'], str) and SHA256.fullmatch(properties['definitionSha256']) is not None)
                    and (properties['config'] is None or isinstance(properties['config'], list)
                         and all(isinstance(x, str) for x in properties['config'])), 'ACL_OBJECT_SHAPE_INVALID')
            identifier(identity['schema']); identifier(identity['name'])
            key = (identity['schema'],identity['name'],identity['arguments'])
            require(key not in routine_keys, 'ACL_OBJECT_INVENTORY_INVALID'); routine_keys.add(key)
        elif kind == 'type':
            require(set(identity) == {'schema','name','kind'} and identity['kind'] in ('b','c','d','e','p','r','m')
                    and properties == {}, 'ACL_OBJECT_SHAPE_INVALID')
            identifier(identity['schema']); identifier(identity['name'])
            key = (identity['schema'],identity['name'])
            require(key not in type_keys, 'ACL_OBJECT_INVENTORY_INVALID'); type_keys.add(key)
        else:
            require(kind == 'defaultAcl' and set(identity) == {'schema','objectType'}
                    and identity['objectType'] in DEFAULT_PERMISSIONS and properties == {}, 'ACL_OBJECT_SHAPE_INVALID')
            if identity['schema'] is not None: identifier(identity['schema'])
            require(identity['objectType'] != 'n' or identity['schema'] is None, 'ACL_DEFAULT_SCOPE_INVALID')
        allowed = (SEQUENCE if kind == 'relation' and identity['relkind'] == 'S' else
                   DEFAULT_PERMISSIONS[identity['objectType']] if kind == 'defaultAcl' else PERMISSIONS[kind])
        for grant in item['acl']:
            identifier(grant['grantor'])
            if grant['grantee'] != 'PUBLIC': identifier(grant['grantee'])
            require(grant['privilege'] in allowed, 'ACL_PRIVILEGE_UNSUPPORTED')
            require(grant['grantor'] == item['owner'] and grant['grantable'] is False, 'ACL_GRANT_CHAIN_UNSUPPORTED')
    for item in snapshot['objects']:
        identity = item['identity']
        if item['kind'] in ('relation','column','routine','type'):
            require(identity['schema'] in schemas, 'ACL_OBJECT_INVENTORY_INCOMPLETE')
        if item['kind'] == 'column':
            require(relations.get((identity['schema'],identity['relation'])) in ('r','p','v','m','f'),
                    'ACL_OBJECT_INVENTORY_INCOMPLETE')
        if item['kind'] == 'defaultAcl' and identity['schema'] is not None:
            require(identity['schema'] in schemas, 'ACL_OBJECT_INVENTORY_INCOMPLETE')
    for policy in snapshot['policies']:
        require(set(policy) == {'schema','relation','name','command','permissive','roles','using','check'}
                and type(policy['permissive']) is bool and policy['command'] in ('*','r','a','w','d')
                and all(isinstance(policy[k], str) or policy[k] is None for k in ('using','check')),
                'ACL_POLICY_INVALID')
        for field in ('schema','relation','name'): identifier(policy[field])
        require((policy['schema'],policy['relation']) in relations, 'ACL_OBJECT_INVENTORY_INCOMPLETE')


def plan(source, target, role_map, *, source_runtime, source_migration):
    try:
        identifier(source_runtime); identifier(source_migration)
        require(source_runtime != source_migration and isinstance(role_map, dict)
                and source_runtime in role_map and source_migration in role_map
                and role_map[source_runtime] != role_map[source_migration], 'ACL_RUNTIME_ROLE_BINDING_INVALID')
        require(isinstance(target, dict) and isinstance(target.get('roles'), list), 'ACL_SNAPSHOT_INVALID')
        target_names = [role.get('name') for role in target['roles'] if isinstance(role, dict)]
        require(len(target_names) == len(target['roles']) and all(isinstance(name,str) for name in target_names)
                and len(set(target_names)) == len(target_names), 'ACL_ROLE_INVALID')
        left = normalize(source, role_map, target.get('database'))
        right = normalize(target, {name:name for name in target_names}, target.get('database'))
        validate_inventory(left); validate_inventory(right)
    except NotReady:
        raise
    except AclSnapshotError as error:
        raise NotReady(str(error)) from error
    except (KeyError, TypeError, ValueError) as error:
        raise NotReady('ACL_SNAPSHOT_INVALID') from error
    require(set(left) == set(right) and all(left[key] == right[key] for key in left if key not in ('objects','policies')),
            'ACL_ROLE_ATTRIBUTES_OR_MEMBERSHIP_DIFFER')
    require(left['policies'] == right['policies'], 'ACL_POLICY_DIFFER')
    runtime = role_map[source_runtime]
    runtime_attributes = next(role for role in right['roles'] if role['name'] == runtime)
    require(not any(runtime_attributes[key] for key in ('superuser','createRole','createDb','replication','bypassRls')),
            'ACL_RUNTIME_PRIVILEGE_INVALID')
    reachable = {runtime}
    while True:
        expanded = reachable | {entry['role'] for entry in right['memberships'] if entry['member'] in reachable}
        if expanded == reachable: break
        reachable = expanded
    require(not ({item['owner'] for item in right['objects']} & reachable), 'ACL_RUNTIME_OWNER_AUTHORITY_INVALID')
    source_objects = {object_key(item):item for item in left['objects']}
    target_objects = {object_key(item):item for item in right['objects']}
    require(set(source_objects) == set(target_objects), 'ACL_OBJECT_INVENTORY_INCOMPLETE')
    operations = []
    for key in sorted(source_objects):
        source_item, target_item = source_objects[key], target_objects[key]
        require(source_item['owner'] == target_item['owner'] and source_item['properties'] == target_item['properties'],
                'ACL_OWNER_OR_OBJECT_PROPERTIES_DIFFER')
        source_grants = {canonical(grant):grant for grant in source_item['acl']}
        target_grants = {canonical(grant):grant for grant in target_item['acl']}
        if source_item['kind'] == 'defaultAcl' and source_grants != target_grants:
            require(source_grants and target_grants, 'ACL_DEFAULT_EMPTY_STATE_UNSUPPORTED')
        if source_item['kind'] == 'type' and source_grants != target_grants:
            require(source_item['identity']['kind'] in ('d','e','r','m'), 'ACL_TYPE_MUTATION_UNSUPPORTED')
        for action, missing in (('REVOKE',set(target_grants)-set(source_grants)), ('GRANT',set(source_grants)-set(target_grants))):
            grants = target_grants if action == 'REVOKE' else source_grants
            for grant_key in sorted(missing):
                operations.append({'action':action,'kind':source_item['kind'],'identity':source_item['identity'],
                                   'owner':source_item['owner'],'grant':grants[grant_key]})
    operations.sort(key=lambda operation:(operation['action'] != 'REVOKE', canonical(operation)))
    return {'schema':'zzsh.acl-restore-plan.v1','status':'REVIEW_ONLY_NO_SQL_OR_WRITES',
            'sourceDatabase':source['database'],'targetDatabase':target['database'],
            'roleBinding':{'sourceRuntime':source_runtime,'targetRuntime':role_map[source_runtime],
                           'sourceMigration':source_migration,'targetMigration':role_map[source_migration]},
            'roleMapping':dict(sorted(role_map.items())),
            'counts':{'objects':len(source_objects),'roles':len(left['roles']),'memberships':len(left['memberships']),
                      'roleSettings':len(left.get('roleSettings', [])),
                      'policies':len(left['policies']),'operations':len(operations)},'operations':operations,
            'requires': ['VERIFY_SOURCE_SNAPSHOT_AND_DUMP_BINDING','VERIFY_TARGET_SNAPSHOT_AND_ROLE_OIDS',
                         'VERIFY_FUNCTION_BODIES_AND_HARDCODED_ROLE_REFERENCES',
                         'INDEPENDENT_APPROVAL_AND_ATOMIC_EXECUTOR','INDEPENDENT_ACL_READBACK']}


def read_sealed_json(path, expected):
    require(isinstance(expected, str) and SHA256.fullmatch(expected) is not None, 'ACL_INPUT_DIGEST_INVALID')
    path = Path(path)
    require(path.is_absolute() and all(not parent.is_symlink() for parent in (path,*path.parents))
            and hasattr(os, 'O_NOFOLLOW'), 'ACL_INPUT_FILE_INVALID')
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_size <= 64*1024*1024 and (info.st_mode & 0o007) == 0,
                    'ACL_INPUT_FILE_INVALID')
            data = stream.read(64*1024*1024 + 1)
    except OSError as error:
        raise NotReady('ACL_INPUT_FILE_INVALID') from error
    require(len(data) <= 64*1024*1024 and hashlib.sha256(data).hexdigest() == expected, 'ACL_INPUT_DIGEST_MISMATCH')
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'ACL_INPUT_JSON_INVALID'); result[key] = value
        return result
    try:
        result = json.loads(data, object_pairs_hook=object_pairs,
                            parse_constant=lambda _value: (_ for _ in ()).throw(NotReady('ACL_INPUT_JSON_INVALID')))
    except (ValueError, UnicodeError) as error:
        raise NotReady('ACL_INPUT_JSON_INVALID') from error
    require(isinstance(result, dict), 'ACL_INPUT_JSON_INVALID')
    return result


def main():
    parser = argparse.ArgumentParser(description='Generate an offline review-only PostgreSQL ACL repair plan.')
    for name in ('source','source-sha256','target','target-sha256','mapping','mapping-sha256','out'):
        parser.add_argument('--'+name, required=True)
    args = parser.parse_args()
    source = read_sealed_json(args.source,args.source_sha256)
    target = read_sealed_json(args.target,args.target_sha256)
    mapping = read_sealed_json(args.mapping,args.mapping_sha256)
    require(set(mapping) == {'schema','sourceDatabase','targetDatabase','sourceCatalogSha256','targetCatalogSha256','roles',
                             'sourceRuntimeRole','targetRuntimeRole','sourceMigrationRole','targetMigrationRole'}
            and mapping['schema'] == 'zzsh.acl-restore-role-map.v1' and mapping['sourceDatabase'] == source.get('database')
            and mapping['targetDatabase'] == target.get('database') and mapping['sourceCatalogSha256'] == args.source_sha256
            and mapping['targetCatalogSha256'] == args.target_sha256, 'ACL_MAPPING_BINDING_MISMATCH')
    require(isinstance(mapping['roles'],dict) and mapping['roles'].get(mapping['sourceRuntimeRole']) == mapping['targetRuntimeRole']
            and mapping['roles'].get(mapping['sourceMigrationRole']) == mapping['targetMigrationRole'], 'ACL_RUNTIME_ROLE_BINDING_INVALID')
    result = plan(source,target,mapping['roles'],source_runtime=mapping['sourceRuntimeRole'],source_migration=mapping['sourceMigrationRole'])
    result['inputSha256'] = {'source':args.source_sha256,'target':args.target_sha256,'mapping':args.mapping_sha256}
    result['transactionSnapshots'] = {'source':source['transactionSnapshot'],'target':target['transactionSnapshot']}
    out = Path(args.out)
    require(out.is_absolute() and out.parent.is_dir() and all(not parent.is_symlink() for parent in (out.parent,*out.parent.parents))
            and (out.parent.stat().st_mode & 0o077) == 0, 'ACL_OUTPUT_DIRECTORY_INVALID')
    data = (json.dumps(result, ensure_ascii=True, sort_keys=True, indent=2)+'\n').encode()
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        dir_fd = os.open(out.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as error:
        raise NotReady('ACL_OUTPUT_WRITE_FAILED') from error
    print(json.dumps({'status':'REVIEW_ONLY_NO_SQL_OR_WRITES','sha256':hashlib.sha256(data).hexdigest(),
                      'operationCount':len(result['operations'])}))


if __name__ == '__main__':
    try:
        main()
    except (NotReady, KeyError, TypeError, ValueError, OSError):
        error = sys.exc_info()[1]
        reason = str(error) if isinstance(error, NotReady) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'ACL_INPUT_INVALID'
        print(json.dumps({'status':'NOT_READY','reason':reason}), file=sys.stderr)
        sys.exit(2)
