import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyHoldingDomain } from './local-target-holdings.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
test('skin inputs are bound to the consumed source before any target query', {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')},async t=>{
 const dir=mkdtempSync('E:/zzsh-local-state/restricted/holdings-source-synthetic-');
 const files=['accounts.jsonl','display.jsonl','dictionary.jsonl','types.jsonl','receipt.json'].map(name=>join(dir,name));
 t.after(()=>{for(const file of files)if(existsSync(file))unlinkSync(file);rmdirSync(dir)});
 const names=['影锋','AUG-气象感应','K416-命运','M4棱镜攻势','M7棱镜攻势','QBZ95-王牌之剑','SCAR-电玩','Vctor-冲锋枪-美杜莎','腾龙-气象感应'];
 const fields=['knife_skin','agent_skin','weapon_skin','gold_skin'];
 const rows=[[{id:'1'}],[{id:'1',knife_skin:'',agent_skin:'',weapon_skin:'',gold_skin:'',update_time:'1'}],
  names.flatMap((name,i)=>[0,1].map(j=>({id:String(i*2+j+1),type_id:'1',name,value:name,is_delete:'0'}))),[{id:'1',dict_type:'weapon_skin'}]];
 const bytes=rows.map(list=>Buffer.from(list.map(row=>JSON.stringify(row)).join('\n')+'\n'));
 bytes.forEach((value,index)=>writeFileSync(files[index],value));
 const entry=(index,extra={})=>({file:['accounts.jsonl','display.jsonl','dictionary.jsonl','types.jsonl'][index],sha256:sha(bytes[index]),rows:rows[index].length,...extra});
 const receipt={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,containerId:'a'.repeat(64),database:'synthetic',
  files:{accounts:entry(0),accountDisplay:entry(1,{fields}),skinDictionaryData:entry(2),skinDictionaryTypes:entry(3)}};
 const receiptBytes=Buffer.from(JSON.stringify(receipt));writeFileSync(files[4],receiptBytes);
 let queries=0;
 const ctx={manifest:{source:dir,sourceReceiptSha256:sha(receiptBytes)},state:{gameBindings:{delta:'synthetic'}},
  mod:name=>name==='legacy-load/legacy-skin-holdings'?{LEGACY_SKIN_FIELDS:fields}:{canonicalize:JSON.stringify},
  client:{query:async()=>{queries++;throw Error('SYNTHETIC_TARGET_QUERY')}}};
 const options={source:dir,sourceSha256:sha(receiptBytes),dictionary:dir,dictionarySha256:sha(receiptBytes)};
 await assert.rejects(applyHoldingDomain(ctx,options),/SYNTHETIC_TARGET_QUERY/);assert.equal(queries,1);
 for(let index=0;index<4;index++){
  queries=0;writeFileSync(files[index],Buffer.concat([bytes[index],Buffer.from('\n')]));
  await assert.rejects(applyHoldingDomain(ctx,options),/SOURCE_STREAM_CHANGED/);assert.equal(queries,0);
  writeFileSync(files[index],bytes[index]);
 }
});
