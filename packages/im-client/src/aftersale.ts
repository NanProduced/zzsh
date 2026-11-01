export type AftersaleRecord = {
  id:string;orderSource:"NATIVE";orderId:string;orderDisplayNo:string|null;requesterParty:"RENTER"|"OWNER";
  description:string;state:"PENDING"|"RESOLVED";result:string|null;version:number;
  handler:{id:string;name:string}|null;createdAt:string;updatedAt:string;resolvedAt:string|null;
};
export type AftersalePage={items:AftersaleRecord[];canSubmit:boolean;nextCursor:string|null};
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw Error("售后记录格式不正确，请刷新后重试。");return value as Record<string,unknown>;};
const id=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const date=(value:unknown):value is string=>typeof value==="string"&&Number.isFinite(Date.parse(value));
export function parseAftersaleRecord(value:unknown):AftersaleRecord {
  const r=object(value);
  if(!id(r.id)||!id(r.orderId)||r.orderSource!=="NATIVE"||!["RENTER","OWNER"].includes(String(r.requesterParty))||!["PENDING","RESOLVED"].includes(String(r.state))||typeof r.description!=="string"||!r.description.trim()||r.description.length>1000||!Number.isSafeInteger(r.version)||(r.version as number)<1||!date(r.createdAt)||!date(r.updatedAt)||!(r.orderDisplayNo===null||typeof r.orderDisplayNo==="string")||!(r.result===null||typeof r.result==="string"&&r.result.length<=1000)||!(r.resolvedAt===null||date(r.resolvedAt)))throw Error("售后记录格式不正确，请刷新后重试。");
  if(r.state==="RESOLVED"&&(!r.result||!r.resolvedAt)||r.state==="PENDING"&&(r.result!==null||r.resolvedAt!==null))throw Error("售后记录状态不完整，请刷新后重试。");
  let handler:AftersaleRecord["handler"]=null;
  if(r.handler!==null){const h=object(r.handler);if(!id(h.id)||typeof h.name!=="string"||!h.name.trim())throw Error("售后处理人格式不正确。");handler={id:h.id,name:h.name};}
  return {id:r.id,orderSource:"NATIVE",orderId:r.orderId,orderDisplayNo:r.orderDisplayNo as string|null,requesterParty:r.requesterParty as AftersaleRecord["requesterParty"],description:r.description,state:r.state as AftersaleRecord["state"],result:r.result as string|null,version:r.version as number,handler,createdAt:r.createdAt,updatedAt:r.updatedAt,resolvedAt:r.resolvedAt as string|null};
}
export function parseAftersalePage(value:unknown):AftersalePage {
  const r=object(value);if(!Array.isArray(r.items)||r.items.length>50||typeof r.canSubmit!=="boolean"||!(r.nextCursor===null||typeof r.nextCursor==="string"&&r.nextCursor.length>0&&r.nextCursor.length<=2048))throw Error("售后列表格式不正确，请刷新后重试。");
  return {items:r.items.map(parseAftersaleRecord),canSubmit:r.canSubmit,nextCursor:r.nextCursor as string|null};
}
export function aftersaleWaitingLabel(record:AftersaleRecord,now=Date.now()):string {
  if(record.state==="RESOLVED")return "已处理";
  const minutes=Math.max(0,Math.floor((now-Date.parse(record.createdAt))/60000));
  return minutes<60?`等待 ${minutes} 分钟`:`等待 ${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`;
}
