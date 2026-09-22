import { YunxinServerApiClient, YunxinTransportError, type YunxinCreateAccountInput, type YunxinProfile, type YunxinServerApi } from "../src/im/yunxin-provider";

/** In-memory wire transport, exercised through the actual signed V2 adapter. */
export class OrderTeamTransport {
  readonly teams=new Map<string,{info:Record<string,any>;members:Record<string,any>[]} >();
  readonly creates:Record<string,any>[]=[];
  readonly adds:Record<string,any>[]=[];
  readonly notices:Record<string,any>[]=[];
  readonly calls:string[]=[];
  nextId=910000001;
  responseLoss=false;partial=false;
  rejectCode:number|undefined;
  beforeResponse?:()=>Promise<void>;
  beforeAddResponse?:()=>Promise<void>;
  addResponseLoss=false;
  noticeResponseLoss=false;
  beforeNoticeResponse?:()=>Promise<void>;
  rejectAddCode:number|undefined;
  rejectNoticeCode:number|undefined;
  tweak?:(team:{info:Record<string,any>;members:Record<string,any>[]})=>void;
  readonly client=new YunxinServerApiClient({appKey:"order-fixture",appSecret:"fixture-only",fetch:async(url,init)=>{
    const parsed=new URL(String(url));this.calls.push(`${init?.method} ${parsed.pathname}`);
    if(init?.method==="POST"&&parsed.pathname==="/im/v2.1/teams"){
      const body=JSON.parse(String(init.body));this.creates.push(body);
      if(this.rejectCode)return Response.json({code:this.rejectCode});
      const id=String(this.nextId++);
      const members=[body.owner_account_id,...body.invite_account_ids].map((account_id:string,index:number)=>({team_id:id,account_id,member_role:index===0?1:0,chat_banned:false}));
      const team={info:{team_id:id,team_type:1,owner_account_id:body.owner_account_id,name:body.name,members_limit:body.members_limit,member_count:members.length,server_extension:body.server_extension,configuration:{...body.configuration}},members};
      this.tweak?.(team);this.teams.set(id,team);await this.beforeResponse?.();
      if(this.responseLoss)throw new Error("simulated response loss");
      return Response.json({code:200,data:{team_info:{team_id:id,owner_account_id:body.owner_account_id},failed_list:this.partial?[{account_id:body.invite_account_ids[0]}]:[]}});
    }
    if(init?.method==="POST"&&parsed.pathname==="/im/v2/team_members"){
      const body=JSON.parse(String(init.body));this.adds.push(body);
      if(this.rejectAddCode)return Response.json({code:this.rejectAddCode});
      const id=String(body.team_id),team=this.teams.get(id);
      if(!team)return Response.json({code:108404});
      const failed=[];
      for(const accountId of body.invite_account_ids as string[]){
        if(team.members.some((member)=>member.account_id===accountId)){failed.push({account_id:accountId});continue;}
        team.members.push({team_id:id,account_id:accountId,member_role:0,chat_banned:false});
      }
      team.info.member_count=team.members.length;
      await this.beforeAddResponse?.();
      if(this.addResponseLoss)throw new Error("simulated add response loss");
      return Response.json({code:200,data:{failed_list:failed}});
    }
    if(init?.method==="POST"&&parsed.pathname.startsWith("/im/v2/conversations/")&&parsed.pathname.endsWith("/messages")){
      const body=JSON.parse(String(init.body));this.notices.push(body);
      if(this.rejectNoticeCode)return Response.json({code:this.rejectNoticeCode});
      const parts=decodeURIComponent(parsed.pathname.slice("/im/v2/conversations/".length,-"/messages".length)).split("|");
      const [sender,,teamId]=parts;
      await this.beforeNoticeResponse?.();
      if(this.noticeResponseLoss)throw new Error("simulated notice response loss");
      return Response.json({code:200,data:{message_client_id:`notice_${this.notices.length}`,sender_id:sender,conversation_type:2,
        receiver_id:teamId,create_time:Date.now(),message_type:body.message?.message_type}});
    }
    const id=parsed.pathname.split("/")[4]!,team=this.teams.get(id);
    if(!team)return Response.json({code:108404});
    if(parsed.pathname.endsWith("list_members"))return Response.json({code:200,data:{has_more:false,items:team.members}});
    return Response.json({code:200,data:{team_info:team.info}});
  }});
}

export function fakeIdentityAccounts(){
  const profiles=new Map<string,YunxinProfile>();let failOnce=false;let blockedRead=false;let creates=0;
  return { profiles,get creates(){return creates;},failNext(){failOnce=true;},
    api:{createAccount:async(input:YunxinCreateAccountInput)=>{
      creates++;const profile={accountId:input.accountId,extension:input.extension};profiles.set(input.accountId,profile);
      if(failOnce){failOnce=false;blockedRead=true;throw new YunxinTransportError("create-account");}
      return {accountId:input.accountId,token:"unused-fixture-token",profile};
    },getProfile:async(id:string)=>{if(blockedRead){blockedRead=false;throw new YunxinTransportError("get-profile");}const p=profiles.get(id);if(!p)throw new Error("identity absent");return p;}} as unknown as YunxinServerApi,
  };
}
