import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSupportOrders} from '../src/lib/support-directory.ts';
async function readAll(request) {
 let result;
 for await (const page of readSupportOrders(request,new AbortController().signal)) result=page;
 assert.equal(result.complete,true);
 return result.items;
}
test('both roles and later pages participate; unpaid orders alone are not conversations',async()=>{
 const paths=[];
 const rows=await readAll(async path=>{paths.push(path);return path.includes('party=owner')?{items:[{id:'owned',fulfillmentAssignment:{state:'WAITING'}}],nextCursor:null}:path.includes('cursor=next')?{items:[{id:'rented',fulfillmentAssignment:{state:'ASSIGNED'}}],nextCursor:null}:{items:[{id:'unpaid'}],nextCursor:'next'};});
 assert.deepEqual(rows.map(x=>x.id),['rented','owned']);assert.equal(paths.length,3);assert.equal(rows[1].party,'owner');
});
test('partial failure and invalid pagination cannot prove an empty directory',async()=>{
 await assert.rejects(readAll(async path=>{if(path.includes('party=owner'))throw Error('403');return{items:[],nextCursor:null};}),/403/);
 await assert.rejects(readAll(async()=>({items:[],nextCursor:'same'})),/分页未完成/);
 await assert.rejects(readAll(async()=>({items:[]})),/格式无效/);
});

test('scan advances only on demand and abort stops later pages even if the request ignores cancellation',async()=>{
 const controller=new AbortController();let calls=0,release;
 const scan=readSupportOrders(async()=>{calls++;if(calls===2)await new Promise(resolve=>release=resolve);return {items:[],nextCursor:'page-'+calls};},controller.signal);
 assert.equal((await scan.next()).value.complete,false);assert.equal(calls,1);
 const pending=scan.next();assert.equal(calls,2);controller.abort();release();
 await assert.rejects(pending,{name:'AbortError'});await scan.next();assert.equal(calls,2);
});
