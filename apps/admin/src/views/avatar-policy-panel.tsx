import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { friendlyError } from "../api";
import { SettingsNotice } from "./self-settings/settings-shell";
import { clearPolicyCommand,isPolicyRejection,readAvatarPolicy,readPolicyCommand,recoverAvatarPolicy,savePolicyCommand,writeAvatarPolicy,type AvatarPolicy,type PolicyCommand } from "./avatar-policy-api";

type Props={actorId:string;sessionId:string;mayManage:boolean;refreshNonce:number};
export function AvatarPolicyPanel(props:Props){return <PolicyBody key={props.actorId+":"+props.sessionId+":"+props.mayManage} {...props}/>;}
function PolicyBody({actorId,sessionId,mayManage,refreshNonce}:Props){
  const [policy,setPolicy]=useState<AvatarPolicy|null>(null),[draft,setDraft]=useState(true),[canManage,setCanManage]=useState(false);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [pending,setPending]=useState<PolicyCommand|null>(null),[storageBlocked,setStorageBlocked]=useState(false);
  const alive=useRef(true),writing=useRef(false),generation=useRef(0),readAbort=useRef<AbortController|null>(null),writeAbort=useRef<AbortController|null>(null);
  const load=async()=>{
    readAbort.current?.abort();const controller=new AbortController();readAbort.current=controller;const run=++generation.current;setLoading(true);setError("");
    try{const result=await readAvatarPolicy(controller.signal);if(!alive.current||run!==generation.current)return;setPolicy(result.policy);setDraft(result.policy.requiresReview);setCanManage(result.canManage&&mayManage);}
    catch(failure){if(!controller.signal.aborted&&alive.current&&run===generation.current){setPolicy(null);setCanManage(false);setError(message(failure));}}
    finally{if(alive.current&&run===generation.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;try{setPending(readPolicyCommand(actorId));}catch{setStorageBlocked(true);setError("原策略操作记录不可读，暂不能重新提交。");}return()=>{alive.current=false;generation.current++;readAbort.current?.abort();writeAbort.current?.abort();};},[actorId,sessionId]);
  useEffect(()=>{void load();},[refreshNonce]);
  function release(command:PolicyCommand){clearPolicyCommand(command);setPending(null);}
  async function save(){
    if(writing.current||pending||storageBlocked||!canManage||!policy?.available||draft===policy.requiresReview)return;
    writing.current=true;setBusy(true);setError("");setNotice("");const controller=new AbortController();writeAbort.current=controller;let command:PolicyCommand|null=null;
    try{
      const original=readPolicyCommand(actorId);if(original){setPending(original);return;}
      command={actorId,sessionId,key:"avatar-policy-"+crypto.randomUUID(),requiresReview:draft,expectedRevision:policy.revision};savePolicyCommand(command);setPending(command);
      await writeAvatarPolicy(command,controller.signal);if(!alive.current)return;
      try{release(command);}catch{setNotice("保存已确认，本地记录待清理，请读取原策略结果。");return;}
      setNotice("头像审核策略已保存，仅影响之后完成提交的新头像。");await load();
    }catch(failure){if(!alive.current)return;if(command&&isPolicyRejection(failure)){try{release(command);}catch{setPending(command);}}
      if(isPolicyRejection(failure))await load();setError(message(failure));
    }finally{if(alive.current){writing.current=false;setBusy(false);}}
  }
  async function recover(){
    if(writing.current||!mayManage)return;writing.current=true;setBusy(true);setError("");const controller=new AbortController();writeAbort.current=controller;
    try{const command=readPolicyCommand(actorId);if(!command){setPending(null);return;}setPending(command);const result=await recoverAvatarPolicy(command,controller.signal);if(!alive.current)return;
      if(result.receipt==="UNRESOLVED"){setNotice("原策略操作仍未确认，请稍后再读取；不会重复提交。");return;}
      release(command);setNotice(result.responseStatus<300?"原策略保存已确认。":"原策略操作已被拒绝，请重新读取当前策略。");await load();
    }catch(failure){if(alive.current)setError(message(failure));}finally{if(alive.current){writing.current=false;setBusy(false);}}
  }
  return <section aria-labelledby="avatar-policy-title" className="space-y-3 border-b border-border pb-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-2xl space-y-1"><h2 id="avatar-policy-title" className="text-base font-semibold">上传审核设置</h2><p id="avatar-policy-description" className="text-sm leading-6 text-muted-foreground">控制用户和管理员自定义头像的生效方式；默认头像始终可直接使用。</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={busy||loading} onClick={()=>void load()}>重新读取策略</Button></div>
    {loading?<p role="status" className="text-sm text-muted-foreground">正在读取审核策略…</p>:null}
    {error?<SettingsNotice tone="danger" role="alert">{error}</SettingsNotice>:null}
    {notice?<SettingsNotice tone="success" role="status">{notice}</SettingsNotice>:null}
    {storageBlocked?<SettingsNotice tone="danger">原策略操作记录不可读，暂不能重新提交。</SettingsNotice>:null}
    {pending?<SettingsNotice tone="warning"><p>上次策略操作结果待确认，不会发起新请求。</p><Button type="button" size="sm" variant="secondary" disabled={busy||!mayManage} onClick={()=>void recover()}>读取原策略结果</Button></SettingsNotice>:null}
    {policy?<><div className="flex flex-wrap items-center justify-between gap-3"><label htmlFor="avatar-requires-review" className="space-y-1"><span className="block text-sm font-medium">自定义头像上传需审核</span><span className="block text-xs text-muted-foreground">当前：{policy.requiresReview?"人工审核通过后显示":"新头像完成提交后直接显示"}</span></label>
      <Switch id="avatar-requires-review" aria-describedby="avatar-policy-description avatar-policy-effect" checked={draft} onCheckedChange={setDraft} disabled={!canManage||!policy.available||busy||loading||Boolean(pending)||storageBlocked}/></div>
      <p id="avatar-policy-effect" className="max-w-2xl text-sm leading-6 text-muted-foreground">关闭后仅新提交的合格头像免人工审核；已有待审核头像仍需处理。重新开启不会撤下已生效头像，隔离与撤回功能仍可使用。</p>
      {!policy.available?<SettingsNotice tone="warning">审核设置尚未安装，继续按人工审核处理，暂不能修改。</SettingsNotice>:!canManage?<p className="text-xs text-muted-foreground">当前账号可查看策略，未获授权修改。</p>:<div className="flex items-center justify-end gap-3"><span className="text-xs text-muted-foreground">{draft!==policy.requiresReview?"有未保存的修改":"设置已同步"}</span><Button type="button" disabled={busy||loading||Boolean(pending)||storageBlocked||draft===policy.requiresReview} onClick={()=>void save()}>{busy?"处理中…":"保存审核设置"}</Button></div>}
    </>:null}
  </section>;
}
function message(error:unknown){return error instanceof Error&&!("status" in error)?error.message:friendlyError(error);}
