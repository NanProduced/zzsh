import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishMode, serviceLinks, publicContacts } from '../src/lib/service-navigation.ts';
test('rental discovery and two publishing modes have distinct destinations',()=>{
  assert.deepEqual(serviceLinks.map(s=>s.href),['/accounts','/publish','/publish?mode=fast']);
  assert.equal(publishMode('fast'),'fast');
  for(const v of [undefined,null,'other',['fast'],'FAST'])assert.equal(publishMode(v),'standard');
});
test('unconfigured contact panels cannot show invented identities or QR assets',()=>{
  for(const channel of Object.values(publicContacts)){assert.equal(channel.qrSrc,undefined);assert.equal(channel.handle,undefined);}
});
