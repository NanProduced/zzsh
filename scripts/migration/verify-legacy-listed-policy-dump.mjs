import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readLfLines } from './local-source-adapter.mjs';

/** Decode only INSERT tuples, without executing SQL or exposing unrelated dump rows. */
export function* mysqlDumpTuples(line) {
  const at=line.indexOf(' VALUES '); if(at<0)throw new Error('SOURCE_INSERT_INVALID');
  const text=line.slice(at+8);let i=0;
  while(i<text.length){
    while(i<text.length&&' ,;\r\n'.includes(text[i]))i++;
    if(i===text.length)break;if(text[i++]!=='(')throw new Error('SOURCE_INSERT_INVALID');
    let row=[],field='',quoted=false,escaped=false,finished=false;
    while(i<text.length){const c=text[i++];
      if(quoted){if(escaped){field+=c;escaped=false;}else if(c==='\\')escaped=true;else if(c==="'")quoted=false;else field+=c;}
      else if(c==="'")quoted=true;else if(c===','){row.push(field);field='';}else if(c===')'){row.push(field);yield row;finished=true;break;}else field+=c;
    }
    if(!finished||quoted||escaped)throw new Error('SOURCE_INSERT_INVALID');
  }
}

/** Independently verify the exact restored dump before extracting its two non-private policy values. */
export async function verifyLegacyListedPolicyDump(restoreRecord, legacyGameId, openDump = createReadStream) {
  if(!restoreRecord || typeof restoreRecord.dumpPath!=='string' || !/^[a-f0-9]{64}$/.test(restoreRecord.dumpSha256??'')
    || !/^[1-9]\d{0,23}$/.test(legacyGameId) || !Number.isFinite(Date.parse(restoreRecord.cutoff??'')))throw new Error('SOURCE_DUMP_BINDING_INVALID');
  const hash=createHash('sha256'),game=[],fast=[];
  const input=openDump(restoreRecord.dumpPath);
  for await(const line of readLfLines(input,chunk=>hash.update(chunk))){
    const kind=line.startsWith('INSERT INTO `la_sg_game` ')?'game':line.startsWith('INSERT INTO `la_system_config` ')?'config':null;
    if(!kind)continue;
    for(const row of mysqlDumpTuples(line)){
      if(kind==='game'){if(row.length!==23)throw new Error('SOURCE_GAME_SHAPE_CHANGED');if(row[0]===legacyGameId&&row[20]==='0')game.push(row[13]);}
      else{if(row.length!==6)throw new Error('SOURCE_CONFIG_SHAPE_CHANGED');if(row[1]==='game'&&row[2]==='profitFirstDot')fast.push(row[3]);}
    }
  }
  if(hash.digest('hex')!==restoreRecord.dumpSha256)throw new Error('SOURCE_DUMP_DIGEST_MISMATCH');
  if(game.length!==1||fast.length!==1||!game[0]||!fast[0])throw new Error('SOURCE_POLICY_ROWS_NOT_UNIQUE');
  return {schema:'zzsh.legacy-listing-dump-policy-check.v1',sourceDumpSha256:restoreRecord.dumpSha256,sourceCutoff:restoreRecord.cutoff,
    sourceCutoffMeaning:restoreRecord.cutoffMeaning,gameId:legacyGameId,ordinaryProfitDot:game[0],fastProfitFirstDot:fast[0],matchCounts:{game:1,fastConfig:1}};
}
