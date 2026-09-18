import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = process.env.NEXT_BUILD_DIR ?? '.next';
const build = (...parts) => resolve(web, buildDir, ...parts);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
test('production UI excludes fixture identities, controls and rejected claims', () => {
  const forbidden = ['activity-fixture-', '演示成交', 'repair-fixture-', '样例账号 A', '样例账号 B', '样例账号 C', '长内容样例', '展示状态', '资源样例', '独立开发展示', 'pricePerDay', '70%保底', '70% 保底', '收益保障', '认证中', 'WEB-UI-01', 'WEB-UI-02', 'WEB-UI-03'];
  const artifacts = [buildDir + '/server', buildDir + '/static', 'public'].flatMap(path => files(resolve(web, path))).filter(path => /\.(js|json|html|css|txt|md)$/.test(path));
  assert.ok(artifacts.length > 0);
  for (const file of artifacts) {
    const content = readFileSync(file, 'utf8');
    for (const marker of forbidden) assert.ok(!content.includes(marker), `${marker} leaked into ${file}`);
  }
  const html = readFileSync(build('server/app/index.html'), 'utf8');
  assert.ok(html.includes('account-skeleton'));
  assert.ok(!html.includes('account-card'));
  assert.ok(!html.includes('repair-fixture'));
});

test('temporary component experiments are outside the production route tree', () => {
  for (const sourcePath of ['src/app/poc', 'src/app/prototype', 'src/components/prototype']) {
    assert.equal(existsSync(resolve(web, sourcePath)), false, `${sourcePath} must not ship`);
  }
  const appPaths = JSON.parse(readFileSync(build('server/app-paths-manifest.json'), 'utf8'));
  for (const route of ['/poc/component-library/heroui', '/poc/component-library/shadcn', '/prototype/functional-shell']) {
    assert.equal(Object.keys(appPaths).some((entry) => entry.includes(route)), false, `${route} must not be in the production build`);
  }
});

test('game framework keeps tools scoped and migrated guide links resolve', () => {
  const html = readFileSync(build('server/app/index.html'), 'utf8');
  const help = readFileSync(build('server/app/help.html'), 'utf8');
  assert.ok(!html.includes('出发前，先了解'));
  for (const name of ['三角洲行动专区', '无畏契约专区', '英雄联盟专区']) assert.ok(html.includes(name));
  assert.equal((html.match(/COMING SOON/g) || []).length >= 2, true);
  for (const id of ['rental-guide', 'billing-guide', 'publish-guide', 'protection']) {
    assert.ok(help.includes(`id="${id}"`));
    assert.ok(html.includes(`/help#${id}`));
  }
  assert.ok(!html.includes('href="/#help"'));
  const delta = readFileSync(resolve(web, 'src/components/delta/delta-section.tsx'), 'utf8');
  assert.match(delta, /<GameIdentity game="delta">.*改枪码.*<\/GameIdentity>/);
});
test('web dependencies agree with root lockfile', () => {
  const manifest = JSON.parse(readFileSync(resolve(web, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(web, '../../package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, lock.packages['apps/web'].dependencies);
  assert.deepEqual(manifest.devDependencies, lock.packages['apps/web'].devDependencies);
});

test('retained static and dynamic homepage artwork resolves after cleanup', () => {
  const sources = files(resolve(web, 'src')).filter(path => /\.(tsx|css)$/.test(path));
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\/(?:art|brand|fonts)\/[\w/.-]+\.(?:png|jpg|webp|svg|woff2|ttf)/g)) {
      assert.ok(existsSync(resolve(web, 'public', match[0].slice(1))), `${file}: ${match[0]}`);
    }
  }
  const carousel = readFileSync(resolve(web, 'src/components/hero/hero-carousel.tsx'), 'utf8');
  for (const [, poster] of carousel.matchAll(/poster:"([\w-]+)"/g)) assert.ok(existsSync(resolve(web, `public/art/zhouzhou/poster-${poster}.webp`)));
  const benefits = readFileSync(resolve(web,'src/components/hero/service-benefits.tsx'),'utf8');
  for(const [,art] of benefits.matchAll(/art: "([a-z]+)"/g)) assert.ok(existsSync(resolve(web,'public/art/zhouzhou/cta-'+art+'.webp')));
  const games = readFileSync(resolve(web, 'src/components/delta/game-identity.tsx'), 'utf8');
  for (const [, art] of games.matchAll(/art: "([\w.-]+)"/g)) assert.ok(existsSync(resolve(web, `public/art/games/${art}`)));
});

test('production campaigns retain approved content and labeled demo statistics',()=>{
  const html=readFileSync(build('server/app/index.html'),'utf8');
  for(const content of ['未成年人','禁止消费','账号交易','即将上线','交易返现5%','2元即可提现']) assert.ok(html.includes(content),content);
  assert.ok(html.includes('class="platform-activity"'));
  assert.equal((html.match(/class="stat-unknown"/g)||[]).length,0);
  assert.ok(html.includes('演示数据'));
  for(const value of ['12,580','150,960','3,086'])assert.ok(html.includes(value),value);
  assert.ok(html.includes('暂无可展示的成交信息'));
  assert.ok(!html.includes('class="game-transition"'));
  assert.ok(!html.includes('class="brand-signature"'));
  assert.ok(!html.includes('>系统<'));
  assert.ok(html.includes('brand-backdrop'));
  assert.ok(!html.includes('class="brand-monument"'));
  assert.ok(!html.includes('class="hero-copy"'));
  assert.equal((html.match(/class="hero-poster-link"/g)||[]).length,3);
  for(const poster of ['delta','protection','accounts','market','invite']) assert.ok(html.includes(`poster-${poster}.webp`));
});
