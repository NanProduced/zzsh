import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigurationError, type AppConfig } from "../config/config";
import { verifyLocalDemoCloneProof, type DemoOrigins } from "./ecs-test-demo-resource";
import { createEcsTestDemoRuntime, createLocalDemoCloneRuntime } from "./ecs-test-demo-runtime";
import { loadWithdrawalBusinessPolicy } from "./withdrawal-business-policy";

function pinnedFile(env:NodeJS.ProcessEnv,fileKey:string,hashKey:string,workingDirectory:string):Uint8Array {
  const file=env[fileKey],expected=env[hashKey];
  if(typeof file!=='string'||!file.trim()||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw new ConfigurationError('DEMO_FINANCE_PINNED_FILE_REQUIRED');
  try {
    const path=resolve(workingDirectory,file);if(statSync(path).size>131072)throw Error();
    const bytes=readFileSync(path);if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error();return bytes;
  } catch { throw new ConfigurationError('DEMO_FINANCE_PINNED_FILE_INVALID'); }
}

/** Explicit operator-installed file and hash; never reads a payment source from a request. */
export function loadDemoFinanceRuntime(input:{config:AppConfig;origins:DemoOrigins;env?:NodeJS.ProcessEnv;workingDirectory?:string}) {
  const env=input.env??process.env,workingDirectory=input.workingDirectory??process.cwd();
  const local=env.LOCAL_DEMO_CLONE_FINANCE_ENABLED??'false',ecs=env.ECS_TEST_DEMO_FINANCE_ENABLED??'false';
  if(!['true','false'].includes(local)||!['true','false'].includes(ecs)||local==='true'&&ecs==='true')throw new ConfigurationError('DEMO_FINANCE_FLAGS_INVALID');
  if(local==='false'&&ecs==='false')return undefined;
  const appId=input.config.yunxin.appKey;
  if(!input.config.yunxin.enabled||!appId)throw new ConfigurationError('DEMO_FINANCE_IM_APP_REQUIRED');
  const withdrawalPolicy=loadWithdrawalBusinessPolicy(env,workingDirectory);
  if(local==='true'){
    const bytes=pinnedFile(env,'LOCAL_DEMO_CLONE_RECEIPT_FILE','LOCAL_DEMO_CLONE_RECEIPT_SHA256',workingDirectory);
    const proof=verifyLocalDemoCloneProof(bytes,env.LOCAL_DEMO_CLONE_RECEIPT_SHA256!);
    return createLocalDemoCloneRuntime({config:input.config,origins:input.origins,env,proof,
      reference:env.LOCAL_DEMO_FINANCE_REFERENCE??'',administratorId:env.LOCAL_DEMO_FINANCE_ADMIN_ID??'',appId,withdrawalPolicy});
  }
  const bytes=pinnedFile(env,'ECS_TEST_DEMO_REGISTRATION_FILE','ECS_TEST_DEMO_REGISTRATION_SHA256',workingDirectory);
  let doc:Record<string,any>;try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ConfigurationError('DEMO_FINANCE_REGISTRATION_INVALID');}
  if(doc?.schema!=='zzsh.ecs-test-demo-runtime.v1'||Object.keys(doc).sort().join(',')!==['administratorId','reference','resource','restoreReceiptSha256','schema','sourceSnapshotSha256'].sort().join(','))
    throw new ConfigurationError('DEMO_FINANCE_REGISTRATION_INVALID');
  return createEcsTestDemoRuntime({config:input.config,origins:input.origins,env,reference:doc.reference,administratorId:doc.administratorId,
    sourceSnapshotSha256:doc.sourceSnapshotSha256,restoreReceiptSha256:doc.restoreReceiptSha256,resource:doc.resource,appId,withdrawalPolicy});
}
