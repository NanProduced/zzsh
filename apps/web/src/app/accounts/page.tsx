import { AccountMarket } from "@/components/service-pages";
export default async function Page({searchParams}:{searchParams:Promise<{q?:string}>}){const p=await searchParams;return <AccountMarket query={typeof p.q==='string'?p.q.slice(0,120):''}/>;}
