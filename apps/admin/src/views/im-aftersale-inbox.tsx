"use client";
import { useEffect, useRef, useState } from "react";
import { parseAftersalePage, parseAftersaleRecord, aftersaleWaitingLabel, type AftersaleRecord } from "@zzsh/im-client/aftersale";
import { adminRequest, AdminApiError, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Textarea } from "../components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";

export function AftersaleInbox({open,onOpenChange,scope,adminId,canHandle,canTakeover,onContact,onDirtyChange,getConnectionId}:{open:boolean;onOpenChange:(open:boolean)=>void;scope:string;adminId:string;canHandle:boolean;canTakeover:boolean;onContact:(record:AftersaleRecord,consultationId:string,threadId:string)=>void;onDirtyChange?:(dirty:boolean)=>void;getConnectionId?:()=>string}) {
  const [state,setState]=useState<"PENDING"|"RESOLVED">("PENDING"),[items,setItems]=useState<AftersaleRecord[]>([]),[selected,setSelected]=useState<AftersaleRecord|null>(null);
  const [cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[draft,setDraft]=useState("");
  const [confirmDiscard,setConfirmDiscard]=useState<(()=>void)|null>(null);
  const [refresh,setRefresh]=useState(0),operation=useRef("");const current=useRef(scope);current.current=scope;
  const flight=useRef(false);
  useEffect(()=>{current.current=scope;setConfirmDiscard(null);return()=>{current.current="";onDirtyChange?.(false);};},[scope,onDirtyChange]);
  useEffect(()=>{setConfirmDiscard(null);},[selected?.id]);
  useEffect(()=>{onDirtyChange?.(Boolean(draft)||busy);},[draft,busy,onDirtyChange]);
  const fail=(cause:unknown)=>{setError(friendlyError(cause));if(cause instanceof AdminApiError&&[401,403,404,423].includes(cause.status)){setItems([]);setSelected(null);setDraft("");operation.current="";}};
  useEffect(()=>{
    if(!open)return;let alive=true;setLoading(true);setError("");const expected=scope;
    void adminRequest<unknown>("/im/aftersales?state="+state).then(parseAftersalePage).then(page=>{
      if(!alive||current.current!==expected)return;setItems(page.items);setCursor(page.nextCursor);setSelected(old=>old?page.items.find(row=>row.id===old.id)??null:null);
    }).catch(cause=>{if(alive&&current.current===expected)fail(cause);}).finally(()=>{if(alive&&current.current===expected)setLoading(false);});
    return()=>{alive=false;};
  // Scope is bound to the authenticated operator; retries never carry a prior actor's draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,state,scope,refresh]);
  const requestLeave=(action:()=>void)=>{
    if(busy||flight.current)return;
    if(!draft.trim()){action();return;}
    const targetScope=scope,targetRecordId=selected?.id;
    setConfirmDiscard(()=>()=>{
      if(busy||flight.current||current.current!==targetScope||selected?.id!==targetRecordId)return;
      action();
    });
  };
  const close=(value:boolean)=>{
    if(!value){
      requestLeave(()=>{
        if(busy||flight.current)return;
        setDraft("");
        operation.current="";
        onOpenChange(false);
      });
      return;
    }
    onOpenChange(true);
  };
  const pick=(row:AftersaleRecord)=>{
    if(row.id===selected?.id)return;
    requestLeave(()=>{
      if(busy||flight.current)return;
      setSelected(row);
      setDraft("");
      setNotice("");
      setError("");
      operation.current="";
    });
  };
  const update=(record:AftersaleRecord)=>{setSelected(record);setItems(old=>old.map(row=>row.id===record.id?record:row));};
  async function act(action:"claim"|"contact"|"resolve") {
    if(!selected||flight.current||busy||!canHandle)return;const record=selected,expected=scope;flight.current=true;
    setBusy(true);setError("");setNotice("");
    if(action==="resolve")operation.current ||= crypto.randomUUID().replaceAll("-","");
    try{
      const body=action==="claim"?{version:record.version}:action==="contact"?{}:{version:record.version,result:draft,operationId:operation.current};
      const response=await adminRequest<{record:unknown;consultation?:{id?:unknown;threadId?:unknown}}>(`/im/aftersales/${encodeURIComponent(record.id)}/${action}`,body,"POST",action==="contact"&&getConnectionId?{"x-zzsh-connection-id":getConnectionId()}:{});
      const next=parseAftersaleRecord(response.record);if(current.current!==expected)return;update(next);
      if(action==="resolve"){setDraft("");operation.current="";setConfirmDiscard(null);setItems(old=>old.filter(row=>row.id!==record.id));setNotice("已标记为已处理。");}
      else if(action==="claim")setNotice("已由你跟进，可以通过现有客服咨询联系用户。");
      else{
        const c=response.consultation;if(typeof c?.id!=="string"||typeof c.threadId!=="string"||!c.id||!c.threadId)throw Error("Contact response incomplete");
        setDraft("");operation.current="";setConfirmDiscard(null);onOpenChange(false);onContact(next,c.id,c.threadId);
      }
    }catch(cause){if(current.current===expected)fail(cause);}
    finally{if(current.current===expected){setBusy(false);flight.current=false;}}
  }
  async function more(){if(!cursor||busy||flight.current)return;const expected=scope;setBusy(true);try{const page=parseAftersalePage(await adminRequest("/im/aftersales?"+new URLSearchParams({state,cursor})));if(current.current!==expected)return;setItems(old=>[...old,...page.items.filter(row=>!old.some(r=>r.id===row.id))]);setCursor(page.nextCursor);}catch(cause){if(current.current===expected)fail(cause);}finally{if(current.current===expected)setBusy(false);}}
  const mine=selected?.handler?.id===adminId;
  return <Sheet open={open} onOpenChange={close}><SheetContent className="w-full overflow-y-auto sm:max-w-3xl"><SheetHeader><SheetTitle>售后记录</SheetTitle><SheetDescription>查看和跟进结算后的订单问题。</SheetDescription></SheetHeader>
    <div className="grid gap-4 p-4"><div className="flex flex-wrap gap-2" role="group" aria-label="售后状态">{(["PENDING","RESOLVED"] as const).map(value=><Button key={value} variant={state===value?"default":"outline"} disabled={busy||flight.current} onClick={()=>{requestLeave(()=>{setDraft("");setSelected(null);operation.current="";setState(value);});}}>{value==="PENDING"?"待处理":"已处理"}</Button>)}<Button variant="outline" disabled={busy||flight.current||loading} onClick={()=>setRefresh(value=>value+1)}>刷新记录</Button></div>
      {confirmDiscard ? (
        <div className="flex items-center justify-between rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
          <span>有未提交的处理说明，是否放弃？</span>
          <div className="flex gap-2">
            <Button size="xs" variant="destructive" disabled={busy||flight.current} onClick={() => {
              if (busy || flight.current) return;
              const cb = confirmDiscard;
              setConfirmDiscard(null);
              cb();
            }}>确认放弃</Button>
            <Button size="xs" variant="outline" disabled={busy||flight.current} onClick={() => setConfirmDiscard(null)}>取消</Button>
          </div>
        </div>
      ) : null}
      {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}{notice?<p role="status" className="text-sm">{notice}</p>:null}
      {loading?<Skeleton className="h-24 w-full"/>:!items.length?<p className="text-sm text-muted-foreground">当前范围暂无售后记录。</p>:<div className="grid gap-2" aria-label="售后记录列表">{items.map(row=><Button key={row.id} variant={selected?.id===row.id?"secondary":"ghost"} className="h-auto justify-start whitespace-normal text-left" disabled={busy} onClick={()=>pick(row)}><span className="min-w-0 break-all">订单 {row.orderDisplayNo??"—"} · {row.requesterParty==="RENTER"?"租客":"号主"} · {aftersaleWaitingLabel(row)}<span className="block text-xs text-muted-foreground">{row.id} · {row.handler?.name??"待领取"}</span></span></Button>)}</div>}
      {cursor?<Button variant="outline" disabled={busy||loading} onClick={()=>void more()}>加载更早记录</Button>:null}
      {selected?<section className="grid gap-3 border-t pt-4" aria-labelledby="aftersale-selected-title"><h3 id="aftersale-selected-title" className="font-semibold">订单 {selected.orderDisplayNo??"—"} 的售后问题</h3><p className="break-all text-xs text-muted-foreground">编号：{selected.id}</p><p className="whitespace-pre-wrap break-words text-sm">{selected.description}</p><p className="text-sm text-muted-foreground">{selected.handler?`处理人：${selected.handler.name}`:"待客服领取"} · 提交于 {new Date(selected.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>
        {selected.state==="RESOLVED"?<><p className="whitespace-pre-wrap break-words text-sm">处理结果：{selected.result}</p>{draft?<Field label="未提交的处理说明"><Textarea readOnly value={draft}/></Field>:null}</>:<>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!canHandle||busy||mine||Boolean(selected.handler&&!canTakeover)} onClick={()=>void act("claim")}>{mine?"由你跟进":"领取"}</Button><Button disabled={!canHandle||busy||Boolean(selected.handler&&!mine&&!canTakeover)} onClick={()=>void act("contact")}>{selected.handler&&!mine?"接管并联系":"联系用户"}</Button></div>
          {mine?<><Field label="处理结果" hint="最多1000字。"><Textarea rows={4} value={draft} maxLength={1000} disabled={busy} onChange={event=>{setDraft(event.target.value);operation.current="";}}/></Field><Button disabled={busy||!draft.trim()} onClick={()=>void act("resolve")}>{busy?"正在保存…":"保存并标记已处理"}</Button></>:null}
        </>}
      </section>:null}
    </div>
  </SheetContent></Sheet>;
}
