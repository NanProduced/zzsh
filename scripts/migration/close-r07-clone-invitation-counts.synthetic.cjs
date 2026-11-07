// Run only against the registered network=none synthetic clone fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),fixture=path.join(root,'apps/api/test/legacy-invitation-clone-counts-synthetic.cjs');
const stub=path.join(root,'tmp/r07-invite-loader-sharp-synthetic.cjs');
const injection=String.raw`
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),spawn=require('node:child_process').spawnSync;
 const base='/tmp/E:/zzsh-local-state/restricted/invitation-loader-synthetic',sum=b=>crypto.createHash('sha256').update(b).digest('hex');fs.mkdirSync(base,{recursive:true});
 const save=(name,value)=>{const p=path.join(base,name),b=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(p,b,{flag:'wx'});return {path:p,sha256:sum(b)}};
 const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
 const probe=new Client({host:'127.0.0.1',port:55434,user:'postgres',database:'zzsh_test_r07_delivery_20261108'});await probe.connect();
 const runtime=String((await probe.query("SELECT oid::int oid FROM pg_roles WHERE rolname='zzsh_regression_runtime'")).rows[0].oid);await probe.end();
 const invitation=Buffer.from(JSON.stringify({input:packet,key:prepared.key,bodyDigest:prepared.bodyDigest,relations:prepared.relations.length})+'\n');
 fs.writeFileSync(path.join(base,'invitation.jsonl'),invitation,{flag:'wx'});
 const manifest={population:{mode:'SELECTED_BUSINESS_SCOPE'},domains:{users:{source:2,ready:2,isolated:0}},sourceReceiptSha256:source.receiptSha256,
  invitationFacts:{subjects:2,codes:2,selectedSubjects:2,packets:1,selectedPackets:1,financialEffects:false,policy:null,relations:prepared.relations.length},
  files:{'invitation-facts':{file:'invitation.jsonl',rows:1,sha256:sum(invitation)}}};
 const manifestRef=save('manifest.json',manifest),target={instance:{host:'127.0.0.1',port:55434,systemIdentifier:'SYNTH_SYSTEM'},
  database:'zzsh_test_r07_delivery_20261108',oid:String(db.oid),nonce,marker:'zzsh:r07-delivery-clone:v1',owner:'zzsh',
  roles:{migration:{name:'zzsh_regression_migration',oid:String(role)},runtime:{name:'zzsh_regression_runtime',oid:runtime}},lockKey:'806007',protectedDataset:{manifestSha256:manifestRef.sha256}};
 const identities={systemIdentifier:target.instance.systemIdentifier,oid:target.oid,nonce,marker:target.marker,
  owner:{name:'zzsh',oid:String(db.owner)},migration:target.roles.migration,runtime:target.roles.runtime};
 save('resource.json',target);save('credentials.json',{migration:{name:target.roles.migration.name,oid:String(role),password:'synthetic-only'}});
 const actorRef=save('actor.json',{realm:'admin',id:actor.userId,sessionId:actor.sessionId,resourceOid:target.oid,nonce});
 const graphRef=save('graph.json',{status:'READ_ONLY_INVITATION_FULL_PROOF_PASSED',target:identities,sourceReceiptSha256:source.receiptSha256,
  invitationFileSha256:sum(invitation),packets:1,subjects:2,known:2,edges:prepared.relations.length,unknown:0,rollbackAck:true,connectionClosed:true});
 const verification={sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0};
 const restoreRef=save('restore.json',{schema:'zzsh.r07-demo-clone-restored.v1',status:'RESTORED_AND_VERIFIED',target:identities,
  source:{database:'zzsh_test_regression',systemIdentifier:'7704972584346443810',oid:'16390'},verification});
 const input=save('input.json',{schema:'zzsh.r07-clone-invitation-counts-input.v1',datasetManifest:manifestRef,graphReadback:graphRef,restoreReceipt:restoreRef,actor:actorRef,credentialsPath:path.join(base,'credentials.json')});
 function run(args,expected){const r=spawn(process.execPath,['/work/scripts/migration/close-r07-clone-invitation-counts.mjs',...args],{cwd:'/tmp',env:{...process.env,NODE_OPTIONS:'--require=/work/tmp/r07-invite-loader-sharp-synthetic.cjs'},encoding:'utf8',maxBuffer:1024*1024});
  if(r.status!==expected)throw Error('DRIVER_SYNTHETIC_FAILED '+r.status+' '+r.stdout+' '+r.stderr);return r;}
 const inArgs=['--input',input.path,'--input-sha',input.sha256],planOut=path.join(base,'plan');run(['--prepare',...inArgs,'--out',planOut],0);
 const planPath=path.join(planOut,'plan.json'),plan=read(planPath),planSha=sum(fs.readFileSync(planPath)),planArgs=['--plan',planPath,'--plan-sha',planSha];
 assert.equal(plan.status,'PREPARED_READ_ONLY');assert.deepEqual(plan.preimage,{total:2,known:1,unknown:1});
 const authority={schema:'zzsh.r07-clone-invitation-counts-authority.v1',status:'APPROVED',operation:'CLOSE_PROVEN_INVITATION_COUNTS',planSha256:planSha,target:plan.target,
  maxPackets:1,allowFinancialWrites:false,approvalRef:'synthetic-review',attempt:'synthetic-once',notBefore:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+1200000).toISOString()};
 const authorityRef=save('authority.json',authority),attempt={schema:'zzsh.r07-clone-invitation-counts-receipt.v1',status:'COMMIT_UNKNOWN',commitSent:true,commitAck:false,
  target:plan.target,planSha256:planSha,approvalRef:authority.approvalRef,attempt:authority.attempt,notBefore:authority.notBefore,expiresAt:authority.expiresAt,unlockAck:true,connectionsClosed:true};
 const uncertain=save('uncertain-no-commit.json',attempt),readArgs=['--readback',...inArgs,...planArgs,'--apply-receipt',uncertain.path,'--apply-sha',uncertain.sha256];
 const incomplete=path.join(base,'incomplete');run([...readArgs,'--out',incomplete],1);assert.equal(read(path.join(incomplete,'readback.json')).status,'COMMIT_UNKNOWN_UNRESOLVED');
 const executeOut=path.join(base,'apply'),executeArgs=['--execute',...inArgs,...planArgs,'--authority',authorityRef.path,'--authority-sha',authorityRef.sha256,'--out',executeOut];
 fs.appendFileSync(path.join(base,'invitation.jsonl'),' ');run(executeArgs,1);fs.writeFileSync(path.join(base,'invitation.jsonl'),invitation);
 run(executeArgs,0);const appliedPath=path.join(executeOut,'receipt.json'),applied=read(appliedPath),appliedSha=sum(fs.readFileSync(appliedPath));
 assert.equal(applied.status,'COMMIT_ACK_READBACK_REQUIRED');assert.equal(applied.commitSent,true);assert.equal(applied.commitAck,true);
 const ackOut=path.join(base,'ack-readback');run(['--readback',...inArgs,...planArgs,'--apply-receipt',appliedPath,'--apply-sha',appliedSha,'--out',ackOut],0);
 assert.equal(read(path.join(ackOut,'readback.json')).commitOutcome,'ACKNOWLEDGED');
 const uncertainApplied=save('uncertain-committed.json',{...applied,status:'COMMIT_UNKNOWN',commitAck:false}),resolvedOut=path.join(base,'resolved');
 run(['--readback',...inArgs,...planArgs,'--apply-receipt',uncertainApplied.path,'--apply-sha',uncertainApplied.sha256,'--out',resolvedOut],0);
 assert.equal(read(path.join(resolvedOut,'readback.json')).commitOutcome,'CONFIRMED_BY_ORIGINAL_RECEIPTS');
 const check=new Client({host:'127.0.0.1',port:55434,user:'zzsh_regression_migration',database:'zzsh_test_r07_delivery_20261108'});await check.connect();
 assert.equal((await check.query("SELECT count(*)::int n FROM zzsh_order.distribution_participant WHERE invitees_knowledge='KNOWN'")).rows[0].n,2);
 assert.equal((await check.query("SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed'")).rows[0].n,1);await check.end();
 console.log('SYNTHETIC_DRIVER_ACK_AND_UNKNOWN_RECOVERY_PASSED');return;
`;
let source=fs.readFileSync(fixture,'utf8');
const needle=" const c=new Client({host:'127.0.0.1',port:55434,user:'zzsh_regression_migration'";
assert.equal(source.split(needle).length,2,'synthetic fixture shape changed');
source=source.replace(needle,injection.replaceAll('SYNTH_SYSTEM',process.env.R08_INVITE_CLONE_SYNTH_SYSTEM??'')+needle)
 .replace("resolve(__dirname,'../../..')",'process.cwd()')
 .replace("'node:24.20.0-bookworm-slim','node','-e',code","'--workdir','/tmp','node:24.20.0-bookworm-slim','node','-e',code")
 .replace("console.log('SYNTHETIC_CLONE_INVITATION_COUNTS_PASSED');",'process.stdout.write(out.stdout);');
fs.writeFileSync(stub,"const M=require('node:module'),load=M._load;M._load=function(n,...a){if(n==='sharp')return()=>{throw Error('synthetic only')};return load.call(this,n,...a)};\n",{flag:'wx'});
try{const r=spawnSync(process.execPath,['-e',source],{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
 if(r.status!==0)throw Error('synthetic driver failed: '+r.stdout+' '+r.stderr);assert.match(r.stdout,/SYNTHETIC_DRIVER_ACK_AND_UNKNOWN_RECOVERY_PASSED/);console.log('SYNTHETIC_DRIVER_ACK_AND_UNKNOWN_RECOVERY_PASSED');
}finally{fs.unlinkSync(stub);}
