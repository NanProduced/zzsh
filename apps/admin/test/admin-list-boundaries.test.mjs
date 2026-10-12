import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const {sortAdminEntries,parseListQuery}=await import(pathToFileURL('E:/zzsh/worktrees/admin-im-fulfillment-1/apps/admin/src/lib/admin-directory-list.ts').href);
const base={id:'a',username:'ZZ00001',name:'A',status:'ACTIVE',isBoss:false,createdAt:'2026-01-01',securitySummary:{passwordChangeRequired:false,twoFactorEnabled:true,bootstrapExpiresAt:null,firstActivatedAt:null},lastFullAuthenticatedAt:'2026-10-11T00:00:00.100Z'};
test('MR2 security with nullable two-factor facts stays last in both directions',()=>{const unknown={...base,id:'b',username:'ZZ00002',securitySummary:{...base.securitySummary,twoFactorEnabled:null}};for(const d of ['asc','desc'])assert.equal(sortAdminEntries([unknown,base],'security',d).at(-1).id,'b');});
test('MR2 missing full authentication time stays last within an equal known grade',()=>{const unknown={...base,id:'b',username:'ZZ00002',lastFullAuthenticatedAt:null};for(const d of ['asc','desc'])assert.equal(sortAdminEntries([unknown,base],'security',d).at(-1).id,'b');});
test('MR2 authentication sorting preserves subsecond chronology',()=>{const early={...base,id:'early',username:'ZZ00002'},late={...base,id:'late',username:'ZZ00001',lastFullAuthenticatedAt:'2026-10-11T00:00:00.900Z'};assert.deepEqual(sortAdminEntries([late,early],'security','asc').map(x=>x.id),['early','late']);});
test('MR2 absent or invalid sort ignores an orphan desc direction',()=>{for(const q of [{dir:'desc'},{sort:'obsolete',dir:'desc'}])assert.deepEqual(parseListQuery(q).sort,{key:'name',direction:'asc'});});
