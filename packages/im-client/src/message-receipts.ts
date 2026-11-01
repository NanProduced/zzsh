export type NimSentReceipt = {kind:"receipt";action:"sent"|"hidden";message:{messageClientId:string;messageServerId:string;conversationId:string;senderId:string;createTime:number;messageType:number}};
export type NimReceiptStatus = {pending:number;failed:boolean;persistent:boolean};
export const NIM_RECEIPT_PENDING = "消息已发送，平台登记待恢复；请勿重复发送原消息。";
export class NimReceiptActionError extends Error {
  readonly status:number;
  readonly unknown:boolean;
  constructor(message:string,status:number,unknown:boolean){super(message);this.name="NimReceiptActionError";this.status=status;this.unknown=unknown;}
}
type StorageLike=Pick<Storage,"length"|"key"|"getItem"|"setItem"|"removeItem">;
export function createNimReceiptReporter(options:{endpoint:string;scope:string;storage?:StorageLike;fetch?:typeof fetch;status?:(status:NimReceiptStatus)=>void}){
  const prefix=`zzsh.im.receipts.v1:${options.endpoint}:${options.scope}:`,pending=new Map<string,NimSentReceipt>(),unsaved=new Set<string>();
  let closed=false,running=false,failed=false,corrupt=false,timer:ReturnType<typeof setTimeout>|undefined;
  const request=options.fetch??globalThis.fetch.bind(globalThis);let storage=options.storage;
  try {storage??=typeof localStorage==="undefined"?undefined:localStorage;}catch{storage=undefined;}
  const valid=(value:unknown):value is NimSentReceipt=>{
    if(!value||typeof value!=="object")return false;
    const r=value as NimSentReceipt,m=r.message;
    return r.kind==="receipt"&&(r.action==="sent"||r.action==="hidden")&&Boolean(m)&&typeof m.messageClientId==="string"&&m.messageClientId.length>0&&m.messageClientId.length<=128&&typeof m.messageServerId==="string"&&/^[1-9][0-9]{0,19}$/.test(m.messageServerId)&&typeof m.conversationId==="string"&&m.conversationId.length<=256&&typeof m.senderId==="string"&&m.senderId.length<=32&&Number.isSafeInteger(m.createTime)&&m.createTime>0&&(r.action==="sent"?[0,1,2,3,6].includes(m.messageType):Number.isInteger(m.messageType)&&m.messageType>=0&&m.messageType<=100);
  };
  const receiptKey=(r:NimSentReceipt)=>prefix+`${r.action}:${r.message.messageClientId}:${r.message.messageServerId}`;
  const notify=()=>{if(!closed)options.status?.({pending:pending.size+(corrupt?1:0),failed:failed||corrupt,persistent:Boolean(storage)&&!unsaved.size&&!corrupt});};
  const save=(id:string,receipt:NimSentReceipt)=>{try{if(!storage)throw new Error("No receipt storage");storage.setItem(id,JSON.stringify(receipt));unsaved.delete(id);}catch{unsaved.add(id);}};
  const recover=(id:string,raw:string|null)=>{
    if(!raw)return;
    try{const receipt:unknown=JSON.parse(raw);if(!valid(receipt)||receiptKey(receipt)!==id)throw new Error("Invalid receipt recovery state");pending.set(id,receipt);}catch{corrupt=true;}
  };
  try{if(storage)for(let i=0;i<storage.length;i++){const id=storage.key(i);if(id?.startsWith(prefix))recover(id,storage.getItem(id));}}catch{corrupt=true;}
  const schedule=()=>{if(!closed&&!timer)timer=setTimeout(()=>{timer=undefined;void flush();},failed?5000:0);};
  async function flush():Promise<void>{
    if(closed||running||!pending.size){notify();return;}running=true;
    try{
      for(const [id,receipt] of pending){
        if(closed)break;save(id,receipt);
        const response=await request(options.endpoint,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(receipt)});
        if(!response.ok)throw new Error("Message registration pending");
        const result=await response.json() as {recorded?:unknown};if(result.recorded!==true)throw new Error("Message registration pending");
        pending.delete(id);unsaved.delete(id);try{storage?.removeItem(id);}catch{corrupt=true;}
        failed=false;notify();
      }
    }catch{failed=true;notify();}finally{running=false;if(!closed&&pending.size)schedule();}
  }
  const online=()=>{if(timer){clearTimeout(timer);timer=undefined;}void flush();};
  const changed=(event:StorageEvent)=>{if(!closed&&event.key?.startsWith(prefix)){if(event.newValue)recover(event.key,event.newValue);else pending.delete(event.key);notify();if(pending.size)schedule();}};
  if(typeof window!=="undefined"){window.addEventListener("online",online);window.addEventListener("storage",changed);}
  if(pending.size)schedule();
  notify();
  return {record(receipt:NimSentReceipt){if(!valid(receipt)){failed=true;corrupt=true;notify();return;}const id=receiptKey(receipt);pending.set(id,receipt);save(id,receipt);notify();if(!closed)schedule();},flush,
    async revoke(message:NimSentReceipt["message"]):Promise<void>{
      try{
        const response=await request(options.endpoint,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"revoke",message})});
        const body=await response.json() as {revoked?:boolean;outcome?:string;error?:{message?:string}};
        if(!response.ok||body.revoked!==true)throw new NimReceiptActionError(body.error?.message??"撤回结果未确认，请核对后处理。",response.status,body.outcome==="UNKNOWN"||response.status>=500);
      }catch(error){if(error instanceof NimReceiptActionError)throw error;throw new NimReceiptActionError("撤回结果未确认，请由平台核对，勿重复提交。",503,true);}
    },
    close(){closed=true;if(timer)clearTimeout(timer);if(typeof window!=="undefined"){window.removeEventListener("online",online);window.removeEventListener("storage",changed);}}};
}
