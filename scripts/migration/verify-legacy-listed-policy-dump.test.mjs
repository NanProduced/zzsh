import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlDumpTuples } from './verify-legacy-listed-policy-dump.mjs';

test('only complete SQL dump tuples are read, including escaped commas and quotes',()=>{
  assert.deepEqual([...mysqlDumpTuples("INSERT INTO `t` VALUES (1,'hello, world','it\\'s'),(2,NULL,'x');")],[['1','hello, world',"it's"],['2','NULL','x']]);
  for(const line of ['garbage',"INSERT INTO `t` VALUES (1,'unfinished);",'INSERT INTO `t` VALUES 1,2;'])assert.throws(()=>[...mysqlDumpTuples(line)]);
});
