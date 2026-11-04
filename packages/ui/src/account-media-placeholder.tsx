import migrating from "../assets/account-media-migrating.png";
import unavailable from "../assets/account-media-unavailable.png";

type ImageAsset = string | { src: string };

export function AccountMediaPlaceholder({ state, className }: { state: "PENDING_IMPORT" | "UNAVAILABLE"; className?: string }) {
  const image = (state === "PENDING_IMPORT" ? migrating : unavailable) as ImageAsset;
  return <img className={className} src={typeof image === "string" ? image : image.src}
    alt={state === "PENDING_IMPORT" ? "图片正在迁移中，请稍后再来看看" : "暂无可展示的图片，请稍后再试"}
    width={1536} height={1024} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
}
