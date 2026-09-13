import { AccountWorkspace } from "@/components/service-pages";
export default async function Page({searchParams}:{searchParams:Promise<{view?:string}>}){const p=await searchParams;return <AccountWorkspace view={typeof p.view==='string'?p.view:'rentals'}/>;}
