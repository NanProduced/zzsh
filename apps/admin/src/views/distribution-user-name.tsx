import {EntityPreviewTrigger,UserProfilePreview} from '@/components/admin-preview';
import {adminRequest} from '../api';

const requestUserProfile=<T,>(path:string)=>adminRequest<T>(path);
export function distributionUserLabel(name:string|null|undefined,userId:string|null|undefined){const value=name?.trim();return value&&value!==userId?value:'未命名用户';}
export function DistributionUserName({userId,name,canOpen,canPreview=canOpen,onOpen,onOpenProfile,className=''}:{
 userId:string|null|undefined;name:string|null|undefined;canOpen:boolean;canPreview?:boolean;onOpen?:()=>void;onOpenProfile?:()=>void;className?:string;
}){
 const label=distributionUserLabel(name,userId),openable=Boolean(canOpen&&userId&&onOpen);
 const trigger=<button type="button" className={`text-left hover:underline disabled:cursor-default disabled:no-underline disabled:hover:no-underline ${className}`.trim()} disabled={!openable} onClick={event=>{event.stopPropagation();if(openable)onOpen?.();}}>{label}</button>;
 if(!userId)return <span className={className}>{label}</span>;
 if(!canPreview||!openable)return trigger;
 return <EntityPreviewTrigger trigger={trigger} touchLabel={`预览用户 ${label}`} content={<UserProfilePreview userId={userId} name={label} request={requestUserProfile} onOpenProfile={onOpenProfile??onOpen}/>}/>;
}
