import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mysqlDumpTuples, verifyLegacyListedPolicyDump } from './verify-legacy-listed-policy-dump.mjs';

test('only complete SQL dump tuples are read, including escaped commas and quotes',()=>{
  assert.deepEqual([...mysqlDumpTuples("INSERT INTO `t` VALUES (1,'hello, world','it\\'s'),(2,NULL,'x');")],[['1','hello, world',"it's"],['2','NULL','x']]);
  for(const line of ['garbage',"INSERT INTO `t` VALUES (1,'unfinished);",'INSERT INTO `t` VALUES 1,2;'])assert.throws(()=>[...mysqlDumpTuples(line)]);
});

test('dump verification keeps Unicode separators inside an INSERT line',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'zzsh-policy-dump-'));t.after(()=>rmSync(dir,{recursive:true}));
  const game=Array(23).fill('0');game[0]='1';game[1]="'合成\u2028文本\u2029资料'";game[13]='6';game[20]='0';
  const content=`INSERT INTO \`la_sg_game\` VALUES (${game.join(',')});\r\nINSERT INTO \`la_system_config\` VALUES (99,'game','profitFirstDot',12,0,0);\r\n`;
  const file=join(dir,'source.sql');writeFileSync(file,content);
  const result=await verifyLegacyListedPolicyDump({dumpPath:file,dumpSha256:createHash('sha256').update(content).digest('hex'),cutoff:'2026-11-03T07:59:00Z'},'1');
  assert.equal(result.ordinaryProfitDot,'6');assert.equal(result.fastProfitFirstDot,'12');
});

test('dump policy is parsed from the exact bytes whose digest is verified',async()=>{
  const game=Array(23).fill('0');game[0]='1';game[13]='6';game[20]='0';
  const valid=Buffer.from(`INSERT INTO \`la_sg_game\` VALUES (${game.join(',')});\nINSERT INTO \`la_system_config\` VALUES (99,'game','profitFirstDot',12,0,0);\n`);
  const changed=Buffer.from(valid.toString().replace('profitFirstDot\',12','profitFirstDot\',15'));
  const source={dumpPath:'fixture-only',dumpSha256:createHash('sha256').update(valid).digest('hex'),cutoff:'2026-11-03T07:59:00Z'};
  let opens=0;
  const stream=()=>Readable.from([(++opens===1?valid:changed)]);
  const result=await verifyLegacyListedPolicyDump(source,'1',stream);
  assert.equal(opens,1,'a second, potentially changed file is never parsed');
  assert.equal(result.ordinaryProfitDot,'6');assert.equal(result.fastProfitFirstDot,'12');
  await assert.rejects(verifyLegacyListedPolicyDump(source,'1',()=>Readable.from([changed])),/SOURCE_DUMP_DIGEST_MISMATCH/);
});
