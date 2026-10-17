interface BrandLogoProps { className?: string; height?: number; showText?: boolean; alt?: string; }
export function BrandLogo({ className = "", height = 42, alt = "洲洲商行" }: BrandLogoProps) {
  const width = height * 3;
  // 品牌 Logo 是固定尺寸资产：按 2x/3x 提供衍生图，避免为 114–162px 的呈现下载 2172px 原图。
  return <img src="/brand/zzsh-logo-variant-05@240.png" alt={alt} className={`brand-logo ${className}`}
    srcSet="/brand/zzsh-logo-variant-05@240.png 2x, /brand/zzsh-logo-variant-05@480.png 3x"
    width={width} height={height} style={{ height, width }} />;
}
