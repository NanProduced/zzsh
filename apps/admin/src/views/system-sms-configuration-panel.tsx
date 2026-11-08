import { useEffect, useState } from "react";
import { AdminApiError, adminRequest, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusMessage } from "../components/ui-elements";

const labels = { IDENTITY:"身份验证", REGISTER:"注册", LOGIN:"登录", BIND:"绑定手机", RENTAL_EXPIRY:"租期到期提醒", OWNER_ORDER_PAID:"号主出号提醒" } as const;
type Scene = keyof typeof labels;
type SmsConfiguration = { provider:"aliyun"|"disabled";signName:string|null;providerVerification:"NOT_RUN";
  scenes:Array<{scene:Scene;templateCode:string|null;source:"SCENE"|"SHARED"|"NOT_CONFIGURED";trigger:"CONNECTED"|"NOT_CONNECTED"}> };

export function parseSmsConfiguration(value:unknown):SmsConfiguration {
  const data=value as SmsConfiguration;
  if(!data||!["aliyun","disabled"].includes(data.provider)||data.providerVerification!=="NOT_RUN"
    ||data.signName!==null&&(typeof data.signName!=="string"||data.signName.length>64)
    ||!Array.isArray(data.scenes)||data.scenes.length!==Object.keys(labels).length)throw new AdminApiError(502,"SMS_CONFIGURATION_CONTRACT_REQUIRED");
  const seen=new Set<string>();
  for(const row of data.scenes){
    if(!row||!Object.hasOwn(labels,row.scene)||seen.has(row.scene)||!["SCENE","SHARED","NOT_CONFIGURED"].includes(row.source)
      ||!["CONNECTED","NOT_CONNECTED"].includes(row.trigger)
      ||(row.source==="NOT_CONFIGURED"?row.templateCode!==null:typeof row.templateCode!=="string"||row.templateCode.length>128||!/^SMS_[A-Za-z0-9]+$/.test(row.templateCode)))throw new AdminApiError(502,"SMS_CONFIGURATION_CONTRACT_REQUIRED");
    seen.add(row.scene);
  }
  return data;
}

export function SystemSmsConfigurationPanel({refreshNonce}:{refreshNonce:number}){
  const [open,setOpen]=useState(false),[retry,setRetry]=useState(0);
  const [state,setState]=useState<{data:SmsConfiguration|null;busy:boolean;error:string}>({data:null,busy:false,error:""});
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setState({data:null,busy:true,error:""});
    void adminRequest<unknown>("/system/sms",undefined,"GET",{},controller.signal).then(value=>{
      if(!controller.signal.aborted)setState({data:parseSmsConfiguration(value),busy:false,error:""});
    }).catch(error=>{if(!controller.signal.aborted)setState({data:null,busy:false,error:friendlyError(error)});});
    return()=>controller.abort();
  },[open,refreshNonce,retry]);
  return <section className="mt-6 max-w-5xl border-b border-border pb-5" aria-labelledby="system-sms-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="system-sms-title" className="text-base font-semibold">短信配置</h2><p className="mt-1 text-sm text-muted-foreground">查看各场景使用的短信模板，密钥由部署环境管理。</p></div>
      <Button type="button" variant="outline" disabled={state.busy} onClick={()=>open?setRetry(value=>value+1):setOpen(true)}>{open?"刷新短信配置":"查看短信配置"}</Button></div>
    {state.busy?<p className="mt-4 text-sm text-muted-foreground" role="status">正在读取短信配置…</p>:null}
    {state.error?<div className="mt-4"><StatusMessage error={state.error}/></div>:null}
    {state.data?<div className="mt-4 space-y-3"><p className="text-sm">服务：{state.data.provider==="aliyun"?"阿里云短信":"未开启"}　签名：{state.data.signName??"未配置"}</p>
      <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>场景</TableHead><TableHead>模板编号</TableHead><TableHead>配置来源</TableHead><TableHead>业务接入</TableHead></TableRow></TableHeader><TableBody>
        {state.data.scenes.map(row=><TableRow key={row.scene}><TableCell>{labels[row.scene]}</TableCell><TableCell>{row.templateCode??"未配置"}</TableCell><TableCell>{row.source==="SCENE"?"场景专用":row.source==="SHARED"?"共用验证码模板":"未配置"}</TableCell><TableCell>{row.trigger==="CONNECTED"?"已支持":"待接入"}</TableCell></TableRow>)}
      </TableBody></Table></div><p className="text-xs text-muted-foreground">配置已填写不代表模板已审核或短信已送达。</p></div>:null}
  </section>;
}
