import { PublishForm } from "@/components/service-pages";
import { publishMode } from "@/lib/service-navigation";
export default async function Page({searchParams}:{searchParams:Promise<{mode?:string}>}){const p=await searchParams;return <PublishForm mode={publishMode(p.mode)}/>;}
