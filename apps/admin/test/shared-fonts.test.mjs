import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const shared=new URL('../../../assets/fonts/noto-sans-sc/',import.meta.url);
test('both apps distribute the complete canonical font license and Admin uses the shared source',()=>{
 const license=readFileSync(new URL('LICENSE-NotoSansSC.txt',shared));
 assert.match(license.toString(),/Copyright 2014-2021 Adobe/);
 for(const app of ['admin','web'])assert.deepEqual(readFileSync(new URL('../../'+app+'/public/fonts/noto-sans-sc/LICENSE-NotoSansSC.txt',import.meta.url)),license);
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',shared)));
 assert.equal(manifest.licenseSha256,createHash('sha256').update(license).digest('hex'));
 for(const f of manifest.files)assert.equal(createHash('sha256').update(readFileSync(new URL(f.name,shared))).digest('hex'),f.sha256);
 assert.equal(readdirSync(shared).filter(n=>n.endsWith('.woff2')).length,manifest.files.length);
 assert.match(readFileSync(new URL('../src/styles.css',import.meta.url),'utf8'),/@import "\.\.\/\.\.\/\.\.\/assets\/fonts\/noto-sans-sc\/fonts.css"/);
 assert.equal(existsSync(new URL('../src/fonts/noto-sans-sc',import.meta.url)),false);
});
