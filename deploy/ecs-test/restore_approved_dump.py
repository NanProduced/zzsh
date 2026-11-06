#!/usr/bin/env python3
"""First test-server restore only. Never converts MySQL or changes a nonempty target."""

import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
DATABASE = 'zzsh_ecs_test'
OWNER = 'zzsh_ecs_owner'
MIGRATION = 'zzsh_ecs_migration'
RUNTIME = 'zzsh_ecs_runtime'
MARKER = 'zzsh:ecs-test:v1'
LOCK_PATH = Path('/run/lock/zzsh-ecs-test-dump-restore.lock')
HEX = re.compile(r'^[a-f0-9]{64}$')
PROJECT = re.compile(r'^zzsh-ecs-test(?:-[a-z0-9][a-z0-9-]{0,30})?$')
KEY_REF = re.compile(r'^(?:AUTH_USER_SECRET_FILE|AUTH_ADMIN_SECRET_FILE|USER_IDENTITY_SUBJECT_HMAC_KEY_FILE|ORDER_CONFIRMATION_SECRET_FILE|LISTING_CURSOR_SECRET_FILE|WITHDRAWAL_BANK_KEY_[A-Z0-9_]+_FILE)$')
REQUIRED_KEYS = frozenset(('AUTH_USER_SECRET_FILE', 'AUTH_ADMIN_SECRET_FILE', 'USER_IDENTITY_SUBJECT_HMAC_KEY_FILE', 'ORDER_CONFIRMATION_SECRET_FILE', 'LISTING_CURSOR_SECRET_FILE'))
TABLES = {
    'users': 'zzsh_auth_user."user"', 'accounts': 'zzsh_supply.rental_account',
    'orders': 'zzsh_order.legacy_order_read_snapshot', 'ledger': 'zzsh_order.settlement_ledger_entry',
    'observations': 'zzsh_order.personal_finance_observation', 'membership': 'zzsh_iam.membership_growth_state',
    'rentalMembership': 'zzsh_iam.user_rental_membership',
    'membershipLegacyCoverage': 'zzsh_iam.membership_growth_legacy_coverage',
    'membershipContribution': 'zzsh_iam.membership_growth_contribution',
    'membershipPolicy': 'zzsh_iam.membership_growth_policy',
    'membershipLegacyReadAdmission': 'zzsh_iam.membership_growth_legacy_read_admission',
    'distribution': 'zzsh_order.distribution_participant', 'banks': 'zzsh_order.withdrawal_bank_binding',
}


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def digest_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def immutable_staging_capacity():
    """Avoid allocating the sealed in-memory archive when the host/cgroup lacks headroom."""
    try:
        info = Path('/proc/meminfo').read_text(encoding='ascii')
        match = re.search(r'^MemAvailable:\s+(\d+)\s+kB$', info, re.MULTILINE)
        require(match is not None, 'IMMUTABLE_STAGING_CAPACITY_UNAVAILABLE')
        available = int(match.group(1)) * 1024
        for limit_path, used_path in ((Path('/sys/fs/cgroup/memory.max'), Path('/sys/fs/cgroup/memory.current')),
                                      (Path('/sys/fs/cgroup/memory/memory.limit_in_bytes'), Path('/sys/fs/cgroup/memory/memory.usage_in_bytes'))):
            if limit_path.exists() and used_path.exists():
                limit, used = limit_path.read_text().strip(), used_path.read_text().strip()
                require(used.isdigit() and (limit == 'max' or limit.isdigit()), 'IMMUTABLE_STAGING_CAPACITY_UNAVAILABLE')
                if limit != 'max' and int(limit) < (1 << 60):
                    available = min(available, max(0, int(limit) - int(used)))
                break
        return max(0, available - 128 * 1024 * 1024)
    except (OSError, ValueError) as error:
        raise Refused('IMMUTABLE_STAGING_CAPACITY_UNAVAILABLE') from error


@contextlib.contextmanager
def immutable_approved_dump(path, expected_sha, expected_bytes):
    """Verify bytes while copying one opened source into an OS-sealed anonymous file."""
    require(HEX.fullmatch(str(expected_sha)) and type(expected_bytes) is int and expected_bytes > 0, 'DUMP_MANIFEST_INVALID')
    require(expected_bytes <= immutable_staging_capacity(), 'IMMUTABLE_STAGING_INSUFFICIENT_MEMORY')
    require(hasattr(os, 'memfd_create') and hasattr(os, 'MFD_ALLOW_SEALING') and all(hasattr(fcntl, name) for name in
        ('F_ADD_SEALS', 'F_GET_SEALS', 'F_SEAL_WRITE', 'F_SEAL_GROW', 'F_SEAL_SHRINK', 'F_SEAL_SEAL')),
        'IMMUTABLE_STAGING_UNAVAILABLE')
    try:
        source_fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
    except OSError as error:
        raise Refused('DUMP_SOURCE_UNAVAILABLE') from error
    stage = None
    try:
        with os.fdopen(source_fd, 'rb', closefd=True) as source:
            meta = os.fstat(source.fileno())
            require(stat.S_ISREG(meta.st_mode) and meta.st_size == expected_bytes and (meta.st_mode & 0o007) == 0, 'DUMP_SOURCE_INVALID')
            fcntl.flock(source.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            fd = os.memfd_create('zzsh-approved-dump', os.MFD_ALLOW_SEALING | getattr(os, 'MFD_CLOEXEC', 0))
            stage = os.fdopen(fd, 'w+b', buffering=0)
            h, total = hashlib.sha256(), 0
            for part in iter(lambda: source.read(1024 * 1024), b''):
                total += len(part)
                require(total <= expected_bytes, 'DUMP_CONTENT_MISMATCH')
                h.update(part)
                pending = memoryview(part)
                while pending:
                    written = stage.write(pending)
                    require(written is not None and written > 0, 'IMMUTABLE_STAGING_WRITE_FAILED')
                    pending = pending[written:]
            require(total == expected_bytes and h.hexdigest() == expected_sha, 'DUMP_CONTENT_MISMATCH')
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(stage.fileno(), fcntl.F_ADD_SEALS, seals)
        require(fcntl.fcntl(stage.fileno(), fcntl.F_GET_SEALS) & seals == seals, 'IMMUTABLE_STAGING_UNAVAILABLE')
        stage.seek(0)
        yield stage
    except OSError as error:
        raise Refused('IMMUTABLE_STAGING_UNAVAILABLE') from error
    finally:
        if stage is not None:
            stage.close()


def private_file(path, *, base=None):
    path = Path(path)
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), 'PRIVATE_FILE_REQUIRED')
    actual = path.resolve(strict=True)
    if base is not None:
        require(actual.is_relative_to(Path(base).resolve(strict=True)), 'PRIVATE_FILE_OUTSIDE_ROOT')
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), 'PRIVATE_SYMLINK_REFUSED')
    if os.name == 'posix':
        require((path.stat().st_mode & 0o007) == 0, 'PRIVATE_FILE_PERMISSIONS_TOO_OPEN')
    return actual


def private_dir(path):
    path = Path(path)
    require(path.is_absolute() and path.is_dir() and not path.is_symlink(), 'PRIVATE_DIRECTORY_REQUIRED')
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), 'PRIVATE_SYMLINK_REFUSED')
    if os.name == 'posix':
        require((path.stat().st_mode & 0o077) == 0, 'PRIVATE_DIRECTORY_PERMISSIONS_TOO_OPEN')
    return path.resolve(strict=True)


def read_json(path):
    with open(path, 'r', encoding='utf-8') as stream:
        value = json.load(stream)
    require(isinstance(value, dict), 'JSON_OBJECT_REQUIRED')
    return value


def read_verified_json(path, expected_sha, mismatch):
    require(isinstance(expected_sha, str) and HEX.fullmatch(expected_sha), mismatch)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        with os.fdopen(fd, 'rb') as stream:
            meta = os.fstat(stream.fileno())
            require(stat.S_ISREG(meta.st_mode) and (meta.st_mode & 0o007) == 0, 'PRIVATE_FILE_REQUIRED')
            contents = stream.read()
    except OSError as error:
        raise Refused('PRIVATE_FILE_REQUIRED') from error
    require(hashlib.sha256(contents).hexdigest() == expected_sha, mismatch)
    value = json.loads(contents)
    require(isinstance(value, dict), 'JSON_OBJECT_REQUIRED')
    return value


def write_new(path, value):
    payload = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    sync_dir(Path(path).parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_checkpoint(path, value):
    temp = Path(str(path) + '.' + uuid.uuid4().hex + '.new')
    write_new(temp, value)
    os.replace(temp, path)
    sync_dir(Path(path).parent)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def parse_utc(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC_TIMESTAMP_REQUIRED')
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as error:
        raise Refused('UTC_TIMESTAMP_REQUIRED') from error
    return parsed


def parse_manifest(value):
    require(value.get('schema') == 'zzsh.ecs-test-approved-dump.v1', 'MANIFEST_SCHEMA_INVALID')
    require(set(value) == {'schema', 'project', 'dump', 'source', 'keys', 'bankVersions', 'expected', 'startServices'}, 'MANIFEST_FIELDS_INVALID')
    require(isinstance(value['project'], str) and PROJECT.fullmatch(value['project']), 'PROJECT_INVALID')
    dump, source, keys, expected = value['dump'], value['source'], value['keys'], value['expected']
    require(isinstance(dump, dict) and set(dump) == {'path', 'sha256', 'bytes'} and isinstance(dump['path'], str)
            and HEX.fullmatch(str(dump['sha256'])) and type(dump['bytes']) is int and dump['bytes'] > 0, 'DUMP_MANIFEST_INVALID')
    require(isinstance(source, dict) and set(source) == {'postgresMajor', 'cutoff', 'datasetSha256', 'migrationTreeSha256', 'journalHashes', 'reviewedAuthArtifacts'}
            and source['postgresMajor'] == 16 and HEX.fullmatch(str(source['datasetSha256'])) and HEX.fullmatch(str(source['migrationTreeSha256']))
            and source['reviewedAuthArtifacts'] in ('preserved-approved', 'sanitized-approved'), 'SOURCE_MANIFEST_INVALID')
    parse_utc(source['cutoff'])
    require(isinstance(source['journalHashes'], list) and source['journalHashes'] and all(HEX.fullmatch(str(x)) for x in source['journalHashes']), 'JOURNAL_MANIFEST_INVALID')
    require(isinstance(keys, dict) and REQUIRED_KEYS.issubset(keys) and all(KEY_REF.fullmatch(k) and HEX.fullmatch(str(v)) for k, v in keys.items()), 'SOURCE_KEY_FINGERPRINTS_INVALID')
    require(isinstance(value['bankVersions'], list) and all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', v) for v in value['bankVersions'])
            and len(set(value['bankVersions'])) == len(value['bankVersions']), 'BANK_VERSIONS_INVALID')
    require(isinstance(expected, dict) and set(expected) == {'tables', 'ledgerDebitCents', 'ledgerCreditCents'}
            and isinstance(expected['tables'], dict) and set(expected['tables']) == set(TABLES)
            and all(type(n) is int and n >= 0 for n in expected['tables'].values())
            and all(isinstance(expected[k], str) and re.fullmatch(r'0|[1-9][0-9]{0,30}', expected[k]) for k in ('ledgerDebitCents', 'ledgerCreditCents')),
            'EXPECTED_READBACK_INVALID')
    require(type(value['startServices']) is bool, 'START_SERVICES_DECISION_REQUIRED')
    require(value['startServices'] is False, 'SOURCE_ACL_BASELINE_NOT_VERIFIED')
    require(expected['tables']['banks'] == 0 or value['bankVersions'], 'SOURCE_BANK_KEY_VERSIONS_REQUIRED')
    return value


def command(args, *, stdin=None, capture=True, timeout=300):
    try:
        result = subprocess.run(args, stdin=stdin, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.PIPE, check=False, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise Refused('COMMAND_TIMEOUT') from error
    except OSError as error:
        raise Refused('COMMAND_UNAVAILABLE') from error
    require(result.returncode == 0, 'COMMAND_FAILED')
    return result.stdout if capture else b''


class Compose:
    def __init__(self, project, compose_file, env_file):
        self.project = project
        self.prefix = ['docker', 'compose', '--project-name', project, '--env-file', str(env_file), '-f', str(compose_file)]
        self.pinned_images = None
        self._pin_fd = None

    def pin_images(self, images):
        require(self._pin_fd is None and set(images) == {'api','web','proxy','postgres','redis'}
                and all(re.fullmatch(r'sha256:[a-f0-9]{64}', image) for image in images.values()), 'PINNED_IMAGES_INVALID')
        require(hasattr(os, 'memfd_create') and hasattr(os, 'MFD_ALLOW_SEALING') and all(hasattr(fcntl, name) for name in
                ('F_ADD_SEALS','F_GET_SEALS','F_SEAL_WRITE','F_SEAL_GROW','F_SEAL_SHRINK','F_SEAL_SEAL')), 'PINNED_IMAGES_UNAVAILABLE')
        services = {name: {'image': image} for name, image in images.items()}
        services.update({'migration': {'image': images['api']}, 'db-setup': {'image': images['postgres']}})
        try:
            fd = os.memfd_create('zzsh-compose-pinned-images', os.MFD_ALLOW_SEALING | getattr(os, 'MFD_CLOEXEC', 0))
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(json.dumps({'services':services}, separators=(',', ':')).encode())
            seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
            require(fcntl.fcntl(fd, fcntl.F_GET_SEALS) & seals == seals, 'PINNED_IMAGES_UNAVAILABLE')
        except Exception:
            if 'fd' in locals(): os.close(fd)
            raise
        self._pin_fd = fd
        self.pinned_images = dict(images)
        self.prefix.extend(('-f', '/proc/%d/fd/%d' % (os.getpid(), fd)))

    def close(self):
        if self._pin_fd is not None:
            os.close(self._pin_fd)
            self._pin_fd = None

    def __del__(self):
        self.close()

    def call(self, *args, stdin=None, capture=True, timeout=300):
        return command([*self.prefix, *args], stdin=stdin, capture=capture, timeout=timeout)

    def config(self):
        return json.loads(self.call('--profile', 'tools', 'config', '--format', 'json'))

    def running(self, name):
        return bool(self.call('ps', '--status', 'running', '-q', name).strip())

    def stopped_postgres_resources(self):
        config = self.config()
        mounts = [v for v in config.get('services', {}).get('postgres', {}).get('volumes', [])
                  if v.get('target') == '/var/lib/postgresql/data']
        require(len(mounts) == 1 and mounts[0].get('type') in ('volume', 'tmpfs'), 'POSTGRES_DATA_MOUNT_INVALID')
        volume_exists = False
        if mounts[0]['type'] == 'volume':
            volume = config.get('volumes', {}).get(mounts[0].get('source'), {})
            name = volume.get('name') if isinstance(volume, dict) else None
            require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', name), 'POSTGRES_DATA_VOLUME_INVALID')
            names = command(['docker', 'volume', 'ls', '--filter', 'name=' + name, '--format', '{{.Name}}']).decode().splitlines()
            volume_exists = name in names
        ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.project,
                       '--filter', 'label=com.docker.compose.service=postgres']).strip()
        return {'postgresContainerExists': bool(ids), 'postgresDataVolumeExists': volume_exists}

    def sql(self, database, sql, *, readonly=True):
        if self.pinned_images is not None:
            ids = self.call('ps', '--status', 'running', '-q', 'postgres').decode().splitlines()
            require(len(ids) == 1, 'POSTGRES_CONTAINER_UNAVAILABLE')
            image = command(['docker','inspect','--format','{{.Image}}',ids[0]]).decode().strip()
            require(image == self.pinned_images['postgres'], 'POSTGRES_CONTAINER_IMAGE_MISMATCH')
        shell = 'export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec psql -X -w -qAt -v ON_ERROR_STOP=1 -h postgres -p 5432 -U zzsh_bootstrap -d "$1"'
        with tempfile.TemporaryFile() as file:
            body = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + sql + '\nROLLBACK;\n\\echo ZZSH_READ_ONLY_ACK\n') if readonly else sql
            file.write(body.encode('utf-8'))
            file.seek(0)
            output = self.call('exec', '-T', 'postgres', 'sh', '-ceu', shell, 'sh', database, stdin=file).decode().strip()
        if readonly:
            rows = output.splitlines()
            require(rows and rows[-1] == 'ZZSH_READ_ONLY_ACK', 'READ_ONLY_ROLLBACK_UNCONFIRMED')
            return '\n'.join(rows[:-1])
        return output


def validate_compose(config):
    s = config.get('services', {})
    require(all(name in s for name in ('api', 'web', 'proxy', 'postgres', 'redis', 'db-setup', 'migration')), 'COMPOSE_SERVICES_INVALID')
    env = s['api'].get('environment', {})
    expected = {'APP_PROFILE': 'ecs-test', 'DB_TARGET': 'ecs-test', 'DB_NAME': DATABASE, 'DB_USER': RUNTIME,
                'DB_TLS_MODE': 'verify-full', 'REDIS_TLS_MODE': 'verify-full', 'USER_SMS_PROVIDER': 'aliyun',
                'USER_REAL_NAME_PROVIDER': 'aliyun-id2meta', 'MEDIA_STORAGE': 'oss', 'ORDER_IM_EVENTS_ENABLED': 'true'}
    expected.update({key: 'false' for key in ('JOINPAY_COLLECTION_ENABLED', 'JOINPAY_REFUND_ENABLED', 'JOINPAY_PAYOUT_ENABLED', 'JOINPAY_ACCOUNTS_ENABLED')})
    require(all(env.get(k) == v for k, v in expected.items()), 'COMPOSE_RUNTIME_GATES_INVALID')
    require(env.get('YUNXIN_APP_KEY') and not str(env['YUNXIN_APP_KEY']).startswith('REPLACE_')
            and env.get('ORDER_IM_EVENTS_APP_KEY') == env.get('YUNXIN_APP_KEY'), 'YUNXIN_APP_BINDING_INVALID')
    require(all(not s[name].get('ports') for name in ('api', 'web', 'postgres', 'redis', 'db-setup', 'migration')), 'COMPOSE_PRIVATE_PORTS_INVALID')
    require(sorted(int(p['published']) for p in s['proxy'].get('ports', [])) == [80, 443], 'COMPOSE_PUBLIC_PORTS_INVALID')
    require(config.get('networks', {}).get('data_private', {}).get('internal') is True, 'COMPOSE_DATA_NETWORK_INVALID')
    volumes = [v for v in s['api'].get('volumes', []) if v.get('target') == '/workspace/apps/api/.secrets' and v.get('read_only') is True]
    require(len(volumes) == 1 and volumes[0].get('type') == 'bind', 'API_SECRETS_MOUNT_INVALID')
    return env, Path(volumes[0]['source'])


def secret_path(root, reference):
    require(isinstance(reference, str) and reference.startswith('.secrets/') and '..' not in Path(reference).parts, 'SECRET_REFERENCE_INVALID')
    return private_file(root / reference.removeprefix('.secrets/'), base=root)


def verify_source_keys(env, secret_root, manifest):
    root = Path(secret_root).resolve(strict=True)
    source_values = {}
    for key, expected in manifest['keys'].items():
        path = secret_path(root, env.get(key))
        require(digest_file(path) == expected, 'SOURCE_KEY_FINGERPRINT_MISMATCH')
        value = path.read_text(encoding='utf-8').strip()
        if key.startswith('WITHDRAWAL_BANK_KEY_'):
            require(re.fullmatch(r'[A-Za-z0-9_-]{43}', value), 'BANK_KEY_FORMAT_INVALID')
            try:
                decoded = base64.urlsafe_b64decode(value + '=')
            except (ValueError, TypeError) as error:
                raise Refused('BANK_KEY_FORMAT_INVALID') from error
            require(len(decoded) == 32 and base64.urlsafe_b64encode(decoded).decode().rstrip('=') == value, 'BANK_KEY_FORMAT_INVALID')
        else:
            require(len(value) >= 32, 'SOURCE_KEY_FORMAT_INVALID')
            source_values[key] = value
    runtime_values = {}
    for key in ('ADMIN_ALTCHA_HMAC_KEY_FILE', 'USER_AUTH_THROTTLE_HMAC_KEY_FILE'):
        value = secret_path(root, env.get(key)).read_text(encoding='utf-8').strip()
        require(len(value) >= 32, 'RUNTIME_KEY_FORMAT_INVALID')
        runtime_values[key] = value
    for name in ('ORDER_CONFIRMATION_KEY_ID', 'LISTING_CURSOR_KEY_ID'):
        value = env.get(name)
        require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value) and not value.startswith('REPLACE_'),
                'SIGNING_KEY_ID_INVALID')
    user = source_values['AUTH_USER_SECRET_FILE']
    admin = source_values['AUTH_ADMIN_SECRET_FILE']
    confirmation = source_values['ORDER_CONFIRMATION_SECRET_FILE']
    cursor = source_values['LISTING_CURSOR_SECRET_FILE']
    identity = source_values['USER_IDENTITY_SUBJECT_HMAC_KEY_FILE']
    throttle = runtime_values['USER_AUTH_THROTTLE_HMAC_KEY_FILE']
    require(user != admin and confirmation not in (user, admin) and cursor not in (user, admin, confirmation)
            and throttle not in (user, admin) and identity not in (user, admin, throttle), 'RUNTIME_KEYS_NOT_INDEPENDENT')
    versions = manifest['bankVersions']
    if versions:
        require(env.get('WITHDRAWAL_BANK_BINDING_ENABLED') == 'true', 'BANK_KEYRING_REQUIRED')
        config = read_json(secret_path(root, env.get('WITHDRAWAL_BANK_BINDING_CONFIG_FILE')))
        require(config.get('database') == DATABASE and config.get('runtimeUser') == RUNTIME and config.get('writeEnabled') is True,
                'BANK_KEYRING_TARGET_MISMATCH')
        mapping = config.get('keyVariables')
        require(isinstance(mapping, dict) and set(mapping) == set(versions) and config.get('currentKeyVersion') in mapping,
                'BANK_KEYRING_VERSIONS_MISMATCH')
        for variable in mapping.values():
            require(isinstance(variable, str) and re.fullmatch(r'WITHDRAWAL_BANK_KEY_[A-Z0-9_]+', variable), 'BANK_KEY_REFERENCE_INVALID')
            require(variable + '_FILE' in manifest['keys'], 'SOURCE_BANK_KEY_FINGERPRINT_MISSING')
    provider_files = ('YUNXIN_APP_SECRET_FILE', 'ORDER_IM_EVENTS_APP_SECRET_FILE', 'USER_SMS_ACCESS_KEY_ID_FILE',
                      'USER_SMS_ACCESS_KEY_SECRET_FILE', 'USER_REAL_NAME_ACCESS_KEY_ID_FILE', 'USER_REAL_NAME_ACCESS_KEY_SECRET_FILE')
    for name in provider_files:
        require(secret_path(root, env.get(name)).stat().st_size > 0, 'PROVIDER_SECRET_FILE_MISSING')
    require(digest_file(secret_path(root, env['YUNXIN_APP_SECRET_FILE'])) == digest_file(secret_path(root, env['ORDER_IM_EVENTS_APP_SECRET_FILE'])),
            'YUNXIN_EVENT_SECRET_MISMATCH')
    for name in ('USER_SMS_SIGN_NAME','USER_SMS_TEMPLATE_CODE','ALIBABA_CLOUD_ACCESS_KEY_ID','ALIBABA_CLOUD_ACCESS_KEY_SECRET',
                 'OSS_BUCKET','OSS_REGION','OSS_ENDPOINT','OSS_OBJECT_PREFIX','USER_REAL_NAME_DAILY_LIMIT','USER_REAL_NAME_MIN_INTERVAL_SECONDS'):
        require(isinstance(env.get(name), str) and bool(env[name].strip()) and not env[name].startswith('REPLACE_'), 'PROVIDER_CONFIGURATION_MISSING')


def inspect_target(compose, *, allow_application=False):
    # A stopped database is not evidence that an existing application is stopped.
    if not allow_application:
        require(all(not compose.running(name) for name in ('api', 'web', 'proxy')), 'APPLICATION_ALREADY_RUNNING')
    if not compose.running('postgres'):
        return {'state': 'POSTGRES_NOT_RUNNING', **compose.stopped_postgres_resources()}
    sql = """SELECT json_build_object('version',current_setting('server_version_num'),'actor',current_user,'readOnly',current_setting('transaction_read_only'),
      'target',(SELECT json_build_object('oid',d.oid::text,'owner',pg_get_userbyid(d.datdba),'marker',shobj_description(d.oid,'pg_database'),
        'connections',(SELECT count(*) FROM pg_stat_activity a WHERE a.datid=d.oid),
        'publicPrivileges',EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0 AND a.privilege_type IN ('CONNECT','CREATE','TEMPORARY')),
        'migrationConnect',CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_ecs_migration') THEN has_database_privilege('zzsh_ecs_migration',d.oid,'CONNECT') ELSE NULL END,
        'migrationCreate',CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_ecs_migration') THEN has_database_privilege('zzsh_ecs_migration',d.oid,'CREATE') ELSE NULL END,
        'runtimeConnect',CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_ecs_runtime') THEN has_database_privilege('zzsh_ecs_runtime',d.oid,'CONNECT') ELSE NULL END,
        'runtimeCreate',CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_ecs_runtime') THEN has_database_privilege('zzsh_ecs_runtime',d.oid,'CREATE') ELSE NULL END)
        FROM pg_database d WHERE d.datname='zzsh_ecs_test'),
      'otherDatabases',(SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','zzsh_ecs_test')),
      'roles',(SELECT COALESCE(json_agg(json_build_object('name',rolname,'oid',oid::text,'login',rolcanlogin,'super',rolsuper,
        'createdb',rolcreatedb,'createrole',rolcreaterole,'replicate',rolreplication,'bypass',rolbypassrls,
        'member',EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=pg_roles.oid)) ORDER BY rolname),'[]'::json)
        FROM pg_roles WHERE rolname IN ('zzsh_ecs_owner','zzsh_ecs_migration','zzsh_ecs_runtime')));"""
    row = json.loads(compose.sql('postgres', sql))
    require(row.get('actor') == 'zzsh_bootstrap' and row.get('readOnly') == 'on' and str(row.get('version', '')).startswith('16'), 'POSTGRES_SERVER_IDENTITY_INVALID')
    require(row.get('otherDatabases') == 0, 'POSTGRES_HAS_OTHER_DATABASES')
    return row


def require_no_stopped_postgres_resources(observed):
    require(observed.get('state') != 'POSTGRES_NOT_RUNNING' or
            observed.get('postgresContainerExists') is False and observed.get('postgresDataVolumeExists') is False,
            'STOPPED_POSTGRES_RESOURCE_REQUIRES_REVIEW')


def require_fresh_postgres(observed):
    if observed.get('state') != 'POSTGRES_NOT_RUNNING':
        require(not target_roles_complete(observed), 'TARGET_ALREADY_EXISTS')
        raise Refused('RUNNING_POSTGRES_RESOURCE_REQUIRES_REVIEW')
    require_no_stopped_postgres_resources(observed)


def target_roles_complete(observed):
    target, roles = observed.get('target'), observed.get('roles', [])
    if target is None and not roles:
        return False
    require(target and target['owner'] == OWNER and target['marker'] == MARKER and len(roles) == 3
            and target['publicPrivileges'] is False and target['migrationConnect'] is True and target['migrationCreate'] is True
            and target['runtimeConnect'] is True and target['runtimeCreate'] is False, 'TARGET_PARTIAL_OR_FOREIGN')
    by_name = {row['name']: row for row in roles}
    require(set(by_name) == {OWNER, MIGRATION, RUNTIME}, 'TARGET_ROLE_SET_MISMATCH')
    for name, role in by_name.items():
        require(role['login'] == (name != OWNER) and not any(role[k] for k in ('super','createdb','createrole','replicate','bypass','member')), 'TARGET_ROLE_PRIVILEGES_INVALID')
    return True


def empty_database(compose):
    sql = """SELECT json_build_object('schemas',(SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'),
      'relations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg_%'),
      'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg_%'),
      'extensions',(SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql'));"""
    value = json.loads(compose.sql(DATABASE, sql))
    return all(value[k] == 0 for k in ('schemas','relations','functions','extensions'))


def readback(compose):
    counts = ','.join("'%s',(SELECT count(*) FROM %s)" % (name, table) for name, table in TABLES.items())
    sql = "SELECT json_build_object('journal',(SELECT json_agg(hash ORDER BY id) FROM zzsh_business_meta.migrations),'tables',json_build_object(" + counts + "),'ledgerDebitCents',(SELECT COALESCE(sum(debit_cents),0)::text FROM zzsh_order.settlement_ledger_entry),'ledgerCreditCents',(SELECT COALESCE(sum(credit_cents),0)::text FROM zzsh_order.settlement_ledger_entry),'bankVersions',(SELECT COALESCE(json_agg(v ORDER BY v),'[]'::json) FROM (SELECT DISTINCT sealed_details::jsonb->>'keyVersion' AS v FROM zzsh_order.withdrawal_bank_binding) x));"
    return json.loads(compose.sql(DATABASE, sql))


def readback_matches(actual, manifest):
    return actual.get('journal') == manifest['source']['journalHashes'] and actual.get('tables') == manifest['expected']['tables'] \
        and actual.get('ledgerDebitCents') == manifest['expected']['ledgerDebitCents'] and actual.get('ledgerCreditCents') == manifest['expected']['ledgerCreditCents'] \
        and isinstance(actual.get('bankVersions'), list) and all(isinstance(v, str) and v in manifest['bankVersions'] for v in actual['bankVersions'])


def image_id(image):
    value = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]).decode().strip()
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', value), 'IMAGE_ID_INVALID')
    return value


def daemon_id_hash():
    value = command(['docker', 'info', '--format', '{{.ID}}']).strip()
    require(bool(value), 'DOCKER_DAEMON_ID_UNAVAILABLE')
    return hashlib.sha256(value).hexdigest()


def dump_source_major(listing):
    match = re.search(r'^;[ \t]*Dumped from database version:[ \t]*(\d+)(?:[.\s]|$)', listing, re.MULTILINE)
    require(match is not None, 'DUMP_POSTGRES_VERSION_MISMATCH')
    return int(match.group(1))


def verify_dump(dump, manifest, postgres_image):
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '-i', '--entrypoint', 'pg_restore', postgres_image]
    with immutable_approved_dump(dump, manifest['dump']['sha256'], manifest['dump']['bytes']) as stream:
        listing = command([*args, '--list'], stdin=stream).decode('utf-8', errors='strict')
        require(dump_source_major(listing) == manifest['source']['postgresMajor'], 'DUMP_POSTGRES_VERSION_MISMATCH')
        stream.seek(0)
        command([*args, '--no-owner', '--no-acl', '--file=/dev/null'], stdin=stream, capture=False, timeout=43200)


MIGRATION_DIGEST_JS = r"""const fs=require('fs'),p=require('path'),c=require('crypto');const root='/workspace/apps/api/migrations',files=[];function walk(d){for(const n of fs.readdirSync(d).sort()){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('LINK');if(s.isDirectory())walk(f);else if(s.isFile())files.push(f);else throw Error('TYPE')}}walk(root);const h=c.createHash('sha256');for(const f of files)h.update(p.relative(root,f).split(p.sep).join('/')+'\0'+c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')+'\n');process.stdout.write(h.digest('hex'))"""


def migration_tree_hash(compose):
    image = compose.pinned_images['api'] if compose.pinned_images is not None else compose.config()['services']['migration']['image']
    value = command(['docker','run','--rm','--network','none','--read-only','--entrypoint','node',image,'-e',MIGRATION_DIGEST_JS]).decode().strip()
    require(HEX.fullmatch(value), 'MIGRATION_TREE_HASH_INVALID')
    return value


def compose_images(config):
    services = config['services']
    require(services['api'].get('image') == services['migration'].get('image'), 'MIGRATION_IMAGE_MISMATCH')
    require(services['postgres'].get('image') == services['db-setup'].get('image'), 'DB_SETUP_IMAGE_MISMATCH')
    return {name: image_id(services[name]['image']) for name in ('api','web','proxy','postgres','redis')}


def plan_inputs(manifest_path, manifest_sha, env_path, compose_file, private_root, *, allow_existing=False, allow_application=False, expected_images=None):
    root = private_dir(private_root)
    manifest_path = private_file(manifest_path, base=root)
    env_path = private_file(env_path, base=root)
    manifest = parse_manifest(read_verified_json(manifest_path, manifest_sha, 'MANIFEST_DIGEST_MISMATCH'))
    dump = private_file(manifest['dump']['path'], base=root)
    require(Path(compose_file).resolve(strict=True) == (HERE / 'compose.yaml').resolve(strict=True), 'COMPOSE_FILE_INVALID')
    compose = Compose(manifest['project'], compose_file, env_path)
    config = compose.config()
    api_env, secret_root = validate_compose(config)
    verify_source_keys(api_env, secret_root, manifest)
    images = compose_images(config)
    if expected_images is not None:
        require(images == expected_images, 'APPROVED_PLAN_INPUT_CHANGED')
    compose.pin_images(images)
    verify_dump(dump, manifest, images['postgres'])
    require(migration_tree_hash(compose) == manifest['source']['migrationTreeSha256'], 'MIGRATION_TREE_MISMATCH')
    target = inspect_target(compose, allow_application=allow_application)
    if not allow_existing:
        require_fresh_postgres(target)
    return manifest, compose, dump, {
        'schema': 'zzsh.ecs-test-dump-plan.v1', 'createdAt': utc_now(), 'manifestSha256': manifest_sha,
        'composeFileSha256': digest_file(compose_file), 'composeEnvSha256': digest_file(env_path),
        'resolvedComposeSha256': hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        'apiEnvironmentSha256': hashlib.sha256(json.dumps(api_env, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        'dockerDaemonSha256': daemon_id_hash(), 'images': images, 'targetAtPlan': target,
        'dumpSha256': manifest['dump']['sha256'], 'datasetSha256': manifest['source']['datasetSha256'],
        'keyFingerprintsVerified': True, 'targetEmptyVerified': False, 'dumpDecoded': True,
        'targetDatabase': DATABASE, 'targetMarker': MARKER, 'startServices': manifest['startServices'],
        'manifestPath': str(manifest_path), 'envPath': str(env_path), 'composeFile': str(Path(compose_file).resolve()), 'privateRoot': str(root),
    }


def assert_plan_unchanged(original, fresh):
    keys = ('manifestSha256','composeFileSha256','composeEnvSha256','resolvedComposeSha256','apiEnvironmentSha256','dockerDaemonSha256','images',
            'dumpSha256','datasetSha256','targetDatabase','targetMarker','startServices','manifestPath','envPath','composeFile','privateRoot')
    require(all(original.get(key) == fresh.get(key) for key in keys), 'APPROVED_PLAN_INPUT_CHANGED')


def approval_valid(approval, plan_sha, manifest_sha):
    require(set(approval) == {'schema','decision','planSha256','manifestSha256','notBefore','expiresAt'}
            and approval.get('schema') == 'zzsh.ecs-test-dump-approval.v1' and approval.get('decision') == 'APPROVED'
            and approval.get('planSha256') == plan_sha and approval.get('manifestSha256') == manifest_sha,
            'APPROVAL_BINDING_INVALID')
    now = dt.datetime.now(dt.timezone.utc)
    start, end = parse_utc(approval['notBefore']), parse_utc(approval['expiresAt'])
    require(start <= now < end and end - start <= dt.timedelta(days=1), 'APPROVAL_WINDOW_INACTIVE')


@contextlib.contextmanager
def target_lock(root):
    fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        metadata = os.fstat(fd)
        require(metadata.st_uid == os.geteuid() and (metadata.st_mode & 0o077) == 0, 'RESTORE_LOCK_PERMISSIONS_INVALID')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused('RESTORE_ALREADY_RUNNING') from error
        yield
    finally:
        os.close(fd)


def exact_target(compose, state, *, allow_application=False):
    observed = inspect_target(compose, allow_application=allow_application)
    require(observed.get('state') != 'POSTGRES_NOT_RUNNING' and target_roles_complete(observed), 'TARGET_NOT_READY')
    target = observed['target']
    require(state.get('targetOid') and str(target['oid']) == str(state['targetOid']) and target['connections'] == 0, 'TARGET_OID_OR_CONNECTIONS_CHANGED')
    require({row['name']: str(row['oid']) for row in observed['roles']} == state.get('roleOids'), 'TARGET_ROLE_OIDS_CHANGED')
    return observed


def admission_status(compose, state):
    oid = str(state['targetOid'])
    require(re.fullmatch(r'[1-9][0-9]{0,9}', oid), 'TARGET_OID_INVALID')
    sql = """SELECT json_build_object('row',(SELECT json_build_object('database',database_name,'runtime',runtime_role,'marker',resource_marker)
      FROM zzsh_order.native_origin_resource_admission WHERE resource_oid=%s::oid),
      'owner',pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='zzsh_order.native_origin_resource_admission'::regclass)),
      'runtimeCanWrite',has_table_privilege('zzsh_ecs_runtime','zzsh_order.native_origin_resource_admission','INSERT,UPDATE,DELETE,TRUNCATE'),
      'runtimeCanWriteColumns',has_any_column_privilege('zzsh_ecs_runtime','zzsh_order.native_origin_resource_admission','INSERT,UPDATE'),
      'publicCanWrite',EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE c.oid='zzsh_order.native_origin_resource_admission'::regclass AND a.grantee=0 AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')),
      'publicCanWriteColumns',EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) p
        WHERE a.attrelid='zzsh_order.native_origin_resource_admission'::regclass AND a.attnum>0 AND NOT a.attisdropped
          AND p.grantee=0 AND p.privilege_type IN ('INSERT','UPDATE')),
      'guardsActive',(SELECT count(*)=2 FROM pg_trigger t WHERE t.tgrelid='zzsh_order.native_origin_resource_admission'::regclass
        AND t.tgname IN ('native_origin_resource_admission_immutable','native_origin_resource_admission_no_truncate')
        AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgfoid='zzsh_order.finance_immutable()'::regprocedure));""" % oid
    data = json.loads(compose.sql(DATABASE, sql))
    require(data.get('owner') == MIGRATION and data.get('runtimeCanWrite') is False and data.get('runtimeCanWriteColumns') is False
            and data.get('publicCanWrite') is False and data.get('publicCanWriteColumns') is False
            and data.get('guardsActive') is True, 'NATIVE_ADMISSION_ACL_OR_GUARD_INVALID')
    row = data.get('row')
    if row is None:
        return 'ABSENT'
    require(row == {'database': DATABASE, 'runtime': RUNTIME, 'marker': MARKER}, 'NATIVE_ADMISSION_CONFLICT')
    return 'EXACT'


def create_admission(compose, state):
    oid = str(state['targetOid'])
    require(re.fullmatch(r'[1-9][0-9]{0,9}', oid), 'TARGET_OID_INVALID')
    role_oid = str(state['roleOids'][RUNTIME])
    require(re.fullmatch(r'[1-9][0-9]{0,9}', role_oid), 'TARGET_ROLE_OID_INVALID')
    sql = """SET ROLE zzsh_ecs_migration;
      BEGIN; SET LOCAL lock_timeout='3s';
      SELECT pg_advisory_xact_lock(hashtext('zzsh-ecs-native-origin'));
      DO $$ DECLARE actual_oid oid; actual_owner name; actual_marker text; actual_role oid; old_row record; BEGIN
        SELECT oid,pg_get_userbyid(datdba),shobj_description(oid,'pg_database') INTO actual_oid,actual_owner,actual_marker FROM pg_database WHERE datname=current_database();
        SELECT oid INTO actual_role FROM pg_roles WHERE rolname='zzsh_ecs_runtime';
        IF current_database()<>'zzsh_ecs_test' OR current_user<>'zzsh_ecs_migration' OR actual_oid<>%s::oid OR actual_owner<>'zzsh_ecs_owner'
          OR actual_marker<>'zzsh:ecs-test:v1' OR actual_role<>%s::oid
          OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='zzsh_order.native_origin_resource_admission'::regclass))<>current_user
        THEN RAISE EXCEPTION 'target identity changed'; END IF;
        SELECT * INTO old_row FROM zzsh_order.native_origin_resource_admission WHERE resource_oid=actual_oid;
        IF FOUND AND (old_row.database_name<>'zzsh_ecs_test' OR old_row.runtime_role<>'zzsh_ecs_runtime' OR old_row.resource_marker<>'zzsh:ecs-test:v1')
        THEN RAISE EXCEPTION 'existing admission conflicts'; END IF;
        INSERT INTO zzsh_order.native_origin_resource_admission(resource_oid,database_name,runtime_role,resource_marker)
          VALUES(actual_oid,'zzsh_ecs_test','zzsh_ecs_runtime','zzsh:ecs-test:v1') ON CONFLICT(resource_oid) DO NOTHING;
      END $$;
      COMMIT;
      \\echo ZZSH_ADMISSION_COMMIT_ACK
    """ % (oid, role_oid)
    require(compose.sql(DATABASE, sql, readonly=False).splitlines()[-1:] == ['ZZSH_ADMISSION_COMMIT_ACK'], 'NATIVE_ADMISSION_COMMIT_UNCONFIRMED')


def run_step(state, state_file, name, function, *, approval_check=None):
    old = state['phases'].get(name)
    if old and old.get('status') == 'ACK':
        return
    require(not old or old.get('status') == 'RETRYABLE_NOT_APPLIED', 'ORIGINAL_STAGE_REQUIRES_RECOVERY')
    phase = {'status':'INTENT', 'startedAt':utc_now()}
    state['phases'][name] = phase
    state['status'] = 'RUNNING'
    save_checkpoint(state_file, state)
    start = time.monotonic()
    if approval_check is not None:
        try:
            approval_check()
        except Refused:
            phase.update(status='RETRYABLE_NOT_APPLIED', finishedAt=utc_now(), elapsedMs=round((time.monotonic()-start)*1000))
            state['status'] = 'RECOVERED_RESUMABLE'
            save_checkpoint(state_file, state)
            raise
    try:
        result = function()
    except Exception:
        phase.update(status='UNKNOWN', finishedAt=utc_now(), elapsedMs=round((time.monotonic()-start)*1000))
        state['status'] = 'RECOVERY_REQUIRED'
        save_checkpoint(state_file, state)
        raise
    phase.update(status='ACK', finishedAt=utc_now(), elapsedMs=round((time.monotonic()-start)*1000))
    if result is not None:
        phase['evidence'] = result
    save_checkpoint(state_file, state)


def restore_dump(compose, dump, expected_sha, expected_bytes):
    shell = 'export PGPASSWORD="$(cat /run/secrets/bootstrap_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt; exec pg_restore -w --single-transaction --exit-on-error --no-owner --no-acl --role=zzsh_ecs_migration -h postgres -p 5432 -U zzsh_bootstrap -d zzsh_ecs_test'
    with immutable_approved_dump(dump, expected_sha, expected_bytes) as stream:
        compose.call('exec', '-T', 'postgres', 'sh', '-ceu', shell, stdin=stream, capture=False, timeout=43200)


def phase_order(manifest):
    return ['infra','dbSetup','restore','restoreReadback','migration','migrationReadback','nativeAdmission','admissionReadback'] + (['activate'] if manifest['startServices'] else [])


def apply_plan(plan, plan_sha, manifest, compose, dump, run_dir, *, approval_check, resume=False):
    require(manifest.get('startServices') is False, 'SOURCE_ACL_BASELINE_NOT_VERIFIED')
    state_file = Path(run_dir) / 'checkpoint.json'
    if resume:
        state = read_json(private_file(state_file, base=run_dir))
        require(state.get('planSha256') == plan_sha and state.get('status') == 'RECOVERED_RESUMABLE', 'RESUME_REQUIRES_ORIGINAL_RECOVERY')
    else:
        require(not state_file.exists(), 'CHECKPOINT_ALREADY_EXISTS')
        state = {'schema':'zzsh.ecs-test-dump-checkpoint.v1','planSha256':plan_sha,'manifestSha256':plan['manifestSha256'],
                 'status':'STARTED','startedAt':utc_now(),'targetOid':None,'roleOids':None,'phases':{}}
        write_new(state_file, state)
    def infra():
        require(all(not compose.running(name) for name in ('api', 'web', 'proxy')), 'APPLICATION_ALREADY_RUNNING')
        require_fresh_postgres(inspect_target(compose))
        compose.call('up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'redis', capture=False)
        current = inspect_target(compose)
        require(not target_roles_complete(current), 'TARGET_ALREADY_EXISTS')
        return {'postgresReady':True,'redisReady':True}
    def db_setup():
        current = inspect_target(compose)
        require(not target_roles_complete(current), 'TARGET_ALREADY_EXISTS')
        compose.call('--profile','tools','run','--rm','db-setup',capture=False)
        current = inspect_target(compose)
        require(target_roles_complete(current) and current['target']['connections'] == 0 and empty_database(compose), 'CREATED_TARGET_NOT_EMPTY')
        state['targetOid'] = str(current['target']['oid'])
        state['roleOids'] = {row['name']:str(row['oid']) for row in current['roles']}
        return {'oid':state['targetOid'],'empty':True}
    def restore():
        exact_target(compose, state)
        require(empty_database(compose), 'TARGET_NOT_EMPTY')
        restore_dump(compose, dump, manifest['dump']['sha256'], manifest['dump']['bytes'])
        return {'singleTransaction':True,'dumpSha256':manifest['dump']['sha256']}
    def check_data():
        exact_target(compose, state)
        actual = readback(compose)
        require(readback_matches(actual, manifest), 'SOURCE_READBACK_MISMATCH')
        return {'journalMatched':True,'tableCountsMatched':True,'ledgerSumsMatched':True,'bankVersionsCovered':True}
    def migrate():
        exact_target(compose, state)
        compose.call('--profile','tools','run','--rm','migration',capture=False,timeout=3600)
        return {'commandExit':'ACK'}
    def admission():
        exact_target(compose, state)
        before = admission_status(compose, state)
        if before == 'ABSENT':
            create_admission(compose, state)
        return {'previous':before}
    def check_admission():
        exact_target(compose, state)
        require(admission_status(compose, state) == 'EXACT', 'NATIVE_ADMISSION_NOT_CONFIRMED')
        return {'exact':True,'runtimeCannotWrite':True,'publicCannotWrite':True,'immutableGuardsActive':True}
    def activate():
        exact_target(compose, state)
        _, _, _, fresh = plan_inputs(plan['manifestPath'],plan['manifestSha256'],plan['envPath'],plan['composeFile'],plan['privateRoot'],
                                    allow_existing=True,expected_images=plan['images'])
        assert_plan_unchanged(plan, fresh)
        compose.call('up','-d','--wait','--wait-timeout','120','api','web','proxy',capture=False)
        require(all(compose.running(name) for name in ('api','web','proxy')), 'APPLICATION_START_UNCONFIRMED')
        return {'running':True,'externalHttpsAndProviders':'NOT_RUN'}
    actions = {'infra':infra,'dbSetup':db_setup,'restore':restore,'restoreReadback':check_data,'migration':migrate,
               'migrationReadback':check_data,'nativeAdmission':admission,'admissionReadback':check_admission,'activate':activate}
    for name in phase_order(manifest):
        run_step(state, state_file, name, actions[name], approval_check=approval_check if name in
                 ('infra','dbSetup','restore','migration','nativeAdmission','activate') else None)
    state.update(status='RESTORE_DATA_ONLY_ACL_UNVERIFIED',finishedAt=utc_now())
    save_checkpoint(state_file, state)
    return state


def inspect_run(plan, state, manifest, compose):
    require(state.get('schema') == 'zzsh.ecs-test-dump-checkpoint.v1' and state.get('manifestSha256') == plan['manifestSha256'], 'CHECKPOINT_BINDING_MISMATCH')
    observed = inspect_target(compose, allow_application=True)
    result = {'checkpointStatus':state.get('status'),'phases':state.get('phases',{}),'targetState':observed}
    if observed.get('target') and target_roles_complete(observed) and str(observed['target']['oid']) == str(state.get('targetOid')):
        if observed['target']['connections'] != 0:
            result['readback'] = 'NOT_RUN_ACTIVE_CONNECTIONS'
            return result
        result['empty'] = empty_database(compose)
        if not result['empty']:
            try:
                actual = readback(compose)
                result['approvedReadbackMatched'] = readback_matches(actual, manifest)
            except Refused:
                result['approvedReadbackMatched'] = False
    return result


def recover_run(plan, state, manifest, compose, state_file):
    require(state.get('planSha256') == digest_file(plan['_path']) and state.get('status') in ('RUNNING','RECOVERY_REQUIRED'), 'RECOVERY_REQUIRES_ORIGINAL_CHECKPOINT')
    pending = [name for name, phase in state.get('phases',{}).items() if phase.get('status') in ('INTENT','UNKNOWN')]
    require(len(pending) == 1, 'RECOVERY_PHASE_AMBIGUOUS')
    name = pending[0]
    observed = inspect_target(compose, allow_application=(name == 'activate'))
    if name in ('infra','dbSetup','restore','migration','nativeAdmission','activate'):
        assert_no_orphaned_jobs(compose, allow_postgres_absent=(name == 'infra'))
    phase = state['phases'][name]
    if name == 'infra':
        require_fresh_postgres(observed)
        phase['status'] = 'RETRYABLE_NOT_APPLIED'
    elif name == 'dbSetup':
        # Generic owner/marker and emptiness do not prove this run created that target.
        raise Refused('DB_SETUP_CREATION_PROOF_MISSING_MANUAL_REVIEW_REQUIRED')
    elif name in ('restoreReadback','migrationReadback','admissionReadback'):
        exact_target(compose, state)
        phase['status'] = 'RETRYABLE_NOT_APPLIED'
    elif name == 'restore':
        exact_target(compose, state)
        require(empty_database(compose), 'RESTORE_COMMIT_UNKNOWN_MANUAL_REVIEW_REQUIRED')
        phase['status'] = 'RETRYABLE_NOT_APPLIED'
    elif name == 'nativeAdmission':
        exact_target(compose, state)
        status = admission_status(compose, state)
        phase['status'] = 'ACK' if status == 'EXACT' else 'RETRYABLE_NOT_APPLIED'
        phase['evidence'] = {'recoveredByReadback':True,'state':status}
    else:
        raise Refused('RECOVERY_NEEDS_MANUAL_REVIEW')
    phase['recoveredAt'] = utc_now()
    state['status'] = 'RECOVERED_RESUMABLE'
    save_checkpoint(state_file, state)
    return state


def assert_no_orphaned_jobs(compose, *, allow_postgres_absent=False):
    ids = compose.call('ps','-q','postgres').decode().strip().splitlines()
    require(len(ids) == 1 or allow_postgres_absent and not ids, 'POSTGRES_CONTAINER_UNAVAILABLE')
    if ids:
        exec_ids = command(['docker','inspect','--format','{{json .ExecIDs}}',ids[0]]).decode().strip()
        require(exec_ids in ('null','[]'), 'POSTGRES_EXEC_STILL_RUNNING')
    oneoffs = command(['docker','ps','--filter','label=com.docker.compose.project='+compose.project,
                       '--filter','label=com.docker.compose.oneoff=True','--format','{{.ID}}']).strip()
    require(not oneoffs, 'COMPOSE_ONEOFF_STILL_RUNNING')


def load_plan(path, expected_sha):
    path = private_file(path)
    plan = read_verified_json(path, expected_sha, 'PLAN_DIGEST_MISMATCH')
    require(plan.get('schema') == 'zzsh.ecs-test-dump-plan.v1', 'PLAN_SCHEMA_INVALID')
    root = private_dir(plan.get('privateRoot', ''))
    private_file(path, base=root)
    return plan, root


def parser():
    p = argparse.ArgumentParser(description='Restore one approved test-server PostgreSQL dump; not a MySQL migration tool.')
    subs = p.add_subparsers(dest='action', required=True)
    plan = subs.add_parser('plan')
    for name in ('manifest','manifest-sha256','env-file','private-root','out'):
        plan.add_argument('--'+name, required=True)
    plan.add_argument('--compose-file', default=str(HERE/'compose.yaml'))
    for action in ('apply','inspect','recover'):
        item = subs.add_parser(action)
        item.add_argument('--plan', required=True); item.add_argument('--plan-sha256', required=True)
        item.add_argument('--run-dir', required=True)
        if action == 'apply':
            item.add_argument('--approval', required=True); item.add_argument('--approval-sha256', required=True)
            item.add_argument('--resume', action='store_true')
    return p


def main():
    args = parser().parse_args()
    if args.action == 'plan':
        manifest, compose, dump, plan = plan_inputs(args.manifest, args.manifest_sha256, args.env_file, args.compose_file, args.private_root)
        out = Path(args.out)
        require(out.is_absolute() and out.parent.resolve(strict=True) == private_dir(args.private_root) and not out.exists(), 'NEW_PLAN_FILE_REQUIRED')
        write_new(out, plan)
        print(json.dumps({'status':'PLAN_READY','path':str(out),'sha256':digest_file(out),'targetEmptyVerified':False,'targetState':plan['targetAtPlan'].get('state','POSTGRES_RUNNING')}))
        return
    plan, root = load_plan(args.plan, args.plan_sha256)
    requested = Path(args.run_dir)
    require(requested.is_absolute() and requested.parent.resolve(strict=True) == root
            and re.fullmatch(r'restore-[A-Za-z0-9][A-Za-z0-9_-]{0,63}', requested.name), 'RUN_DIRECTORY_OUTSIDE_PRIVATE_ROOT')
    if args.action != 'apply' or args.resume:
        run_dir = private_dir(requested)
    else:
        require(not requested.exists(), 'RUN_DIRECTORY_ALREADY_EXISTS')
        run_dir = requested
    if args.action == 'inspect':
        state_file = run_dir / 'checkpoint.json'
        state = read_json(private_file(state_file,base=run_dir))
        require(state.get('planSha256') == args.plan_sha256, 'CHECKPOINT_BINDING_MISMATCH')
        try:
            manifest, compose, dump, fresh = plan_inputs(plan['manifestPath'],plan['manifestSha256'],plan['envPath'],plan['composeFile'],root,
                allow_existing=True, allow_application=True, expected_images=plan['images'])
            assert_plan_unchanged(plan, fresh)
            result = inspect_run(plan,state,manifest,compose)
            print(json.dumps({'status':'INSPECTED','checkpointStatus':result['checkpointStatus'],'targetState':result['targetState'],
                              'empty':result.get('empty'),'approvedReadbackMatched':result.get('approvedReadbackMatched'),'readback':result.get('readback')}))
        except (Refused, OSError, ValueError, KeyError, TypeError):
            print(json.dumps({'status':'INSPECTED_INPUTS_OR_TARGET_UNAVAILABLE','checkpointStatus':state.get('status'),'phases':state.get('phases',{})}))
        return
    manifest, compose, dump, fresh = plan_inputs(plan['manifestPath'],plan['manifestSha256'],plan['envPath'],plan['composeFile'],root,
        allow_existing=True, allow_application=args.action == 'recover', expected_images=plan['images'])
    assert_plan_unchanged(plan, fresh)
    with target_lock(root):
        if args.action == 'apply':
            approval = private_file(args.approval, base=root)
            approval = read_verified_json(approval, args.approval_sha256, 'APPROVAL_DIGEST_MISMATCH')
            approval_valid(approval, args.plan_sha256, plan['manifestSha256'])
            if not args.resume:
                os.mkdir(run_dir, 0o700)
                sync_dir(root)
            state_file = run_dir / 'checkpoint.json'
            state = apply_plan(plan,args.plan_sha256,manifest,compose,dump,run_dir,resume=args.resume,
                               approval_check=lambda: approval_valid(approval,args.plan_sha256,plan['manifestSha256']))
            print(json.dumps({'status':state['status'],'checkpoint':str(state_file),'sha256':digest_file(state_file),'externalHttpsAndProviders':'NOT_RUN'}))
        else:
            state_file = run_dir / 'checkpoint.json'
            state = read_json(private_file(state_file,base=run_dir))
            require(state.get('planSha256') == args.plan_sha256, 'CHECKPOINT_BINDING_MISMATCH')
            plan['_path'] = str(private_file(args.plan,base=root))
            state = recover_run(plan,state,manifest,compose,state_file)
            print(json.dumps({'status':state['status'],'checkpoint':str(state_file),'sha256':digest_file(state_file)}))


if __name__ == '__main__':
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        code = str(error) if isinstance(error, Refused) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'RESTORE_COMMAND_FAILED'
        print(json.dumps({'status':'STOPPED','reason':code}), file=sys.stderr)
        sys.exit(1)
