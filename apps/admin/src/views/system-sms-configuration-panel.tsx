import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { StatusMessage } from "../components/ui-elements";
import { InfoTip } from "../components/ui/tooltip";

const labels = { IDENTITY:"身份验证", REGISTER:"注册", LOGIN:"登录", BIND:"绑定手机", RENTAL_EXPIRY:"租期到期提醒", OWNER_ORDER_PAID:"号主出号提醒", CHANGE_MOBILE:"更换手机号", FORGOT_PASSWORD:"找回密码" } as const;
const baseScenes = ["IDENTITY","REGISTER","LOGIN","BIND","RENTAL_EXPIRY","OWNER_ORDER_PAID"] as const;
const additionalScenes = ["CHANGE_MOBILE","FORGOT_PASSWORD"] as const;
type Scene = keyof typeof labels;
type SmsScene = {scene:Scene;templateCode:string|null;source:"SCENE"|"RELATED"|"SHARED"|"NOT_CONFIGURED";trigger:"CONNECTED"|"NOT_CONNECTED"};
type SmsConfiguration = { provider:"aliyun"|"disabled";signName:string|null;providerVerification:"NOT_RUN";scenes:SmsScene[];additionalAvailable:boolean };

export function parseSmsConfiguration(value:unknown):SmsConfiguration {
  const data=value as Omit<SmsConfiguration,"additionalAvailable"> & {additionalScenes?:SmsScene[]};
  if(!data||!["aliyun","disabled"].includes(data.provider)||data.providerVerification!=="NOT_RUN"
    ||data.signName!==null&&(typeof data.signName!=="string"||data.signName.length>64)
    ||!Array.isArray(data.scenes)||data.scenes.length!==baseScenes.length
    ||data.additionalScenes!==undefined&&(!Array.isArray(data.additionalScenes)||data.additionalScenes.length!==additionalScenes.length))
    throw new AdminApiError(502,"SMS_CONFIGURATION_CONTRACT_REQUIRED");
  const seen=new Set<string>();
  for(const row of [...data.scenes,...(data.additionalScenes??[])]){
    if(!row||!Object.hasOwn(labels,row.scene)||seen.has(row.scene)||!["SCENE","RELATED","SHARED","NOT_CONFIGURED"].includes(row.source)
      ||row.source==="RELATED"&&row.scene!=="CHANGE_MOBILE"&&row.scene!=="FORGOT_PASSWORD"
      ||!["CONNECTED","NOT_CONNECTED"].includes(row.trigger)
      ||(row.source==="NOT_CONFIGURED"?row.templateCode!==null:typeof row.templateCode!=="string"||row.templateCode.length>128||!/^SMS_[A-Za-z0-9]+$/.test(row.templateCode)))throw new AdminApiError(502,"SMS_CONFIGURATION_CONTRACT_REQUIRED");
    seen.add(row.scene);
  }
  if(baseScenes.some(scene=>!data.scenes.some(row=>row.scene===scene))
    ||data.additionalScenes&&additionalScenes.some(scene=>!data.additionalScenes!.some(row=>row.scene===scene)))
    throw new AdminApiError(502,"SMS_CONFIGURATION_CONTRACT_REQUIRED");
  return {provider:data.provider,signName:data.signName,providerVerification:data.providerVerification,
    scenes:[...data.scenes,...(data.additionalScenes??[])],additionalAvailable:data.additionalScenes!==undefined};
}

function sourceLabel(row: SmsScene): string {
  if (row.source === "SCENE") return "场景专用";
  if (row.source === "RELATED") return row.scene === "CHANGE_MOBILE" ? "复用绑定手机模板" : "复用身份验证模板";
  if (row.source === "SHARED") return "共用验证码模板";
  return "";
}

export function SystemSmsConfigurationPanel({refreshNonce}:{refreshNonce:number}){
  const [open,setOpen]=useState(false),[retry,setRetry]=useState(0);
  const triggerRef=useRef<HTMLButtonElement>(null);
  const [state,setState]=useState<{data:SmsConfiguration|null;busy:boolean;error:string}>({data:null,busy:false,error:""});
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setState({data:null,busy:true,error:""});
    void adminRequest<unknown>("/system/sms",undefined,"GET",{},controller.signal).then(value=>{
      if(!controller.signal.aborted)setState({data:parseSmsConfiguration(value),busy:false,error:""});
    }).catch(error=>{if(!controller.signal.aborted)setState({data:null,busy:false,error:friendlyError(error)});});
    return()=>controller.abort();
  },[open,refreshNonce,retry]);
  const rowValue = state.busy && !state.data ? "正在读取配置…"
    : state.data ? `${state.data.provider === "aliyun" ? "阿里云短信" : "未开启"}${state.data.signName ? ` · 签名 ${state.data.signName}` : ""}`
    : state.error ? "读取失败" : "服务、签名与场景模板";
  return <section className="mt-6 max-w-5xl border-b border-border pb-5" aria-labelledby="system-sms-title">
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h2 id="system-sms-title" className="text-base font-semibold">短信配置</h2>
          <InfoTip label="短信配置说明" title="配置来源" body="密钥由部署环境管理。" /></div>
        <p className="mt-0.5 text-xs text-muted-foreground">{rowValue}</p>
      </div>
      <Button ref={triggerRef} type="button" variant="outline" aria-label="查看短信配置" onClick={()=>setOpen(true)}>查看</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent size="lg" finalFocus={triggerRef} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
      <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
        <DialogTitle>短信配置</DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed">服务与签名由部署环境维护；模板审核和短信送达需另行确认。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {state.busy && !state.data ? <div role="status" aria-label="正在读取短信配置"><span className="sr-only">正在读取短信配置…</span><div className="space-y-4"><div className="grid grid-cols-2 gap-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div><Skeleton className="h-64 w-full" /></div></div> : null}
        {state.error ? <StatusMessage error={state.error} /> : null}
        {state.data ? <>
          <dl className="grid grid-cols-2 gap-4 border-b border-border/60 pb-4 text-[13px]">
            <div><dt className="text-muted-foreground">服务</dt><dd className="mt-0.5 font-medium">{state.data.provider === "aliyun" ? "阿里云短信" : "未开启"}</dd></div>
            <div><dt className="text-muted-foreground">签名</dt><dd className="mt-0.5 font-medium">{state.data.signName ?? "未配置"}</dd></div>
          </dl>
          {state.data.provider === "disabled" ? <p role="status" className="text-[13px] text-amber-700 dark:text-amber-400">短信服务当前未开启；以下为业务接入状态。</p> : null}
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium">场景模板</h3>
            <div className="flex items-center justify-between px-3 text-xs text-muted-foreground"><span>场景与模板</span><span>业务接入</span></div>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
              {state.data.scenes.map(row=>{
                const source=sourceLabel(row);
                return <li key={row.scene} data-sms-scene className="flex items-start justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">{labels[row.scene]}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground"><span className="font-mono">{row.templateCode ?? "未配置"}</span>{source ? ` · ${source}` : ""}</p>
                  </div>
                  <Badge variant={row.trigger === "CONNECTED" ? "success" : "warning"}>{row.trigger === "CONNECTED" ? "已接入" : "待接入"}</Badge>
                </li>;
              })}
            </ul>
          </div>
          {!state.data.additionalAvailable ? <p className="text-[13px] text-muted-foreground">更换手机号、找回密码模板暂不可用。</p> : null}
        </> : null}
      </div>
      <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
        <Button type="button" variant="ghost" disabled={state.busy} onClick={()=>setRetry(value=>value+1)}>重新读取</Button>
        <Button type="button" variant="secondary" onClick={()=>setOpen(false)}>关闭</Button>
      </div>
    </DialogContent></Dialog>
  </section>;
}
