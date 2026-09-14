import { PublishForm } from "@/components/service-pages";
import { publishMode } from "@/lib/service-navigation";
export default async function Page({searchParams}:{searchParams:Promise<{mode?:string;accountId?:string;edit?:string}>}){const p=await searchParams;return <PublishForm mode={publishMode(p.mode)} accountId={typeof p.accountId==='string'?p.accountId:undefined} editRequested={p.edit==='1'}/>;}
