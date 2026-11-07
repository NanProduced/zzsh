const WINDOW_MS=72*60*60*1000;

/** Older completed/cancelled orders get a fresh window from the new Team's READY time. */
export function legacyTeamSendWindow(status:string,readyAt:Date|string|null,endedAt:Date|string|null,now=Date.now()){
  if(status!=="COMPLETED"&&status!=="CANCELLED")return {orderEndedAt:null,sendUntil:null,terminalSendAllowed:true};
  const ready=readyAt===null?NaN:new Date(readyAt).getTime(),end=endedAt===null?NaN:new Date(endedAt).getTime();
  if(!Number.isFinite(ready))return {orderEndedAt:null,sendUntil:null,terminalSendAllowed:false};
  const start=Number.isFinite(end)?Math.max(ready,end):ready,until=start+WINDOW_MS;
  return {orderEndedAt:Number.isFinite(end)?new Date(end).toISOString():null,sendUntil:new Date(until).toISOString(),terminalSendAllowed:now<until};
}
