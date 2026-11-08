import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic config only: never print `docker compose config`, which may contain real env secrets.
const here = dirname(fileURLToPath(import.meta.url));
const example = readFileSync(join(here, 'api.env.example'), 'utf8');
assert.match(example, /^ORDER_HOLD_SECONDS=180\r?$/m);
assert.match(example, /^ORDER_SWEEP_ENABLED=true\r?$/m);
const temporary = mkdtempSync(join(tmpdir(), 'zzsh-compose-check-'));
const apiFile = join(temporary, 'api.env');
try {
  writeFileSync(apiFile, [
    'JOINPAY_COLLECTION_ENABLED=true', 'JOINPAY_REFUND_ENABLED=true',
    'JOINPAY_PAYOUT_ENABLED=true', 'JOINPAY_ACCOUNTS_ENABLED=true',
    'USER_SMS_PROVIDER=aliyun', 'USER_REAL_NAME_PROVIDER=aliyun-market-id2',
    'YUNXIN_APP_KEY=synthetic', 'MEDIA_STORAGE=oss',
  ].join('\n') + '\n', { mode: 0o600 });
  const env = { ...process.env, ZZSH_TEST_IMAGE_TAG: 'synthetic-check',
    ZZSH_TEST_SECRETS_DIR: resolve(temporary, 'missing-secrets'), ZZSH_TEST_API_ENV_FILE: apiFile,
    ZZSH_TEST_ACME_EMAIL: 'operator@example.invalid',
    ZZSH_TEST_USER_DOMAIN: 'test.example.invalid', ZZSH_TEST_ADMIN_DOMAIN: 'admin.example.invalid', ZZSH_TEST_API_DOMAIN: 'api.example.invalid',
    ZZSH_TEST_WEB_SUBNET: '172.30.240.0/28', ZZSH_TEST_PROXY_WEB_IP: '172.30.240.2', ZZSH_TEST_WEB_EDGE_IP: '172.30.240.3',
    ZZSH_TEST_APP_SUBNET: '172.30.241.0/28', ZZSH_TEST_PROXY_APP_IP: '172.30.241.2', ZZSH_TEST_WEB_APP_IP: '172.30.241.3', ZZSH_TEST_API_APP_IP: '172.30.241.4',
    ZZSH_TEST_DATA_SUBNET: '172.30.242.0/28', ZZSH_TEST_API_DATA_IP: '172.30.242.2', ZZSH_TEST_PG_IP: '172.30.242.3', ZZSH_TEST_REDIS_IP: '172.30.242.4' };
  const run = spawnSync('docker', ['compose', '-f', join(here, 'compose.yaml'), '--profile', 'tools', 'config', '--format', 'json'], { env, encoding: 'utf8' });
  if (run.error || run.status !== 0) throw new Error('Docker Compose configuration could not be validated');
  const config = JSON.parse(run.stdout), services = config.services;
  for (const key of ['JOINPAY_COLLECTION_ENABLED', 'JOINPAY_REFUND_ENABLED', 'JOINPAY_PAYOUT_ENABLED', 'JOINPAY_ACCOUNTS_ENABLED']) assert.equal(services.api.environment[key], 'false');
  assert.equal(services.api.environment.DB_TLS_MODE, 'verify-full');
  assert.equal(services.api.environment.REDIS_TLS_MODE, 'verify-full');
  assert.equal(services.api.environment.USER_SMS_PROVIDER, 'aliyun');
  assert.equal(services.api.environment.USER_REAL_NAME_PROVIDER, 'aliyun-market-id2');
  assert.equal(services.api.environment.YUNXIN_APP_KEY, 'synthetic');
  for (const name of ['api', 'web', 'postgres', 'redis', 'migration', 'db-setup']) assert.equal(services[name].ports, undefined, `${name} must not publish a host port`);
  assert.deepEqual(services.proxy.ports.map(port => Number(port.published)).sort((a, b) => a - b), [80, 443]);
  assert.equal(services.proxy.depends_on.api.condition, 'service_healthy');
  assert.equal(services.proxy.depends_on.web.condition, 'service_healthy');
  assert.ok(services.api.healthcheck?.test?.some(value => value.includes('/api/ready')));
  assert.ok(services.web.healthcheck?.test?.some(value => value.includes('/login')));
  assert.equal(config.networks.data_private.internal, true);
  assert.equal(services.migration.environment.YUNXIN_APP_KEY, undefined);
  console.log('Compose exposure, TLS, separate migration and forced payment-off gates: PASS');
} finally {
  unlinkSync(apiFile);
  rmdirSync(temporary);
}
