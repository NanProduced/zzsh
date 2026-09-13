export type PublishMode = "standard" | "fast";
export function publishMode(value: unknown): PublishMode { return value === "fast" ? "fast" : "standard"; }
export const serviceLinks = [
  { title: "租账号", description: "按游戏与资源挑选账号", href: "/accounts", icon: "rent" },
  { title: "上架出租", description: "填写资源与出租条件", href: "/publish", icon: "publish" },
  { title: "极速出租", description: "固定极速比例上架", href: "/publish?mode=fast", icon: "fast" },
] as const;
// Public presentation configuration only; no credentials or fabricated contact identities.
export type ContactChannel = { title: string; description: string; qrSrc?: string; handle?: string };
export const publicContacts: Record<"escort" | "follow" | "service", ContactChannel> = {
  escort: { title: "护航代肝", description: "通过微信群了解服务内容与安排。", },
  follow: { title: "关注我们", description: "获取洲洲商行的活动与资讯。", },
  service: { title: "联系客服", description: "咨询租赁问题，或联系订单客服。", },
};
